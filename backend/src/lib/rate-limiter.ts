import { db } from './firebase.js';

export interface RateLimitRules {
    maxRequestsPerMinute?: number;
    maxRequestsPerHour?: number;
    maxRequestsPerDay?: number;
    maxTokensPerMinute?: number;
    maxTokensPerDay?: number;
    cooldownSeconds?: number;
}

interface CounterConfig {
    metric: 'rpm' | 'rph' | 'rpd' | 'tpm' | 'tpd';
    limit: number;
    windowMs: number;
    amount: number;
}

interface CounterReservation {
    docId: string;
    amount: number;
}

export interface RateLimitReservation {
    keyId: string;
    reservedAtMs: number;
    requestCounters: CounterReservation[];
    tokenCounters: CounterReservation[];
}

const COUNTER_COLLECTION = 'rateLimitCounters';
const COOLDOWN_COLLECTION = 'rateLimitCooldowns';

function encodeKey(value: string): string {
    return Buffer.from(value).toString('base64url');
}

function startOfUtcDayMs(timestampMs: number): number {
    const date = new Date(timestampMs);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function getWindowStartMs(windowMs: number, nowMs: number): number {
    if (windowMs === 86_400_000) {
        return startOfUtcDayMs(nowMs);
    }
    return Math.floor(nowMs / windowMs) * windowMs;
}

function buildCounterDocId(keyId: string, metric: string, windowStartMs: number): string {
    return encodeKey(`${keyId}:${metric}:${windowStartMs}`);
}

function normalizeDate(value: any): Date | null {
    if (!value) return null;
    if (value instanceof Date) return value;
    if (typeof value?.toDate === 'function') return value.toDate();
    return null;
}

function buildRequestCounterConfigs(rules: RateLimitRules): CounterConfig[] {
    const configs: CounterConfig[] = [];
    if (rules.maxRequestsPerMinute) {
        configs.push({ metric: 'rpm', limit: rules.maxRequestsPerMinute, windowMs: 60_000, amount: 1 });
    }
    if (rules.maxRequestsPerHour) {
        configs.push({ metric: 'rph', limit: rules.maxRequestsPerHour, windowMs: 3_600_000, amount: 1 });
    }
    if (rules.maxRequestsPerDay) {
        configs.push({ metric: 'rpd', limit: rules.maxRequestsPerDay, windowMs: 86_400_000, amount: 1 });
    }
    return configs;
}

function buildTokenCounterConfigs(rules: RateLimitRules, tokenAmount: number): CounterConfig[] {
    if (tokenAmount <= 0) return [];

    const configs: CounterConfig[] = [];
    if (rules.maxTokensPerMinute) {
        configs.push({ metric: 'tpm', limit: rules.maxTokensPerMinute, windowMs: 60_000, amount: tokenAmount });
    }
    if (rules.maxTokensPerDay) {
        configs.push({ metric: 'tpd', limit: rules.maxTokensPerDay, windowMs: 86_400_000, amount: tokenAmount });
    }
    return configs;
}

function failureReason(metric: CounterConfig['metric']): string {
    switch (metric) {
        case 'rpm':
            return 'Exceeded max requests per minute';
        case 'rph':
            return 'Exceeded max requests per hour';
        case 'rpd':
            return 'Exceeded max requests per day';
        case 'tpm':
            return 'Exceeded max tokens per minute';
        case 'tpd':
            return 'Exceeded max tokens per day';
        default:
            return 'Rate limit exceeded';
    }
}

async function hasActiveCooldown(keyId: string, now: Date): Promise<boolean> {
    const docRef = db.collection(COOLDOWN_COLLECTION).doc(encodeKey(keyId));
    const snapshot = await docRef.get();
    if (!snapshot.exists) return false;

    const expiresAt = normalizeDate(snapshot.data()?.expiresAt);
    if (!expiresAt || expiresAt.getTime() <= now.getTime()) {
        await docRef.delete().catch(() => undefined);
        return false;
    }
    return true;
}

export async function checkRateLimit(
    keyId: string,
    rules: RateLimitRules,
    reservedTokenCount = 0
): Promise<{ allowed: boolean; reason?: string }> {
    const nowMs = Date.now();
    const now = new Date(nowMs);

    if (await hasActiveCooldown(keyId, now)) {
        return { allowed: false, reason: 'Key is in cooldown period' };
    }

    const counters = [
        ...buildRequestCounterConfigs(rules),
        ...buildTokenCounterConfigs(rules, reservedTokenCount),
    ];
    if (counters.length === 0) {
        return { allowed: true };
    }

    for (const config of counters) {
        const windowStartMs = getWindowStartMs(config.windowMs, nowMs);
        const docId = buildCounterDocId(keyId, config.metric, windowStartMs);
        const snapshot = await db.collection(COUNTER_COLLECTION).doc(docId).get();
        const currentCount = snapshot.exists ? Number(snapshot.data()?.count ?? 0) : 0;
        if (currentCount + config.amount > config.limit) {
            return { allowed: false, reason: failureReason(config.metric) };
        }
    }

    return { allowed: true };
}

export async function reserveRateLimit(
    keyId: string,
    rules: RateLimitRules,
    reservedTokenCount = 0
): Promise<{ allowed: boolean; reason?: string; reservation?: RateLimitReservation }> {
    const requestCounters = buildRequestCounterConfigs(rules);
    const tokenCounters = buildTokenCounterConfigs(rules, reservedTokenCount);
    const nowMs = Date.now();
    const now = new Date(nowMs);

    return db.runTransaction(async (tx) => {
        const cooldownRef = db.collection(COOLDOWN_COLLECTION).doc(encodeKey(keyId));
        const cooldownSnap = await tx.get(cooldownRef);
        let shouldDeleteExpiredCooldown = false;
        if (cooldownSnap.exists) {
            const expiresAt = normalizeDate(cooldownSnap.data()?.expiresAt);
            if (expiresAt && expiresAt.getTime() > now.getTime()) {
                return { allowed: false, reason: 'Key is in cooldown period' } as const;
            }
            shouldDeleteExpiredCooldown = true;
        }

        const reservation: RateLimitReservation = {
            keyId,
            reservedAtMs: nowMs,
            requestCounters: [],
            tokenCounters: [],
        };

        const allCounters = [
            ...requestCounters.map((config) => ({ ...config, kind: 'request' as const })),
            ...tokenCounters.map((config) => ({ ...config, kind: 'token' as const })),
        ];

        const counterEntries = allCounters.map((config) => {
            const windowStartMs = getWindowStartMs(config.windowMs, nowMs);
            const docId = buildCounterDocId(keyId, config.metric, windowStartMs);
            const docRef = db.collection(COUNTER_COLLECTION).doc(docId);

            return {
                config,
                windowStartMs,
                docId,
                docRef,
            };
        });

        const counterSnapshots = counterEntries.length > 0
            ? await tx.getAll(...counterEntries.map((entry) => entry.docRef))
            : [];

        for (let index = 0; index < counterEntries.length; index += 1) {
            const entry = counterEntries[index];
            const snapshot = counterSnapshots[index];
            const currentCount = snapshot.exists ? Number(snapshot.data()?.count ?? 0) : 0;

            if (currentCount + entry.config.amount > entry.config.limit) {
                return { allowed: false, reason: failureReason(entry.config.metric) } as const;
            }
        }

        for (let index = 0; index < counterEntries.length; index += 1) {
            const entry = counterEntries[index];
            const snapshot = counterSnapshots[index];
            const currentCount = snapshot.exists ? Number(snapshot.data()?.count ?? 0) : 0;

            tx.set(entry.docRef, {
                keyId,
                metric: entry.config.metric,
                count: currentCount + entry.config.amount,
                windowStart: new Date(entry.windowStartMs),
                expiresAt: new Date(entry.windowStartMs + entry.config.windowMs),
                updatedAt: now,
            }, { merge: true });

            const counterReservation = { docId: entry.docId, amount: entry.config.amount };
            if (entry.config.kind === 'request') {
                reservation.requestCounters.push(counterReservation);
            } else {
                reservation.tokenCounters.push(counterReservation);
            }
        }

        if (shouldDeleteExpiredCooldown) {
            tx.delete(cooldownRef);
        }

        return { allowed: true, reservation } as const;
    });
}

async function applyCounterDelta(docId: string, amountDelta: number): Promise<void> {
    if (amountDelta === 0) return;

    await db.runTransaction(async (tx) => {
        const docRef = db.collection(COUNTER_COLLECTION).doc(docId);
        const snapshot = await tx.get(docRef);
        if (!snapshot.exists) {
            return;
        }

        const currentCount = Number(snapshot.data()?.count ?? 0);
        const nextCount = currentCount + amountDelta;
        if (nextCount <= 0) {
            tx.delete(docRef);
            return;
        }

        tx.update(docRef, {
            count: nextCount,
            updatedAt: new Date(),
        });
    });
}

export async function releaseRateLimitReservation(reservation?: RateLimitReservation | null): Promise<void> {
    if (!reservation) return;

    for (const counter of reservation.requestCounters) {
        await applyCounterDelta(counter.docId, -counter.amount);
    }
    for (const counter of reservation.tokenCounters) {
        await applyCounterDelta(counter.docId, -counter.amount);
    }
}

export async function finalizeRateLimitReservation(
    reservation: RateLimitReservation | null | undefined,
    rules: RateLimitRules,
    actualTokenCount = 0
): Promise<void> {
    if (!reservation) {
        return;
    }

    const reservedTokenCount = reservation.tokenCounters.reduce((sum, counter) => sum + counter.amount, 0);
    const delta = actualTokenCount - reservedTokenCount;
    if (delta === 0) {
        return;
    }

    if (reservation.tokenCounters.length > 0) {
        for (const counter of reservation.tokenCounters) {
            const matchingConfig = buildTokenCounterConfigs(rules, Math.abs(delta))
                .find((config) => counter.docId === buildCounterDocId(
                    reservation.keyId,
                    config.metric,
                    getWindowStartMs(config.windowMs, reservation.reservedAtMs),
                ));
            if (matchingConfig) {
                await applyCounterDelta(counter.docId, delta > 0 ? matchingConfig.amount : -matchingConfig.amount);
            }
        }
        return;
    }

    const tokenCounterConfigs = buildTokenCounterConfigs(rules, Math.abs(delta));
    for (const config of tokenCounterConfigs) {
        const windowStartMs = getWindowStartMs(config.windowMs, reservation.reservedAtMs);
        const docId = buildCounterDocId(reservation.keyId, config.metric, windowStartMs);
        await applyCounterDelta(docId, delta > 0 ? config.amount : -config.amount);
    }
}

export async function triggerCooldown(keyId: string, cooldownSeconds: number): Promise<void> {
    if (cooldownSeconds <= 0) return;

    await db.collection(COOLDOWN_COLLECTION).doc(encodeKey(keyId)).set({
        keyId,
        expiresAt: new Date(Date.now() + cooldownSeconds * 1000),
        updatedAt: new Date(),
    }, { merge: true });
}
