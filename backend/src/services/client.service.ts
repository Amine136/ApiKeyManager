import { db } from '../lib/firebase.js';
import { createHash, randomBytes } from 'crypto';
import { encrypt, decrypt } from '../lib/encryption.js';
import { lookup } from 'dns/promises';
import { isIP } from 'net';
import { RequestValidationError } from '../lib/request-validation.js';

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
    catalogWebhook?: {
        url: string;
        secretEncrypted: string;
        isEnabled: boolean;
        lastNotifiedAt?: Date | null;
        lastVersion?: string | null;
    } | null;
    createdAt?: Date;
    updatedAt?: Date;
}

export interface SafeClient extends Omit<Client, 'hashedToken' | 'catalogWebhook'> {
    hashedToken: '***';
    catalogWebhook?: {
        url: string;
        isEnabled: boolean;
        hasSecret: boolean;
        lastNotifiedAt?: Date | null;
        lastVersion?: string | null;
    } | null;
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

async function assertSafeWebhookUrl(rawUrl: string): Promise<string> {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:') {
        throw new RequestValidationError('catalogWebhook.url must use https');
    }
    if (parsed.username || parsed.password) {
        throw new RequestValidationError('catalogWebhook.url must not embed credentials');
    }
    if (isPrivateHostname(parsed.hostname) || isPrivateIpAddress(parsed.hostname)) {
        throw new RequestValidationError('catalogWebhook.url must not target private hosts or IP ranges');
    }

    const resolved = await lookup(parsed.hostname, { all: true });
    if (resolved.some((entry) => isPrivateIpAddress(entry.address))) {
        throw new RequestValidationError('catalogWebhook.url must not resolve to a private IP range');
    }

    return parsed.toString();
}

export function toSafeClient(client: Client): SafeClient {
    return {
        ...client,
        hashedToken: '***',
        catalogWebhook: client.catalogWebhook
            ? {
                url: client.catalogWebhook.url,
                isEnabled: client.catalogWebhook.isEnabled,
                hasSecret: Boolean(client.catalogWebhook.secretEncrypted),
                lastNotifiedAt: client.catalogWebhook.lastNotifiedAt ?? null,
                lastVersion: client.catalogWebhook.lastVersion ?? null,
            }
            : null,
    };
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
    catalogWebhook?: {
        url: string;
        secret: string;
    };
}): Promise<{ client: Client; plaintextToken: string }> {
    const { plaintextToken, hashedToken } = issueClientToken();
    const now = new Date();
    const catalogWebhook = data.catalogWebhook
        ? {
            url: await assertSafeWebhookUrl(data.catalogWebhook.url),
            secretEncrypted: encrypt(data.catalogWebhook.secret),
            isEnabled: true,
            lastNotifiedAt: null,
            lastVersion: null,
        }
        : null;

    const clientData = {
        name: data.name,
        hashedToken,
        role: data.role,
        isActive: true,
        revokedAt: null,
        expiresAt: data.expiresAt ?? null,
        lastUsedAt: null,
        lastRotatedAt: now,
        catalogWebhook,
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

export async function markCatalogWebhookDelivered(clientId: string, version: string, deliveredAt: Date): Promise<void> {
    await db.collection(COLLECTION).doc(clientId).update({
        'catalogWebhook.lastVersion': version,
        'catalogWebhook.lastNotifiedAt': deliveredAt,
        updatedAt: deliveredAt,
    });
}

export async function notifyCatalogWebhookSubscribers(payload: { version: string; updatedAt: Date }): Promise<void> {
    const clients = await listClients();
    const targets = clients.filter((client) =>
        client.role === 'CLIENT'
        && client.isActive
        && !client.revokedAt
        && client.catalogWebhook?.isEnabled
        && client.catalogWebhook.url
        && client.catalogWebhook.secretEncrypted
    );

    const results = await Promise.allSettled(targets.map(async (client) => {
        const webhook = client.catalogWebhook!;
        const response = await fetch(webhook.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Catalog-Webhook-Secret': decrypt(webhook.secretEncrypted),
            },
            body: JSON.stringify({
                version: payload.version,
                updated_at: payload.updatedAt.toISOString(),
            }),
        });

        if (!response.ok) {
            throw new Error(`Catalog webhook failed for client "${client.name}" with status ${response.status}`);
        }

        await markCatalogWebhookDelivered(client.id!, payload.version, payload.updatedAt);
    }));

    results.forEach((result, index) => {
        if (result.status === 'rejected') {
            console.error('[CATALOG_WEBHOOK] delivery_failed', {
                clientId: targets[index].id,
                clientName: targets[index].name,
                error: result.reason instanceof Error ? result.reason.message : String(result.reason),
            });
        }
    });
}
