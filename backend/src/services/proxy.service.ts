import { ProxyInput } from '../adapters/base.adapter.js';
import { GeminiAdapter } from '../adapters/gemini.adapter.js';
import { ImagenAdapter } from '../adapters/imagen.adapter.js';
import { OpenAIAdapter } from '../adapters/openai.adapter.js';
import { CustomAdapter } from '../adapters/custom.adapter.js';
import { getActiveProviderByName } from './provider.service.js';
import { selectKey } from './key.service.js';
import { logUsage, logUsageAggregateOnly } from './usage.service.js';
import { finalizeRateLimitReservation, releaseRateLimitReservation, triggerCooldown } from '../lib/rate-limiter.js';
import type { Provider } from './provider.service.js';
import { TTLCache } from '../lib/cache.js';
import { env } from '../config/env.js';
import { getImageParts, getImageUrlParts, getTextParts } from '../adapters/base.adapter.js';
import { lookup } from 'dns/promises';
import { isIP } from 'net';

export const activeProviderCache = new TTLCache<Provider | null>(5 * 60 * 1000);
const activeProviderInFlight = new Map<string, Promise<Provider | null>>();
const MAX_REMOTE_IMAGE_BYTES = 10 * 1024 * 1024;
const REMOTE_IMAGE_FETCH_TIMEOUT_MS = 10_000;
const ALLOWED_REMOTE_IMAGE_MIME_TYPES = new Set([
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
]);

export function invalidateActiveProviderResolverCache(): void {
    activeProviderCache.invalidate();
    activeProviderInFlight.clear();
}

const staticAdapters: Record<string, GeminiAdapter | ImagenAdapter | OpenAIAdapter> = {
    'google-gemini': new GeminiAdapter(),
    'google-imagen': new ImagenAdapter(),
    'openai': new OpenAIAdapter(),
};

function getAdapter(provider: Provider) {
    if (provider.type === 'custom') {
        if (!provider.baseUrl) throw new Error('Custom provider requires a baseUrl');
        return new CustomAdapter(provider.baseUrl);
    }
    return staticAdapters[provider.type] ?? null;
}

/**
 * Infer the provider name from the model string if not explicitly provided.
 */
function inferProvider(model: string): string | null {
    const lower = model.toLowerCase();
    if (lower.includes('gemini')) return 'google-gemini';
    if (lower.includes('imagen')) return 'google-imagen';
    if (lower.includes('gpt') || lower.includes('o1') || lower.includes('o3') || lower.includes('o4')) return 'openai';
    return null;
}

function inferModelCapabilities(model: string, providerType: string): {
    inputModalities: Array<'TEXT' | 'IMAGE'>;
    outputModalities: Array<'TEXT' | 'IMAGE'>;
} {
    if (providerType === 'google-imagen') {
        return {
            inputModalities: ['TEXT'],
            outputModalities: ['IMAGE'],
        };
    }

    if (providerType === 'google-gemini' && model.toLowerCase().includes('image')) {
        return {
            inputModalities: ['TEXT', 'IMAGE'],
            outputModalities: ['TEXT', 'IMAGE'],
        };
    }

    return {
        inputModalities: ['TEXT'],
        outputModalities: ['TEXT'],
    };
}

function getRequestedOutputModalities(input: ProxyInput, providerType: string): Array<'TEXT' | 'IMAGE'> {
    if (input.options?.responseModalities && input.options.responseModalities.length > 0) {
        return input.options.responseModalities;
    }

    if (providerType === 'google-imagen') {
        return ['IMAGE'];
    }

    if (providerType === 'google-gemini' && input.model.toLowerCase().includes('image')) {
        return ['IMAGE'];
    }

    return ['TEXT'];
}

function isPrivateIpAddress(address: string): boolean {
    const version = isIP(address);
    if (version === 4) {
        const [a, b] = address.split('.').map((part) => Number(part));
        if (a === 10 || a === 127 || a === 0) return true;
        if (a === 169 && b === 254) return true;
        if (a === 172 && b >= 16 && b <= 31) return true;
        if (a === 192 && b === 168) return true;
        if (a >= 224) return true;
        return false;
    }

    if (version === 6) {
        const normalized = address.toLowerCase();
        return normalized === '::1'
            || normalized.startsWith('fc')
            || normalized.startsWith('fd')
            || normalized.startsWith('fe8')
            || normalized.startsWith('fe9')
            || normalized.startsWith('fea')
            || normalized.startsWith('feb');
    }

    return false;
}

function isPrivateHostname(hostname: string): boolean {
    const normalized = hostname.toLowerCase();
    return normalized === 'localhost'
        || normalized === '127.0.0.1'
        || normalized === '::1'
        || normalized === '0.0.0.0'
        || normalized === 'host.docker.internal'
        || normalized.endsWith('.local')
        || normalized.endsWith('.internal');
}

async function assertSafeRemoteImageUrl(rawUrl: string): Promise<URL> {
    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        throw new Error('image_url must be a valid URL');
    }

    if (!['https:', 'http:'].includes(parsed.protocol)) {
        throw new Error('image_url must use http or https');
    }

    if (parsed.username || parsed.password) {
        throw new Error('image_url must not embed credentials');
    }

    if (isPrivateHostname(parsed.hostname)) {
        throw new Error('image_url must not target localhost or private hostnames');
    }

    if (isPrivateIpAddress(parsed.hostname)) {
        throw new Error('image_url must not target private IP ranges');
    }

    const resolved = await lookup(parsed.hostname, { all: true });
    if (resolved.some((entry) => isPrivateIpAddress(entry.address))) {
        throw new Error('image_url must not resolve to private IP ranges');
    }

    return parsed;
}

async function fetchRemoteImageAsPart(url: string): Promise<{ type: 'image'; mimeType: string; data: string }> {
    const parsed = await assertSafeRemoteImageUrl(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REMOTE_IMAGE_FETCH_TIMEOUT_MS);

    try {
        const response = await fetch(parsed, {
            method: 'GET',
            redirect: 'follow',
            signal: controller.signal,
            headers: {
                'User-Agent': 'ApiKeyManager/1.0',
                'Accept': 'image/*',
            },
        });

        if (!response.ok) {
            throw new Error(`failed to fetch image_url (${response.status})`);
        }

        const contentTypeHeader = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
        if (!contentTypeHeader || !ALLOWED_REMOTE_IMAGE_MIME_TYPES.has(contentTypeHeader)) {
            throw new Error('image_url must return one of: image/jpeg, image/png, image/webp, image/gif');
        }

        const contentLengthHeader = response.headers.get('content-length');
        if (contentLengthHeader) {
            const contentLength = Number(contentLengthHeader);
            if (Number.isFinite(contentLength) && contentLength > MAX_REMOTE_IMAGE_BYTES) {
                throw new Error(`image_url exceeds maximum size of ${MAX_REMOTE_IMAGE_BYTES} bytes`);
            }
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.byteLength === 0) {
            throw new Error('image_url returned an empty image');
        }
        if (buffer.byteLength > MAX_REMOTE_IMAGE_BYTES) {
            throw new Error(`image_url exceeds maximum size of ${MAX_REMOTE_IMAGE_BYTES} bytes`);
        }

        return {
            type: 'image',
            mimeType: contentTypeHeader,
            data: buffer.toString('base64'),
        };
    } catch (error) {
        if ((error as Error).name === 'AbortError') {
            throw new Error('image_url fetch timed out');
        }
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

async function resolveImageUrlInputs(input: ProxyInput): Promise<ProxyInput> {
    if (getImageUrlParts(input).length === 0) {
        return input;
    }

    const resolvedInput = await Promise.all(input.input.map(async (part) => {
        if (part.type !== 'image_url') {
            return part;
        }
        return fetchRemoteImageAsPart(part.url);
    }));

    return {
        ...input,
        input: resolvedInput,
    };
}

function extractProviderErrorMessage(rawBody: any): string {
    if (typeof rawBody?.error?.message === 'string' && rawBody.error.message.trim()) {
        return rawBody.error.message.trim();
    }

    if (typeof rawBody?.message === 'string' && rawBody.message.trim()) {
        return rawBody.message.trim();
    }

    if (typeof rawBody?.error === 'string' && rawBody.error.trim()) {
        return rawBody.error.trim();
    }

    return 'Provider returned an error';
}

function truncateForClient(value: string, maxLength = 300): string {
    return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function sanitizeProviderError(rawBody: any, statusText?: string): { error: string; message: string } {
    const message = truncateForClient(extractProviderErrorMessage(rawBody) || statusText || 'Provider returned an error');

    if (typeof rawBody?.error === 'string' && rawBody.error.trim()) {
        return {
            error: truncateForClient(rawBody.error.trim()),
            message,
        };
    }

    if (typeof rawBody?.error?.type === 'string' && rawBody.error.type.trim()) {
        return {
            error: truncateForClient(rawBody.error.type.trim()),
            message,
        };
    }

    if (statusText && statusText.trim()) {
        return {
            error: truncateForClient(statusText.trim()),
            message,
        };
    }

    return {
        error: 'ProviderError',
        message,
    };
}

async function parseProviderResponse(response: Response): Promise<{ rawBody: any; isJson: boolean }> {
    const rawText = await response.text();
    if (!rawText) {
        return { rawBody: null, isJson: false };
    }

    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    const shouldParseJson = contentType.includes('application/json') || contentType.includes('+json') || rawText.trim().startsWith('{') || rawText.trim().startsWith('[');
    if (!shouldParseJson) {
        return { rawBody: rawText, isJson: false };
    }

    try {
        return { rawBody: JSON.parse(rawText), isJson: true };
    } catch {
        return { rawBody: rawText, isJson: false };
    }
}

export async function handleProxy(
    input: ProxyInput,
    clientId: string
): Promise<{
    statusCode: number;
    body: any;
}> {
    const start = Date.now();
    let resolvedInput: ProxyInput;

    try {
        resolvedInput = await resolveImageUrlInputs(input);
    } catch (error) {
        return {
            statusCode: 400,
            body: {
                status: 'error',
                message: error instanceof Error ? error.message : 'Failed to resolve image_url input',
            },
        };
    }

    // 1. Resolve provider
    const providerType = resolvedInput.provider || inferProvider(resolvedInput.model);
    if (!providerType) {
        return {
            statusCode: 400,
            body: { status: 'error', message: 'Cannot infer provider from model. Specify "provider" field.' },
        };
    }

    // Find a provider document matching this type
    const providerSnapshot = await findActiveProvider(providerType);
    if (!providerSnapshot) {
        return {
            statusCode: 404,
            body: { status: 'error', message: `No active provider found for type "${providerType}"` },
        };
    }

    // Check model support
    if (
        providerSnapshot.supportedModels &&
        providerSnapshot.supportedModels.length > 0 &&
        !providerSnapshot.supportedModels.includes(resolvedInput.model)
    ) {
        return {
            statusCode: 400,
            body: {
                status: 'error',
                message: `Model "${resolvedInput.model}" is not supported by provider "${providerSnapshot.name}".Supported: ${providerSnapshot.supportedModels.join(', ')} `,
            },
        };
    }

    const { getModelByNameAndProvider } = await import('./model.service.js');
    const configuredModel = await getModelByNameAndProvider(resolvedInput.model, providerSnapshot.id!);
    if (configuredModel?.isFrozen) {
        return {
            statusCode: 403,
            body: {
                status: 'error',
                message: `Model "${resolvedInput.model}" is currently frozen`,
            },
        };
    }
    const capabilities = configuredModel
        ? {
            inputModalities: configuredModel.inputModalities ?? inferModelCapabilities(resolvedInput.model, providerSnapshot.type).inputModalities,
            outputModalities: configuredModel.outputModalities ?? inferModelCapabilities(resolvedInput.model, providerSnapshot.type).outputModalities,
        }
        : inferModelCapabilities(resolvedInput.model, providerSnapshot.type);

    const requestedInputModalities = Array.from(new Set([
        ...(getTextParts(resolvedInput).some((part) => part.text.trim()) ? ['TEXT' as const] : []),
        ...(getImageParts(resolvedInput).length > 0 ? ['IMAGE' as const] : []),
    ]));
    const requestedOutputModalities = getRequestedOutputModalities(resolvedInput, providerSnapshot.type);

    const invalidInputModality = requestedInputModalities.find((modality) => !capabilities.inputModalities.includes(modality));
    if (invalidInputModality) {
        return {
            statusCode: 400,
            body: {
                status: 'error',
                message: `Model "${resolvedInput.model}" does not support ${invalidInputModality.toLowerCase()} input`,
            },
        };
    }

    const invalidOutputModality = requestedOutputModalities.find((modality) => !capabilities.outputModalities.includes(modality));
    if (invalidOutputModality) {
        return {
            statusCode: 400,
            body: {
                status: 'error',
                message: `Model "${resolvedInput.model}" does not support ${invalidOutputModality.toLowerCase()} output`,
            },
        };
    }

    // 2. Select API key (model-aware: checks keyModelRules for authorisation + rate limits)
    const keyResult = await selectKey(providerSnapshot.id!, resolvedInput.model, resolvedInput.options?.maxTokens ?? 0);
    if (!keyResult || 'rejections' in keyResult) {
        const rejections = keyResult && 'rejections' in keyResult ? keyResult.rejections : [];
        const details = rejections.length > 0
            ? rejections.map((r) => `  • ${r.keyLabel}: ${r.reason} `).join('\n')
            : 'No active keys found for this provider.';
        const statusCode = keyResult && 'rejections' in keyResult && keyResult.failureKind === 'model_not_authorised'
            ? 403
            : 429;

        await logUsageAggregateOnly({
            apiKeyId: '',
            clientId,
            model: resolvedInput.model,
            providerName: providerSnapshot.name,
            status: 'failed',
            statusCode,
            latencyMs: Date.now() - start,
            createdAt: new Date(),
        });

        return {
            statusCode,
            body: {
                status: 'error',
                message: 'All API keys exhausted or model not authorised on any key.',
                details,
                rejections,
            },
        };
    }

    const { keyDoc, decryptedKey, rulesUsed, reservation } = keyResult;

    // 3. Get adapter and build request
    const adapter = getAdapter(providerSnapshot);
    if (!adapter) {
        return {
            statusCode: 500,
            body: { status: 'error', message: `No adapter for provider type "${providerSnapshot.type}"` },
        };
    }

    let adapterReq;
    try {
        adapterReq = adapter.buildRequest(resolvedInput, decryptedKey);
    } catch (error: any) {
        await releaseRateLimitReservation(reservation);
        return {
            statusCode: 400,
            body: {
                status: 'error',
                message: error?.message ?? 'Invalid request for the selected provider',
            },
        };
    }

    // 4. Forward request to provider
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), env.PROVIDER_REQUEST_TIMEOUT_MS);

    try {
        const response = await fetch(adapterReq.url, {
            method: 'POST',
            headers: adapterReq.headers,
            body: JSON.stringify(adapterReq.body),
            signal: controller.signal,
        });

        const latencyMs = Date.now() - start;
        const { rawBody, isJson } = await parseProviderResponse(response);

        if (!response.ok) {
            // Log failed usage
            await logUsage({
                apiKeyId: keyDoc.id!,
                clientId,
                model: resolvedInput.model,
                providerName: providerSnapshot.name,
                status: 'failed',
                statusCode: response.status,
                latencyMs,
                createdAt: new Date(),
            });

            // Trigger cooldown on error
            if (rulesUsed.cooldownSeconds) {
                await triggerCooldown(keyDoc.id!, rulesUsed.cooldownSeconds);
            }
            await releaseRateLimitReservation(reservation);

            return {
                statusCode: response.status,
                body: {
                    status: 'error',
                    message: extractProviderErrorMessage(rawBody),
                    providerError: sanitizeProviderError(rawBody, response.statusText),
                },
            };
        }

        if (!isJson && providerSnapshot.type !== 'custom') {
            await logUsage({
                apiKeyId: keyDoc.id!,
                clientId,
                model: resolvedInput.model,
                providerName: providerSnapshot.name,
                status: 'failed',
                statusCode: 502,
                latencyMs,
                createdAt: new Date(),
            });
            await releaseRateLimitReservation(reservation);

            return {
                statusCode: 502,
                body: {
                    status: 'error',
                    message: 'Provider returned an invalid response format',
                },
            };
        }

        // 5. Parse response
        let parsed;
        try {
            parsed = adapter.parseResponse(rawBody);
        } catch {
            await logUsage({
                apiKeyId: keyDoc.id!,
                clientId,
                model: resolvedInput.model,
                providerName: providerSnapshot.name,
                status: 'failed',
                statusCode: 502,
                latencyMs,
                createdAt: new Date(),
            });
            await releaseRateLimitReservation(reservation);

            return {
                statusCode: 502,
                body: {
                    status: 'error',
                    message: 'Provider returned an invalid response format',
                },
            };
        }

        const totalTokens = parsed.usage
            ? parsed.usage.promptTokens + parsed.usage.completionTokens
            : 0;
        await finalizeRateLimitReservation(reservation, rulesUsed, totalTokens);

        // 7. Log success
        await logUsage({
            apiKeyId: keyDoc.id!,
            clientId,
            model: resolvedInput.model,
            providerName: providerSnapshot.name,
            status: 'success',
            statusCode: 200,
            latencyMs,
            promptTokens: parsed.usage?.promptTokens,
            completionTokens: parsed.usage?.completionTokens,
            createdAt: new Date(),
        });

        // 8. Return standardized response
        return {
            statusCode: 200,
            body: {
                status: 'success',
                data: {
                    provider: providerSnapshot.name,
                    model: resolvedInput.model,
                    response: parsed.response,
                    outputs: parsed.outputs ?? null,
                    usage: parsed.usage ?? null,
                },
                meta: {
                    latencyMs,
                    keyLabel: keyDoc.label,
                },
            },
        };
    } catch (err: any) {
        const latencyMs = Date.now() - start;
        const isTimeout = err?.name === 'AbortError';
        const statusCode = isTimeout ? 504 : 502;
        const message = isTimeout ? 'Provider request timed out' : (err.message ?? 'Upstream provider request failed');

        await logUsage({
            apiKeyId: keyDoc.id!,
            clientId,
            model: resolvedInput.model,
            providerName: providerSnapshot.name,
            status: 'failed',
            statusCode,
            latencyMs,
            createdAt: new Date(),
        });
        await releaseRateLimitReservation(reservation);

        return {
            statusCode,
            body: { status: 'error', message },
        };
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Find an active provider by type. Searches by `type` field.
 */
async function findActiveProvider(providerType: string): Promise<Provider | null> {
    const cached = activeProviderCache.get(providerType);
    if (cached !== undefined) return cached;

    const pending = activeProviderInFlight.get(providerType);
    if (pending) {
        return pending;
    }

    const loadProvider = (async () => {
        // First try matching by type
        const { db } = await import('../lib/firebase.js');
        const snapshot = await db
            .collection('providers')
            .where('type', '==', providerType)
            .where('isActive', '==', true)
            .limit(1)
            .get();

        let result: Provider | null = null;
        if (!snapshot.empty) {
            const doc = snapshot.docs[0];
            result = { id: doc.id, ...doc.data() } as Provider;
        } else {
            // Also try matching by name (user might pass provider name)
            result = await getActiveProviderByName(providerType);
        }

        activeProviderCache.set(providerType, result);
        return result;
    })().finally(() => {
        activeProviderInFlight.delete(providerType);
    });

    activeProviderInFlight.set(providerType, loadProvider);
    return loadProvider;
}
