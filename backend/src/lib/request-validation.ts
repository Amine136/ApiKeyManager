import { lookup } from 'dns/promises';
import { isIP } from 'net';
import type { ProxyInput } from '../adapters/base.adapter.js';
import { env } from '../config/env.js';
import type { ApiKeyRules } from '../services/key.service.js';
import type { Provider, ProviderType } from '../services/provider.service.js';

type PlainObject = Record<string, unknown>;

const RATE_RULE_LIMITS: Record<keyof ApiKeyRules, number> = {
    maxRequestsPerMinute: 1_000_000,
    maxRequestsPerHour: 10_000_000,
    maxRequestsPerDay: 100_000_000,
    maxTokensPerMinute: 100_000_000,
    maxTokensPerDay: 1_000_000_000,
    cooldownSeconds: 86_400,
};

const PRIVATE_HOST_PATTERNS = new Set([
    'localhost',
    '127.0.0.1',
    '::1',
    '0.0.0.0',
    'host.docker.internal',
]);

export class RequestValidationError extends Error {
    statusCode: number;

    constructor(message: string, statusCode = 400) {
        super(message);
        this.name = 'RequestValidationError';
        this.statusCode = statusCode;
    }
}

function asObject(value: unknown, label: string): PlainObject {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new RequestValidationError(`${label} must be an object`);
    }
    return value as PlainObject;
}

function assertAllowedKeys(value: PlainObject, allowedKeys: string[], label: string): void {
    const unknown = Object.keys(value).filter((key) => !allowedKeys.includes(key));
    if (unknown.length > 0) {
        throw new RequestValidationError(`${label} contains unsupported fields: ${unknown.join(', ')}`);
    }
}

function readRequiredString(
    value: PlainObject,
    key: string,
    options?: { maxLength?: number; trim?: boolean; label?: string }
): string {
    const raw = value[key];
    if (typeof raw !== 'string') {
        throw new RequestValidationError(`${options?.label ?? key} is required`);
    }

    const result = options?.trim === false ? raw : raw.trim();
    if (!result) {
        throw new RequestValidationError(`${options?.label ?? key} is required`);
    }
    if (options?.maxLength && result.length > options.maxLength) {
        throw new RequestValidationError(`${options?.label ?? key} exceeds maximum length of ${options.maxLength}`);
    }
    return result;
}

function readOptionalString(
    value: PlainObject,
    key: string,
    options?: { maxLength?: number; trim?: boolean; label?: string }
): string | undefined {
    const raw = value[key];
    if (raw === undefined) return undefined;
    if (typeof raw !== 'string') {
        throw new RequestValidationError(`${options?.label ?? key} must be a string`);
    }

    const result = options?.trim === false ? raw : raw.trim();
    if (!result) {
        throw new RequestValidationError(`${options?.label ?? key} must not be empty`);
    }
    if (options?.maxLength && result.length > options.maxLength) {
        throw new RequestValidationError(`${options?.label ?? key} exceeds maximum length of ${options.maxLength}`);
    }
    return result;
}

function readOptionalBoolean(value: PlainObject, key: string): boolean | undefined {
    const raw = value[key];
    if (raw === undefined) return undefined;
    if (typeof raw !== 'boolean') {
        throw new RequestValidationError(`${key} must be a boolean`);
    }
    return raw;
}

function readOptionalDate(value: PlainObject, key: string, options?: { label?: string; allowNull?: boolean }): Date | null | undefined {
    const raw = value[key];
    if (raw === undefined) return undefined;
    if (raw === null) {
        if (options?.allowNull) return null;
        throw new RequestValidationError(`${options?.label ?? key} must be a valid ISO date string`);
    }
    if (typeof raw !== 'string') {
        throw new RequestValidationError(`${options?.label ?? key} must be a valid ISO date string`);
    }

    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
        throw new RequestValidationError(`${options?.label ?? key} must be a valid ISO date string`);
    }
    return parsed;
}

function readPositiveInteger(
    value: PlainObject,
    key: string,
    options?: { max?: number; required?: boolean; label?: string }
): number | undefined {
    const raw = value[key];
    if (raw === undefined) {
        if (options?.required) {
            throw new RequestValidationError(`${options?.label ?? key} is required`);
        }
        return undefined;
    }

    const numeric = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isInteger(numeric) || numeric <= 0) {
        throw new RequestValidationError(`${options?.label ?? key} must be a positive integer`);
    }
    if (options?.max && numeric > options.max) {
        throw new RequestValidationError(`${options?.label ?? key} exceeds maximum value of ${options.max}`);
    }
    return numeric;
}

function readFiniteNumber(
    value: PlainObject,
    key: string,
    options: { min: number; max: number }
): number | undefined {
    const raw = value[key];
    if (raw === undefined) return undefined;

    const numeric = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(numeric) || numeric < options.min || numeric > options.max) {
        throw new RequestValidationError(`${key} must be a number between ${options.min} and ${options.max}`);
    }
    return numeric;
}

function readStringArray(value: PlainObject, key: string, options?: { maxItems?: number; maxLength?: number }): string[] | undefined {
    const raw = value[key];
    if (raw === undefined) return undefined;
    if (!Array.isArray(raw)) {
        throw new RequestValidationError(`${key} must be an array of strings`);
    }
    if (options?.maxItems && raw.length > options.maxItems) {
        throw new RequestValidationError(`${key} exceeds maximum size of ${options.maxItems}`);
    }

    const result = raw.map((entry, index) => {
        if (typeof entry !== 'string') {
            throw new RequestValidationError(`${key}[${index}] must be a string`);
        }
        const trimmed = entry.trim();
        if (!trimmed) {
            throw new RequestValidationError(`${key}[${index}] must not be empty`);
        }
        if (options?.maxLength && trimmed.length > options.maxLength) {
            throw new RequestValidationError(`${key}[${index}] exceeds maximum length of ${options.maxLength}`);
        }
        return trimmed;
    });

    return Array.from(new Set(result));
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
    return PRIVATE_HOST_PATTERNS.has(normalized)
        || normalized.endsWith('.local')
        || normalized.endsWith('.internal');
}

function matchesAllowedHost(hostname: string): boolean {
    if (env.CUSTOM_PROVIDER_ALLOWED_HOSTS.length === 0) return false;
    return env.CUSTOM_PROVIDER_ALLOWED_HOSTS.some((allowedHost) =>
        hostname === allowedHost || hostname.endsWith(`.${allowedHost}`)
    );
}

async function validateCustomProviderBaseUrl(rawBaseUrl: string): Promise<string> {
    let parsedUrl: URL;
    try {
        parsedUrl = new URL(rawBaseUrl);
    } catch {
        throw new RequestValidationError('baseUrl must be a valid URL');
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        throw new RequestValidationError('baseUrl must use http or https');
    }

    if (!env.ALLOW_UNSAFE_CUSTOM_PROVIDER_URLS && parsedUrl.protocol !== 'https:') {
        throw new RequestValidationError('Custom provider baseUrl must use https');
    }

    if (parsedUrl.username || parsedUrl.password) {
        throw new RequestValidationError('baseUrl must not embed credentials');
    }

    const hostname = parsedUrl.hostname.toLowerCase();
    if (isPrivateHostname(hostname)) {
        throw new RequestValidationError('Custom provider baseUrl must not target localhost or private hostnames');
    }

    if (!env.ALLOW_UNSAFE_CUSTOM_PROVIDER_URLS) {
        if (env.CUSTOM_PROVIDER_ALLOWED_HOSTS.length === 0) {
            throw new RequestValidationError('Custom providers are disabled until CUSTOM_PROVIDER_ALLOWED_HOSTS is configured');
        }
        if (!matchesAllowedHost(hostname)) {
            throw new RequestValidationError('Custom provider hostname is not in CUSTOM_PROVIDER_ALLOWED_HOSTS');
        }
    }

    if (isPrivateIpAddress(hostname)) {
        throw new RequestValidationError('Custom provider baseUrl must not target private IP ranges');
    }

    try {
        const resolved = await lookup(hostname, { all: true, verbatim: true });
        if (resolved.some((entry) => isPrivateIpAddress(entry.address))) {
            throw new RequestValidationError('Custom provider baseUrl resolves to a private IP address');
        }
    } catch (error) {
        if (error instanceof RequestValidationError) {
            throw error;
        }
        if (!env.ALLOW_UNSAFE_CUSTOM_PROVIDER_URLS) {
            throw new RequestValidationError('Custom provider hostname could not be resolved safely');
        }
    }

    return parsedUrl.toString();
}

export function validateLoginBody(body: unknown): { token: string } {
    const payload = asObject(body, 'request body');
    assertAllowedKeys(payload, ['token'], 'request body');
    return {
        token: readRequiredString(payload, 'token', { maxLength: 2048 }),
    };
}

export async function validateProviderCreateBody(body: unknown): Promise<{
    name: string;
    displayName: string;
    type: ProviderType;
    baseUrl?: string;
    supportedModels: string[];
    isActive: boolean;
}> {
    const payload = asObject(body, 'request body');
    assertAllowedKeys(payload, ['name', 'displayName', 'type', 'baseUrl', 'supportedModels', 'isActive'], 'request body');

    const type = readRequiredString(payload, 'type', { maxLength: 40 }) as ProviderType;
    if (!['google-gemini', 'google-imagen', 'openai', 'custom'].includes(type)) {
        throw new RequestValidationError('type must be one of: google-gemini, google-imagen, openai, custom');
    }

    const baseUrl = type === 'custom'
        ? await validateCustomProviderBaseUrl(readRequiredString(payload, 'baseUrl', { maxLength: 2048 }))
        : undefined;

    return {
        name: readRequiredString(payload, 'name', { maxLength: 80 }),
        displayName: readRequiredString(payload, 'displayName', { maxLength: 120 }),
        type,
        baseUrl,
        supportedModels: readStringArray(payload, 'supportedModels', { maxItems: 200, maxLength: 160 }) ?? [],
        isActive: readOptionalBoolean(payload, 'isActive') ?? true,
    };
}

export async function validateProviderUpdateBody(body: unknown, existingProvider: Provider): Promise<Partial<Provider>> {
    const payload = asObject(body, 'request body');
    assertAllowedKeys(payload, ['name', 'displayName', 'type', 'baseUrl', 'supportedModels', 'isActive'], 'request body');

    const nextType = (readOptionalString(payload, 'type', { maxLength: 40 }) ?? existingProvider.type) as ProviderType;
    if (!['google-gemini', 'google-imagen', 'openai', 'custom'].includes(nextType)) {
        throw new RequestValidationError('type must be one of: google-gemini, google-imagen, openai, custom');
    }

    const nextBaseUrlRaw = payload.baseUrl !== undefined
        ? readOptionalString(payload, 'baseUrl', { maxLength: 2048 })
        : existingProvider.baseUrl;
    const nextBaseUrl = nextType === 'custom'
        ? await validateCustomProviderBaseUrl(nextBaseUrlRaw ?? '')
        : undefined;

    return {
        ...(payload.name !== undefined ? { name: readOptionalString(payload, 'name', { maxLength: 80 })! } : {}),
        ...(payload.displayName !== undefined ? { displayName: readOptionalString(payload, 'displayName', { maxLength: 120 })! } : {}),
        ...(payload.type !== undefined ? { type: nextType } : {}),
        ...(payload.baseUrl !== undefined || existingProvider.type === 'custom' || nextType === 'custom'
            ? { baseUrl: nextBaseUrl }
            : {}),
        ...(payload.supportedModels !== undefined
            ? { supportedModels: readStringArray(payload, 'supportedModels', { maxItems: 200, maxLength: 160 }) ?? [] }
            : {}),
        ...(payload.isActive !== undefined ? { isActive: readOptionalBoolean(payload, 'isActive')! } : {}),
    };
}

export function validateKeyPayload(body: unknown): {
    providerId: string;
    label: string;
    rawKey: string;
    priority?: number;
    weight?: number;
    rules?: ApiKeyRules;
} {
    const payload = asObject(body, 'request body');
    assertAllowedKeys(payload, ['providerId', 'label', 'rawKey', 'priority', 'weight', 'rules'], 'request body');

    return {
        providerId: readRequiredString(payload, 'providerId', { maxLength: 120 }),
        label: readRequiredString(payload, 'label', { maxLength: 120 }),
        rawKey: readRequiredString(payload, 'rawKey', { maxLength: 8192, trim: false }),
        priority: readPositiveInteger(payload, 'priority', { max: 10_000 }),
        weight: readPositiveInteger(payload, 'weight', { max: 10_000 }),
        rules: payload.rules !== undefined ? validateRateLimitRules(payload.rules) : undefined,
    };
}

export function validateClientPayload(body: unknown): {
    name: string;
    role: 'ADMIN' | 'CLIENT';
    expiresAt?: Date;
} {
    const payload = asObject(body, 'request body');
    assertAllowedKeys(payload, ['name', 'role', 'expiresAt'], 'request body');

    const role = readRequiredString(payload, 'role', { maxLength: 20 }) as 'ADMIN' | 'CLIENT';
    if (!['ADMIN', 'CLIENT'].includes(role)) {
        throw new RequestValidationError('role must be one of: ADMIN, CLIENT');
    }

    const expiresAt = readOptionalDate(payload, 'expiresAt');
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
        throw new RequestValidationError('expiresAt must be a future date');
    }

    return {
        name: readRequiredString(payload, 'name', { maxLength: 120 }),
        role,
        ...(expiresAt ? { expiresAt } : {}),
    };
}

export function validateModelPayload(body: unknown): {
    name: string;
    displayName: string;
    providerId: string;
    cost?: string;
    description?: string;
    inputModalities: Array<'TEXT' | 'IMAGE'>;
    outputModalities: Array<'TEXT' | 'IMAGE'>;
} {
    const payload = asObject(body, 'request body');
    assertAllowedKeys(payload, ['name', 'displayName', 'providerId', 'cost', 'description', 'inputModalities', 'outputModalities'], 'request body');

    const inputModalities = readStringArray(payload, 'inputModalities', { maxItems: 2, maxLength: 10 });
    const outputModalities = readStringArray(payload, 'outputModalities', { maxItems: 2, maxLength: 10 });

    if (!inputModalities || inputModalities.length === 0) {
        throw new RequestValidationError('inputModalities must contain at least one item');
    }
    if (!outputModalities || outputModalities.length === 0) {
        throw new RequestValidationError('outputModalities must contain at least one item');
    }

    const normalizeModalities = (values: string[], field: string) => {
        const normalized = values.map((value) => value.toUpperCase());
        const invalid = normalized.filter((value) => !['TEXT', 'IMAGE'].includes(value));
        if (invalid.length > 0) {
            throw new RequestValidationError(`${field} must contain only: TEXT, IMAGE`);
        }
        return Array.from(new Set(normalized)) as Array<'TEXT' | 'IMAGE'>;
    };

    return {
        name: readRequiredString(payload, 'name', { maxLength: 160 }),
        displayName: readRequiredString(payload, 'displayName', { maxLength: 160 }),
        providerId: readRequiredString(payload, 'providerId', { maxLength: 120 }),
        cost: readOptionalString(payload, 'cost', { maxLength: 120 }),
        description: readOptionalString(payload, 'description', { maxLength: 1000 }),
        inputModalities: normalizeModalities(inputModalities, 'inputModalities'),
        outputModalities: normalizeModalities(outputModalities, 'outputModalities'),
    };
}

export function validateRateLimitRules(value: unknown): ApiKeyRules {
    const payload = asObject(value, 'rules');
    const allowedKeys = Object.keys(RATE_RULE_LIMITS);
    assertAllowedKeys(payload, allowedKeys, 'rules');

    const result: ApiKeyRules = {};
    for (const key of allowedKeys as Array<keyof ApiKeyRules>) {
        const numericValue = readPositiveInteger(payload, key, { max: RATE_RULE_LIMITS[key], label: key });
        if (numericValue !== undefined) {
            result[key] = numericValue;
        }
    }
    return result;
}

export function validateRulePayload(body: unknown): {
    keyId: string;
    modelId: string;
    modelName: string;
    rules: ApiKeyRules;
} {
    const payload = asObject(body, 'request body');
    assertAllowedKeys(payload, ['keyId', 'modelId', 'modelName', 'rules'], 'request body');

    return {
        keyId: readRequiredString(payload, 'keyId', { maxLength: 120 }),
        modelId: readRequiredString(payload, 'modelId', { maxLength: 120 }),
        modelName: readRequiredString(payload, 'modelName', { maxLength: 160 }),
        rules: payload.rules === undefined ? {} : validateRateLimitRules(payload.rules),
    };
}

export function validateBulkRulePayload(body: unknown): {
    keyIds: string[];
    models: Array<{ id: string; name: string }>;
    rules: ApiKeyRules;
} {
    const payload = asObject(body, 'request body');
    assertAllowedKeys(payload, ['keyIds', 'models', 'rules'], 'request body');

    const keyIds = readStringArray(payload, 'keyIds', { maxItems: 500, maxLength: 120 });
    if (!keyIds || keyIds.length === 0) {
        throw new RequestValidationError('keyIds must contain at least one item');
    }

    if (!Array.isArray(payload.models) || payload.models.length === 0) {
        throw new RequestValidationError('models must contain at least one item');
    }
    if (payload.models.length > 500) {
        throw new RequestValidationError('models exceeds maximum size of 500');
    }

    const models = payload.models.map((entry, index) => {
        const model = asObject(entry, `models[${index}]`);
        assertAllowedKeys(model, ['id', 'name'], `models[${index}]`);
        return {
            id: readRequiredString(model, 'id', { maxLength: 120, label: `models[${index}].id` }),
            name: readRequiredString(model, 'name', { maxLength: 160, label: `models[${index}].name` }),
        };
    });

    return {
        keyIds,
        models,
        rules: payload.rules === undefined ? {} : validateRateLimitRules(payload.rules),
    };
}

export function validateProxyInput(body: unknown): ProxyInput {
    const payload = asObject(body, 'request body');
    assertAllowedKeys(payload, ['prompt', 'input', 'model', 'provider', 'options'], 'request body');

    const result: ProxyInput = {
        input: [],
        model: readRequiredString(payload, 'model', { maxLength: 160 }),
    };

    const prompt = readOptionalString(payload, 'prompt', { maxLength: 100_000, trim: false });
    if (prompt !== undefined) {
        result.input.push({ type: 'text', text: prompt });
    }

    if (payload.input !== undefined) {
        if (!Array.isArray(payload.input)) {
            throw new RequestValidationError('input must be an array');
        }
        if (payload.input.length === 0) {
            throw new RequestValidationError('input must contain at least one item');
        }
        if (payload.input.length > 64) {
            throw new RequestValidationError('input exceeds maximum size of 64');
        }

        result.input = payload.input.map((entry, index) => {
            const part = asObject(entry, `input[${index}]`);
            const type = readRequiredString(part, 'type', { maxLength: 20, label: `input[${index}].type` });

            if (type === 'text') {
                assertAllowedKeys(part, ['type', 'text'], `input[${index}]`);
                return {
                    type: 'text' as const,
                    text: readRequiredString(part, 'text', { maxLength: 100_000, trim: false, label: `input[${index}].text` }),
                };
            }

            if (type === 'image') {
                assertAllowedKeys(part, ['type', 'mimeType', 'data'], `input[${index}]`);
                const mimeType = readRequiredString(part, 'mimeType', { maxLength: 120, label: `input[${index}].mimeType` });
                if (!/^[a-z]+\/[a-z0-9.+-]+$/i.test(mimeType)) {
                    throw new RequestValidationError(`input[${index}].mimeType must be a valid MIME type`);
                }

                const data = readRequiredString(part, 'data', { maxLength: 20_000_000, trim: true, label: `input[${index}].data` });
                if (!/^[A-Za-z0-9+/=]+$/.test(data)) {
                    throw new RequestValidationError(`input[${index}].data must be a base64 string`);
                }

                return {
                    type: 'image' as const,
                    mimeType,
                    data,
                };
            }

            throw new RequestValidationError(`input[${index}].type must be one of: text, image`);
        });
    }

    const provider = readOptionalString(payload, 'provider', { maxLength: 80 });
    if (provider) {
        result.provider = provider;
    }

    if (payload.options !== undefined) {
        const options = asObject(payload.options, 'options');
        assertAllowedKeys(
            options,
            ['temperature', 'topP', 'thinkingBudget', 'thinkingLevel', 'maxTokens', 'outputMimeType', 'sampleCount', 'aspectRatio', 'imageSize', 'personGeneration', 'responseModalities'],
            'options'
        );

        const parsedOptions: NonNullable<ProxyInput['options']> = {};
        const temperature = readFiniteNumber(options, 'temperature', { min: 0, max: 2 });
        if (temperature !== undefined) parsedOptions.temperature = temperature;
        const topP = readFiniteNumber(options, 'topP', { min: 0, max: 1 });
        if (topP !== undefined) parsedOptions.topP = topP;

        const thinkingBudget = readPositiveInteger(options, 'thinkingBudget', { max: 1_000_000 });
        if (thinkingBudget !== undefined) parsedOptions.thinkingBudget = thinkingBudget;
        const thinkingLevel = readOptionalString(options, 'thinkingLevel', { maxLength: 20 });
        if (thinkingLevel) {
            if (!['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'].includes(thinkingLevel)) {
                throw new RequestValidationError('thinkingLevel must be one of: MINIMAL, LOW, MEDIUM, HIGH');
            }
            parsedOptions.thinkingLevel = thinkingLevel as NonNullable<ProxyInput['options']>['thinkingLevel'];
        }
        const maxTokens = readPositiveInteger(options, 'maxTokens', { max: 1_000_000 });
        if (maxTokens !== undefined) parsedOptions.maxTokens = maxTokens;
        const sampleCount = readPositiveInteger(options, 'sampleCount', { max: 32 });
        if (sampleCount !== undefined) parsedOptions.sampleCount = sampleCount;

        const outputMimeType = readOptionalString(options, 'outputMimeType', { maxLength: 120 });
        if (outputMimeType) {
            if (!/^[a-z]+\/[a-z0-9.+-]+$/i.test(outputMimeType)) {
                throw new RequestValidationError('outputMimeType must be a valid MIME type');
            }
            parsedOptions.outputMimeType = outputMimeType;
        }

        const aspectRatio = readOptionalString(options, 'aspectRatio', { maxLength: 20 });
        if (aspectRatio) {
            if (!/^\d+:\d+$/.test(aspectRatio)) {
                throw new RequestValidationError('aspectRatio must use the format WIDTH:HEIGHT');
            }
            parsedOptions.aspectRatio = aspectRatio;
        }

        const imageSize = readOptionalString(options, 'imageSize', { maxLength: 20 });
        if (imageSize) {
            if (!['1K', '2K'].includes(imageSize)) {
                throw new RequestValidationError('imageSize must be one of: 1K, 2K');
            }
            parsedOptions.imageSize = imageSize;
        }

        const personGeneration = readOptionalString(options, 'personGeneration', { maxLength: 20 });
        if (personGeneration) {
            if (!['DONT_ALLOW', 'ALLOW_ADULT'].includes(personGeneration)) {
                throw new RequestValidationError('personGeneration must be one of: DONT_ALLOW, ALLOW_ADULT');
            }
            parsedOptions.personGeneration = personGeneration as NonNullable<ProxyInput['options']>['personGeneration'];
        }

        const responseModalities = readStringArray(options, 'responseModalities', { maxItems: 2, maxLength: 10 });
        if (responseModalities) {
            const normalized = responseModalities.map((modality) => modality.toUpperCase());
            const invalid = normalized.filter((modality) => !['TEXT', 'IMAGE'].includes(modality));
            if (invalid.length > 0) {
                throw new RequestValidationError('responseModalities must contain only: TEXT, IMAGE');
            }
            parsedOptions.responseModalities = Array.from(new Set(normalized)) as NonNullable<ProxyInput['options']>['responseModalities'];
        }

        if (Object.keys(parsedOptions).length > 0) {
            result.options = parsedOptions;
        }
    }

    if (result.input.length === 0) {
        throw new RequestValidationError('input is required');
    }

    const hasUsableText = result.input.some((part) => part.type === 'text' && part.text.trim().length > 0);
    const hasImage = result.input.some((part) => part.type === 'image');
    if (!hasUsableText && !hasImage) {
        throw new RequestValidationError('input must contain non-empty text or image data');
    }

    return result;
}
