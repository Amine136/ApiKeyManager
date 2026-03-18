import { db } from '../lib/firebase.js';
import { TTLCache } from '../lib/cache.js';

const COLLECTION = 'models';
const listCache = new TTLCache<Model[]>(2 * 60 * 1000);
const byProviderCache = new TTLCache<Model[]>(2 * 60 * 1000);
let listInFlight: Promise<Model[]> | null = null;
const byProviderInFlight = new Map<string, Promise<Model[]>>();

function logModelRead(event: string, details: Record<string, unknown>): void {
    console.info(`[MODEL_READ] ${event} ${JSON.stringify(details)}`);
}

export function invalidateModelCache(): void {
    listCache.invalidate();
    byProviderCache.invalidate();
    listInFlight = null;
    byProviderInFlight.clear();
}

export interface Model {
    id?: string;
    name: string;        // e.g. "gemini-2.5-pro"
    providerId: string;
    createdAt?: Date;
    updatedAt?: Date;
}

export async function listModels(): Promise<Model[]> {
    const cached = listCache.get('all');
    if (cached) {
        logModelRead('list_models_cache_hit', { docCount: cached.length });
        return cached;
    }

    if (listInFlight) {
        return listInFlight;
    }

    listInFlight = (async () => {
        const snapshot = await db.collection(COLLECTION).get();
        const result = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() } as Model));
        logModelRead('list_models_firestore_read', { docCount: snapshot.size });
        listCache.set('all', result);
        return result;
    })().finally(() => {
        listInFlight = null;
    });

    return listInFlight;
}

export async function listModelsByProvider(providerId: string): Promise<Model[]> {
    const cached = byProviderCache.get(providerId);
    if (cached) {
        logModelRead('list_models_by_provider_cache_hit', { providerId, docCount: cached.length });
        return cached;
    }

    const pending = byProviderInFlight.get(providerId);
    if (pending) {
        return pending;
    }

    const loadModels = (async () => {
        const snapshot = await db
            .collection(COLLECTION)
            .where('providerId', '==', providerId)
            .get();
        const result = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() } as Model));
        logModelRead('list_models_by_provider_firestore_read', { providerId, docCount: snapshot.size });
        byProviderCache.set(providerId, result);
        return result;
    })().finally(() => {
        byProviderInFlight.delete(providerId);
    });

    byProviderInFlight.set(providerId, loadModels);
    return loadModels;
}

export async function getModel(id: string): Promise<Model | null> {
    const doc = await db.collection(COLLECTION).doc(id).get();
    if (!doc.exists) return null;
    return { id: doc.id, ...doc.data() } as Model;
}

export async function createModel(data: Pick<Model, 'name' | 'providerId'>): Promise<Model> {
    const now = new Date();
    const payload = { ...data, createdAt: now, updatedAt: now };
    const docRef = await db.collection(COLLECTION).add(payload);
    invalidateModelCache();
    return { id: docRef.id, ...payload };
}

export async function deleteModel(id: string): Promise<boolean> {
    const doc = await db.collection(COLLECTION).doc(id).get();
    if (!doc.exists) return false;
    await db.collection(COLLECTION).doc(id).delete();
    invalidateModelCache();
    return true;
}
