import { db } from '../lib/firebase.js';
import { encrypt, decrypt } from '../lib/encryption.js';
import { checkRateLimit, reserveRateLimit, type RateLimitReservation } from '../lib/rate-limiter.js';
import { TTLCache } from '../lib/cache.js';

const COLLECTION = 'apiKeys';

// Caches
const listCache = new TTLCache<ApiKey[]>(2 * 60 * 1000);
const byProviderCache = new TTLCache<ApiKey[]>(2 * 60 * 1000);
let listInFlight: Promise<ApiKey[]> | null = null;
const byProviderInFlight = new Map<string, Promise<ApiKey[]>>();

function logKeyRead(event: string, details: Record<string, unknown>): void {
    console.info(`[KEY_READ] ${event} ${JSON.stringify(details)}`);
}

export function invalidateKeyCache(): void {
    listCache.invalidate();
    byProviderCache.invalidate();
    listInFlight = null;
    byProviderInFlight.clear();
    import('./model.service.js').then(m => m.invalidateAvailableModelsCache()).catch(console.error);
}

export interface ApiKeyRules {
    maxRequestsPerMinute?: number;
    maxRequestsPerHour?: number;
    maxRequestsPerDay?: number;
    maxTokensPerMinute?: number;
    maxTokensPerDay?: number;
    cooldownSeconds?: number;
}

export type KeyStatus = 'ACTIVE' | 'DISABLED' | 'EXHAUSTED' | 'REVOKED';

export interface ApiKey {
    id?: string;
    providerId: string;
    label: string;
    encryptedKey: string;
    status: KeyStatus;
    priority: number;
    weight: number;
    rules: ApiKeyRules;
    createdAt?: Date;
    updatedAt?: Date;
}

export async function listKeys(): Promise<ApiKey[]> {
    const cached = listCache.get('all');
    if (cached) {
        logKeyRead('list_keys_cache_hit', { docCount: cached.length });
        return cached;
    }

    if (listInFlight) {
        return listInFlight;
    }

    listInFlight = (async () => {
        const snapshot = await db.collection(COLLECTION).get();
        const result = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() } as ApiKey));
        logKeyRead('list_keys_firestore_read', { docCount: snapshot.size });
        listCache.set('all', result);
        return result;
    })().finally(() => {
        listInFlight = null;
    });

    return listInFlight;
}

export async function getKey(id: string): Promise<ApiKey | null> {
    const doc = await db.collection(COLLECTION).doc(id).get();
    if (!doc.exists) return null;
    return { id: doc.id, ...doc.data() } as ApiKey;
}

export async function createKey(data: {
    providerId: string;
    label: string;
    rawKey: string;
    priority?: number;
    weight?: number;
    rules?: ApiKeyRules;
}): Promise<ApiKey> {
    const encryptedKey = encrypt(data.rawKey);
    const now = new Date();
    const keyData = {
        providerId: data.providerId,
        label: data.label,
        encryptedKey,
        status: 'ACTIVE' as KeyStatus,
        priority: data.priority ?? 1,
        weight: data.weight ?? 1,
        rules: data.rules ?? {},
        createdAt: now,
        updatedAt: now,
    };
    const docRef = await db.collection(COLLECTION).add(keyData);
    invalidateKeyCache();
    return { id: docRef.id, ...keyData };
}

export async function deleteKey(id: string): Promise<boolean> {
    const doc = await db.collection(COLLECTION).doc(id).get();
    if (!doc.exists) return false;
    await db.collection(COLLECTION).doc(id).delete();
    invalidateKeyCache();
    return true;
}

export async function toggleKey(id: string): Promise<ApiKey | null> {
    const docRef = db.collection(COLLECTION).doc(id);
    const doc = await docRef.get();
    if (!doc.exists) return null;

    const current = doc.data()!;
    const newStatus: KeyStatus = current.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
    await docRef.update({ status: newStatus, updatedAt: new Date() });
    invalidateKeyCache();
    return { id, ...current, status: newStatus } as ApiKey;
}

/**
 * Key selection algorithm (model-aware):
 * 1. Get all ACTIVE keys for the given provider
 * 2. Load keyModelRules for each key:
 *    - Has rules + model NOT in them → skip (model not authorised on this key)
 *    - Has rules + model IS in them  → use those model-specific rate limits
 *    - No rules at all               → allow all models, use key's global rules
 * 3. Filter by rate limit check
 * 4. Sort by priority, weighted random among same-priority group
 */
export interface KeyRejection {
    keyLabel: string;
    reason: string;
}

export type KeySelectionFailureKind = 'model_not_authorised' | 'rate_limited';

export async function selectKey(
    providerId: string,
    model: string,
    reservedTokenCount = 0
): Promise<
    { keyDoc: ApiKey; decryptedKey: string; rulesUsed: ApiKeyRules; reservation: RateLimitReservation }
    | { rejections: KeyRejection[]; failureKind: KeySelectionFailureKind }
    | null
> {
    // Use cache for keys by provider
    let keys: ApiKey[];
    const cachedKeys = byProviderCache.get(providerId);
    if (cachedKeys) {
        keys = cachedKeys.filter(k => k.status === 'ACTIVE');
    } else {
        const pending = byProviderInFlight.get(providerId);
        const loadKeys = pending ?? (async () => {
            const snapshot = await db
                .collection(COLLECTION)
                .where('providerId', '==', providerId)
                .where('status', '==', 'ACTIVE')
                .get();

            if (snapshot.empty) return [];
            const result = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() } as ApiKey));
            byProviderCache.set(providerId, result);
            return result;
        })().finally(() => {
            byProviderInFlight.delete(providerId);
        });

        if (!pending) {
            byProviderInFlight.set(providerId, loadKeys);
        }

        keys = await loadKeys;
        if (keys.length === 0) return null;
    }

    if (keys.length === 0) return null;

    const { listRulesByKey } = await import('./keyModelRule.service.js');

    interface KeyWithRules {
        key: ApiKey;
        effectiveRules: ApiKeyRules;
    }

    const eligible: KeyWithRules[] = [];
    const rejections: KeyRejection[] = [];

    for (const key of keys) {
        const modelRules = await listRulesByKey(key.id!);

        let effectiveRules: ApiKeyRules;

        if (modelRules.length === 0) {
            // No model restrictions — accepts all models, use global rules
            effectiveRules = key.rules;
        } else {
            // Key is model-restricted — check if the requested model is authorised
            const matchingRule = modelRules.find((r) => r.modelName === model);
            if (!matchingRule) {
                rejections.push({ keyLabel: key.label, reason: `Model "${model}" not authorised on this key` });
                continue;
            }
            effectiveRules = matchingRule.rules;
        }

        // Rate limit check using effective rules
        const { allowed, reason } = await checkRateLimit(key.id!, effectiveRules, reservedTokenCount);
        if (allowed) {
            eligible.push({ key, effectiveRules });
        } else {
            rejections.push({ keyLabel: key.label, reason: reason ?? 'Rate limit exceeded' });
        }
    }

    if (eligible.length === 0) {
        const failureKind: KeySelectionFailureKind = rejections.length > 0 &&
            rejections.every((rejection) => rejection.reason === `Model "${model}" not authorised on this key`)
            ? 'model_not_authorised'
            : 'rate_limited';

        return { rejections, failureKind };
    }

    const remainingEligible = [...eligible];

    while (remainingEligible.length > 0) {
        remainingEligible.sort((a, b) => a.key.priority - b.key.priority);

        const bestPriority = remainingEligible[0].key.priority;
        const priorityGroup = remainingEligible.filter((entry) => entry.key.priority === bestPriority);

        const totalWeight = priorityGroup.reduce((sum, entry) => sum + entry.key.weight, 0);
        let rand = Math.random() * totalWeight;
        let selected = priorityGroup[0];
        for (const entry of priorityGroup) {
            rand -= entry.key.weight;
            if (rand <= 0) {
                selected = entry;
                break;
            }
        }

        const reservationResult = await reserveRateLimit(selected.key.id!, selected.effectiveRules, reservedTokenCount);
        if (reservationResult.allowed && reservationResult.reservation) {
            const decryptedKey = decrypt(selected.key.encryptedKey);
            return {
                keyDoc: selected.key,
                decryptedKey,
                rulesUsed: selected.effectiveRules,
                reservation: reservationResult.reservation,
            };
        }

        rejections.push({
            keyLabel: selected.key.label,
            reason: reservationResult.reason ?? 'Rate limit exceeded',
        });

        const selectedIndex = remainingEligible.findIndex((entry) => entry.key.id === selected.key.id);
        if (selectedIndex !== -1) {
            remainingEligible.splice(selectedIndex, 1);
        }
    }

    return { rejections, failureKind: 'rate_limited' };
}
