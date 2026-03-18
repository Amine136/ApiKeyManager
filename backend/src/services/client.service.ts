import { db } from '../lib/firebase.js';
import { createHash, randomBytes } from 'crypto';

const COLLECTION = 'clients';

function invalidateClientAuthCache(): void {
    import('../middleware/auth.js').then((m) => m.invalidateClientCache()).catch(console.error);
}

async function invalidateClientSessions(clientId: string): Promise<void> {
    await import('../middleware/auth.js')
        .then((m) => m.invalidateAdminSessionsForClient(clientId))
        .catch(console.error);
}

function issueClientToken(): { plaintextToken: string; hashedToken: string } {
    const plaintextToken = randomBytes(32).toString('hex');
    const hashedToken = createHash('sha256').update(plaintextToken).digest('hex');
    return { plaintextToken, hashedToken };
}

export interface Client {
    id?: string;
    name: string;
    hashedToken: string;
    role: 'ADMIN' | 'CLIENT';
    isActive: boolean;
    revokedAt?: Date | null;
    expiresAt?: Date | null;
    lastUsedAt?: Date | null;
    lastRotatedAt?: Date | null;
    createdAt?: Date;
    updatedAt?: Date;
}

export async function listClients(): Promise<Client[]> {
    const snapshot = await db.collection(COLLECTION).get();
    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() } as Client));
}

export async function getClient(id: string): Promise<Client | null> {
    const doc = await db.collection(COLLECTION).doc(id).get();
    if (!doc.exists) return null;
    return { id: doc.id, ...doc.data() } as Client;
}

/**
 * Create a new client. Returns the client data AND the plaintext token (shown once).
 */
export async function createClient(data: {
    name: string;
    role: 'ADMIN' | 'CLIENT';
    expiresAt?: Date;
}): Promise<{ client: Client; plaintextToken: string }> {
    const { plaintextToken, hashedToken } = issueClientToken();
    const now = new Date();

    const clientData = {
        name: data.name,
        hashedToken,
        role: data.role,
        isActive: true,
        revokedAt: null,
        expiresAt: data.expiresAt ?? null,
        lastUsedAt: null,
        lastRotatedAt: now,
        createdAt: now,
        updatedAt: now,
    };

    const docRef = await db.collection(COLLECTION).add(clientData);
    invalidateClientAuthCache();
    return {
        client: { id: docRef.id, ...clientData },
        plaintextToken,
    };
}

export async function deleteClient(id: string): Promise<boolean> {
    const doc = await db.collection(COLLECTION).doc(id).get();
    if (!doc.exists) return false;
    await db.collection(COLLECTION).doc(id).delete();
    invalidateClientAuthCache();
    await invalidateClientSessions(id);
    return true;
}

export async function toggleClient(id: string): Promise<Client | null> {
    const docRef = db.collection(COLLECTION).doc(id);
    const doc = await docRef.get();
    if (!doc.exists) return null;

    const current = doc.data()!;
    const newActive = !current.isActive;
    await docRef.update({ isActive: newActive, updatedAt: new Date() });
    invalidateClientAuthCache();
    await invalidateClientSessions(id);
    return { id, ...current, isActive: newActive } as Client;
}

export async function revokeClient(id: string): Promise<Client | null> {
    const docRef = db.collection(COLLECTION).doc(id);
    const doc = await docRef.get();
    if (!doc.exists) return null;

    const current = doc.data()!;
    const revokedAt = new Date();
    await docRef.update({ revokedAt, updatedAt: revokedAt });
    invalidateClientAuthCache();
    await invalidateClientSessions(id);
    return { id, ...current, revokedAt, updatedAt: revokedAt } as Client;
}

export async function rotateClientToken(id: string): Promise<{ client: Client; plaintextToken: string } | null> {
    const docRef = db.collection(COLLECTION).doc(id);
    const doc = await docRef.get();
    if (!doc.exists) return null;

    const current = doc.data()!;
    const { plaintextToken, hashedToken } = issueClientToken();
    const now = new Date();
    const updateData = {
        hashedToken,
        revokedAt: null,
        lastUsedAt: null,
        lastRotatedAt: now,
        updatedAt: now,
    };

    await docRef.update(updateData);
    invalidateClientAuthCache();
    await invalidateClientSessions(id);

    return {
        client: { id, ...current, ...updateData } as Client,
        plaintextToken,
    };
}
