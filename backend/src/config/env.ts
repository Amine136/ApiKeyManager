import dotenv from 'dotenv';
dotenv.config();

function requireEnv(key: string): string {
    const val = process.env[key];
    if (!val) throw new Error(`Missing required environment variable: ${key}`);
    return val;
}

function parseIntEnv(key: string, fallback: number): number {
    const raw = process.env[key];
    if (raw === undefined) return fallback;
    const parsed = parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`${key} must be a positive integer`);
    }
    return parsed;
}

function parseBooleanEnv(key: string, fallback: boolean): boolean {
    const raw = process.env[key];
    if (raw === undefined) return fallback;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    throw new Error(`${key} must be "true" or "false"`);
}

function parseCsvEnv(key: string): string[] {
    const raw = process.env[key];
    if (!raw) return [];
    return raw
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean);
}

export const env = {
    PORT: parseIntEnv('PORT', 3000),
    ENCRYPTION_KEY: requireEnv('ENCRYPTION_KEY'),
    FIREBASE_PROJECT_ID: requireEnv('FIREBASE_PROJECT_ID'),
    FIREBASE_SERVICE_ACCOUNT_PATH: requireEnv('FIREBASE_SERVICE_ACCOUNT_PATH'),
    FRONTEND_URL: process.env.FRONTEND_URL ?? 'http://localhost:3001',
    GLOBAL_RATE_LIMIT_RPM: parseIntEnv('GLOBAL_RATE_LIMIT_RPM', 100),
    PROVIDER_REQUEST_TIMEOUT_MS: parseIntEnv('PROVIDER_REQUEST_TIMEOUT_MS', 30000),
    LOGIN_RATE_LIMIT_ATTEMPTS_PER_MINUTE: parseIntEnv('LOGIN_RATE_LIMIT_ATTEMPTS_PER_MINUTE', 20),
    PROXY_RATE_LIMIT_PER_IP_PER_MINUTE: parseIntEnv('PROXY_RATE_LIMIT_PER_IP_PER_MINUTE', 180),
    PROXY_RATE_LIMIT_PER_CLIENT_PER_MINUTE: parseIntEnv('PROXY_RATE_LIMIT_PER_CLIENT_PER_MINUTE', 600),
    CLIENT_LAST_USED_WRITE_INTERVAL_MS: parseIntEnv('CLIENT_LAST_USED_WRITE_INTERVAL_MS', 300000),
    CUSTOM_PROVIDER_ALLOWED_HOSTS: parseCsvEnv('CUSTOM_PROVIDER_ALLOWED_HOSTS'),
    ALLOW_UNSAFE_CUSTOM_PROVIDER_URLS: parseBooleanEnv(
        'ALLOW_UNSAFE_CUSTOM_PROVIDER_URLS',
        process.env.NODE_ENV !== 'production'
    ),
};
