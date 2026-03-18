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

export const activeProviderCache = new TTLCache<Provider | null>(5 * 60 * 1000);
const activeProviderInFlight = new Map<string, Promise<Provider | null>>();

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

    // 1. Resolve provider
    const providerType = input.provider || inferProvider(input.model);
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
        !providerSnapshot.supportedModels.includes(input.model)
    ) {
        return {
            statusCode: 400,
            body: {
                status: 'error',
                message: `Model "${input.model}" is not supported by provider "${providerSnapshot.name}".Supported: ${providerSnapshot.supportedModels.join(', ')} `,
            },
        };
    }

    // 2. Select API key (model-aware: checks keyModelRules for authorisation + rate limits)
    const keyResult = await selectKey(providerSnapshot.id!, input.model, input.options?.maxTokens ?? 0);
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
            model: input.model,
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

    const adapterReq = adapter.buildRequest(input, decryptedKey);

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
                model: input.model,
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
                model: input.model,
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
                model: input.model,
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
            model: input.model,
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
                    model: input.model,
                    response: parsed.response,
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
            model: input.model,
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
