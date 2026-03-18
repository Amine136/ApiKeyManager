import { db } from '../lib/firebase.js';
import { TTLCache } from '../lib/cache.js';

const COLLECTION = 'providers';

// Caches
const listCache = new TTLCache<Provider[]>(5 * 60 * 1000);
const nameCache = new TTLCache<Provider>(5 * 60 * 1000);
const activeNameCache = new TTLCache<Provider | null>(5 * 60 * 1000);

export function invalidateProviderCache(): void {
    listCache.invalidate();
    nameCache.invalidate();
    activeNameCache.invalidate();
    import('./proxy.service.js').then(m => m.invalidateActiveProviderResolverCache()).catch(console.error);
}

export type ProviderType = 'google-gemini' | 'google-imagen' | 'openai' | 'custom';

export interface Provider {
    id?: string;
    name: string;
    displayName: string;
    type: ProviderType;
    baseUrl?: string;
    supportedModels: string[];
    isActive: boolean;
    createdAt?: Date;
    updatedAt?: Date;
}

export async function listProviders(): Promise<Provider[]> {
    const cached = listCache.get('all');
    if (cached) return cached;
    const snapshot = await db.collection(COLLECTION).get();
    const result = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() } as Provider));
    listCache.set('all', result);
    return result;
}

export async function getProvider(id: string): Promise<Provider | null> {
    const doc = await db.collection(COLLECTION).doc(id).get();
    if (!doc.exists) return null;
    return { id: doc.id, ...doc.data() } as Provider;
}

export async function getProviderByName(name: string): Promise<Provider | null> {
    const cached = nameCache.get(name);
    if (cached) return cached;
    const snapshot = await db
        .collection(COLLECTION)
        .where('name', '==', name)
        .limit(1)
        .get();
    if (snapshot.empty) return null;
    const doc = snapshot.docs[0];
    const result = { id: doc.id, ...doc.data() } as Provider;
    nameCache.set(name, result);
    return result;
}

export async function getActiveProviderByName(name: string): Promise<Provider | null> {
    const cached = activeNameCache.get(name);
    if (cached !== undefined) return cached;

    const snapshot = await db
        .collection(COLLECTION)
        .where('name', '==', name)
        .where('isActive', '==', true)
        .limit(1)
        .get();
    if (snapshot.empty) {
        activeNameCache.set(name, null);
        return null;
    }

    const doc = snapshot.docs[0];
    const result = { id: doc.id, ...doc.data() } as Provider;
    activeNameCache.set(name, result);
    return result;
}

export async function createProvider(data: Omit<Provider, 'id' | 'createdAt' | 'updatedAt'>): Promise<Provider> {
    const now = new Date();
    const docRef = await db.collection(COLLECTION).add({
        ...data,
        createdAt: now,
        updatedAt: now,
    });
    invalidateProviderCache();
    return { id: docRef.id, ...data, createdAt: now, updatedAt: now };
}

export async function updateProvider(id: string, data: Partial<Provider>): Promise<Provider | null> {
    const docRef = db.collection(COLLECTION).doc(id);
    const doc = await docRef.get();
    if (!doc.exists) return null;

    const updateData = { ...data, updatedAt: new Date() };
    delete updateData.id;
    delete updateData.createdAt;

    await docRef.update(updateData);
    invalidateProviderCache();
    return { id, ...doc.data(), ...updateData } as Provider;
}

export async function deleteProvider(id: string): Promise<boolean> {
    const doc = await db.collection(COLLECTION).doc(id).get();
    if (!doc.exists) return false;
    await db.collection(COLLECTION).doc(id).delete();
    invalidateProviderCache();
    return true;
}

export async function toggleProvider(id: string): Promise<Provider | null> {
    const docRef = db.collection(COLLECTION).doc(id);
    const doc = await docRef.get();
    if (!doc.exists) return null;

    const current = doc.data()!;
    const newActive = !current.isActive;
    await docRef.update({ isActive: newActive, updatedAt: new Date() });
    invalidateProviderCache();
    return { id, ...current, isActive: newActive } as Provider;
}
