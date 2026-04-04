import { db } from '../lib/firebase.js';
import { TTLCache } from '../lib/cache.js';

const COLLECTION = 'keyModelRules';

// Cache rules by keyId — biggest win (avoids N queries per proxy call)
const rulesByKeyCache = new TTLCache<KeyModelRule[]>(2 * 60 * 1000);
const allRulesCache = new TTLCache<KeyModelRule[]>(2 * 60 * 1000);
const rulesByKeyInFlight = new Map<string, Promise<KeyModelRule[]>>();
let allRulesInFlight: Promise<KeyModelRule[]> | null = null;

function logRuleRead(event: string, details: Record<string, unknown>): void {
    console.info(`[RULE_READ] ${event} ${JSON.stringify(details)}`);
}

export function invalidateRuleCache(): void {
    rulesByKeyCache.invalidate();
    allRulesCache.invalidate();
    rulesByKeyInFlight.clear();
    allRulesInFlight = null;
    import('./model.service.js').then(m => m.invalidateAvailableModelsCache()).catch(console.error);
}

export interface KeyModelRule {
    id?: string;
    keyId: string;
    modelId: string;
    modelName: string;  // denormalized for fast lookup
    rules: {
        maxRequestsPerMinute?: number;
        maxRequestsPerHour?: number;
        maxRequestsPerDay?: number;
        maxTokensPerMinute?: number;
        maxTokensPerDay?: number;
        cooldownSeconds?: number;
    };
    createdAt?: Date;
    updatedAt?: Date;
}

export async function listRulesByKey(keyId: string): Promise<KeyModelRule[]> {
    const cached = rulesByKeyCache.get(keyId);
    if (cached) {
        logRuleRead('list_rules_by_key_cache_hit', { keyId, docCount: cached.length });
        return cached;
    }

    const pending = rulesByKeyInFlight.get(keyId);
    if (pending) {
        return pending;
    }

    const loadRules = (async () => {
        const snapshot = await db
            .collection(COLLECTION)
            .where('keyId', '==', keyId)
            .get();
        const result = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() } as KeyModelRule));
        logRuleRead('list_rules_by_key_firestore_read', { keyId, docCount: snapshot.size });
        rulesByKeyCache.set(keyId, result);
        return result;
    })().finally(() => {
        rulesByKeyInFlight.delete(keyId);
    });

    rulesByKeyInFlight.set(keyId, loadRules);
    return loadRules;
}

export async function listRulesByModel(modelName: string): Promise<KeyModelRule[]> {
    const snapshot = await db
        .collection(COLLECTION)
        .where('modelName', '==', modelName)
        .get();
    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() } as KeyModelRule));
}

export async function listAllRules(): Promise<KeyModelRule[]> {
    const cached = allRulesCache.get('all');
    if (cached) {
        logRuleRead('list_all_rules_cache_hit', { docCount: cached.length });
        return cached;
    }

    if (allRulesInFlight) {
        return allRulesInFlight;
    }

    allRulesInFlight = (async () => {
        const snapshot = await db.collection(COLLECTION).get();
        const result = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() } as KeyModelRule));
        logRuleRead('list_all_rules_firestore_read', { docCount: snapshot.size });
        allRulesCache.set('all', result);
        return result;
    })().finally(() => {
        allRulesInFlight = null;
    });

    return allRulesInFlight;
}

export async function createRule(data: Omit<KeyModelRule, 'id' | 'createdAt' | 'updatedAt'>): Promise<KeyModelRule> {
    const now = new Date();
    const payload = { ...data, createdAt: now, updatedAt: now };
    const docRef = await db.collection(COLLECTION).add(payload);
    invalidateRuleCache();
    return { id: docRef.id, ...payload };
}

/**
 * Bulk-create rules for all key × model combinations.
 * Skips any combination that already exists.
 */
export async function bulkCreateRules(
    keyIds: string[],
    modelsInfo: { id: string; name: string }[],
    rules: KeyModelRule['rules']
): Promise<{ created: number; skipped: number }> {
    // Load existing rules to detect duplicates
    const existing = await listAllRules();
    const existingSet = new Set(
        existing.map((r) => `${r.keyId}::${r.modelId}`)
    );

    let created = 0;
    let skipped = 0;

    for (const keyId of keyIds) {
        for (const model of modelsInfo) {
            const combo = `${keyId}::${model.id}`;
            if (existingSet.has(combo)) {
                skipped++;
                continue;
            }
            await createRule({
                keyId,
                modelId: model.id,
                modelName: model.name,
                rules,
            });
            created++;
        }
    }

    return { created, skipped };
}

export async function deleteRule(id: string): Promise<boolean> {
    const doc = await db.collection(COLLECTION).doc(id).get();
    if (!doc.exists) return false;
    await db.collection(COLLECTION).doc(id).delete();
    invalidateRuleCache();
    return true;
}

/** Delete all rules for a given key (used when a key is deleted). */
export async function deleteRulesByKey(keyId: string): Promise<void> {
    const snapshot = await db
        .collection(COLLECTION)
        .where('keyId', '==', keyId)
        .get();
    const batch = db.batch();
    snapshot.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
}
