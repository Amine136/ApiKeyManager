import { FastifyRequest, FastifyReply } from 'fastify';
import { createHash, randomBytes } from 'crypto';
import { db } from '../lib/firebase.js';
import { TTLCache } from '../lib/cache.js';
import { RequestValidationError, validateLoginBody } from '../lib/request-validation.js';
import { env } from '../config/env.js';

export interface AuthenticatedClient {
    id: string;
    name: string;
    role: 'ADMIN' | 'CLIENT';
    isActive: boolean;
    revokedAt: Date | null;
    expiresAt: Date | null;
    lastUsedAt: Date | null;
}

// Cache clients by hashedToken for 5 minutes
const clientCache = new TTLCache<AuthenticatedClient>(5 * 60 * 1000);
const clientByIdCache = new TTLCache<AuthenticatedClient>(5 * 60 * 1000);
const adminSessionCache = new TTLCache<{
    clientId: string;
    role: 'ADMIN' | 'CLIENT';
    expiresAt: Date;
}>(60 * 1000);
const adminSessionInFlight = new Map<string, Promise<{
    clientId: string;
    role: 'ADMIN' | 'CLIENT';
    expiresAt: Date;
} | null>>();
const ADMIN_SESSION_COOKIE = 'admin_session';
const ADMIN_SESSION_TTL_SECONDS = 8 * 60 * 60;
const ADMIN_SESSIONS_COLLECTION = 'adminSessions';
const lastUsedWriteCache = new TTLCache<boolean>(env.CLIENT_LAST_USED_WRITE_INTERVAL_MS);

function logAuthRead(event: string, details: Record<string, unknown>): void {
    console.info(`[AUTH_READ] ${event} ${JSON.stringify(details)}`);
}

export function invalidateClientCache(): void {
    clientCache.invalidate();
    clientByIdCache.invalidate();
}

function invalidateAdminSessionCache(sessionId?: string): void {
    adminSessionCache.invalidate(sessionId);
    if (sessionId) {
        adminSessionInFlight.delete(sessionId);
    } else {
        adminSessionInFlight.clear();
    }
}

function parseCookies(header?: string): Record<string, string> {
    if (!header) return {};

    return header.split(';').reduce<Record<string, string>>((cookies, part) => {
        const [rawName, ...rawValue] = part.trim().split('=');
        if (!rawName) return cookies;
        cookies[rawName] = decodeURIComponent(rawValue.join('='));
        return cookies;
    }, {});
}

function buildSessionCookie(value: string, maxAgeSeconds: number): string {
    const secure = process.env.NODE_ENV === 'production';
    const parts = [
        `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(value)}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        `Max-Age=${maxAgeSeconds}`,
    ];

    if (secure) {
        parts.push('Secure');
    }

    return parts.join('; ');
}

function buildClearedSessionCookie(): string {
    const secure = process.env.NODE_ENV === 'production';
    const parts = [
        `${ADMIN_SESSION_COOKIE}=`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        'Max-Age=0',
    ];

    if (secure) {
        parts.push('Secure');
    }

    return parts.join('; ');
}

async function findClientByToken(token: string): Promise<AuthenticatedClient | null> {
    const hashedToken = createHash('sha256').update(token).digest('hex');

    const cached = clientCache.get(hashedToken);
    if (cached) {
        return cached;
    }

    const snapshot = await db
        .collection('clients')
        .where('hashedToken', '==', hashedToken)
        .limit(1)
        .get();

    if (snapshot.empty) {
        return null;
    }

    const doc = snapshot.docs[0];
    const data = doc.data();

    const client: AuthenticatedClient = {
        id: doc.id,
        name: data.name,
        role: data.role,
        isActive: data.isActive,
        revokedAt: normalizeDate(data.revokedAt),
        expiresAt: normalizeDate(data.expiresAt),
        lastUsedAt: normalizeDate(data.lastUsedAt),
    };

    clientCache.set(hashedToken, client);
    clientByIdCache.set(client.id, client);
    return client;
}

async function findClientById(clientId: string): Promise<AuthenticatedClient | null> {
    const cached = clientByIdCache.get(clientId);
    if (cached) {
        return cached;
    }

    const doc = await db.collection('clients').doc(clientId).get();
    if (!doc.exists) {
        return null;
    }

    const data = doc.data()!;
    const client: AuthenticatedClient = {
        id: doc.id,
        name: data.name,
        role: data.role,
        isActive: data.isActive,
        revokedAt: normalizeDate(data.revokedAt),
        expiresAt: normalizeDate(data.expiresAt),
        lastUsedAt: normalizeDate(data.lastUsedAt),
    };

    clientByIdCache.set(client.id, client);
    return client;
}

function normalizeDate(value: any): Date | null {
    if (!value) return null;
    if (value instanceof Date) return value;
    if (typeof value?.toDate === 'function') return value.toDate();
    return null;
}

function getClientAccessError(client: AuthenticatedClient): string | null {
    if (!client.isActive) {
        return 'Client is deactivated';
    }
    if (client.revokedAt) {
        return 'Token has been revoked';
    }
    if (client.expiresAt && client.expiresAt.getTime() <= Date.now()) {
        return 'Token has expired';
    }
    return null;
}

function touchClientLastUsed(clientId: string): void {
    const cacheKey = `last-used:${clientId}`;
    if (lastUsedWriteCache.get(cacheKey)) {
        return;
    }

    lastUsedWriteCache.set(cacheKey, true);
    db.collection('clients').doc(clientId).update({
        lastUsedAt: new Date(),
        updatedAt: new Date(),
    }).catch((err) => {
        console.error('[AUTH ERROR] Failed to update client lastUsedAt:', err);
        lastUsedWriteCache.invalidate(cacheKey);
    });
}

export async function invalidateAdminSessionsForClient(clientId: string): Promise<void> {
    const snapshot = await db
        .collection(ADMIN_SESSIONS_COLLECTION)
        .where('clientId', '==', clientId)
        .get();

    if (snapshot.empty) return;

    const batch = db.batch();
    for (const doc of snapshot.docs) {
        invalidateAdminSessionCache(doc.id);
        batch.delete(doc.ref);
    }
    await batch.commit();
}

// Extend Fastify request to carry authenticated client
declare module 'fastify' {
    interface FastifyRequest {
        client?: AuthenticatedClient;
    }
}

/**
 * Authenticate any valid bearer token (ADMIN or CLIENT).
 */
export async function authenticate(
    request: FastifyRequest,
    reply: FastifyReply
): Promise<void> {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        reply.code(401).send({ status: 'error', message: 'Missing or invalid Authorization header' });
        return;
    }

    const token = authHeader.slice(7).trim();
    const client = await findClientByToken(token);

    if (!client) {
        reply.code(401).send({ status: 'error', message: 'Invalid token' });
        return;
    }

    const accessError = getClientAccessError(client);
    if (accessError) {
        reply.code(accessError === 'Client is deactivated' ? 403 : 401).send({ status: 'error', message: accessError });
        return;
    }

    touchClientLastUsed(client.id);
    request.client = client;
}

export async function createAdminSession(
    request: FastifyRequest,
    reply: FastifyReply
): Promise<void> {
    let token: string;
    try {
        token = validateLoginBody(request.body).token;
    } catch (error) {
        if (error instanceof RequestValidationError) {
            reply.code(error.statusCode).send({ status: 'error', message: error.message });
            return;
        }
        throw error;
    }

    let client: AuthenticatedClient | null;
    try {
        client = await findClientByToken(token);
    } catch (err: any) {
        console.error('[AUTH ERROR] Database connection failed:', err);
        reply.code(500).send({ status: 'error', message: 'Database connection failed. Please try again.' });
        return;
    }

    if (!client) {
        reply.code(401).send({ status: 'error', message: 'Invalid token' });
        return;
    }

    const accessError = getClientAccessError(client);
    if (accessError) {
        reply.code(accessError === 'Client is deactivated' ? 403 : 401).send({ status: 'error', message: accessError });
        return;
    }

    if (client.role !== 'ADMIN') {
        reply.code(403).send({ status: 'error', message: 'Admin access required' });
        return;
    }

    const sessionId = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + ADMIN_SESSION_TTL_SECONDS * 1000);

    await db.collection(ADMIN_SESSIONS_COLLECTION).doc(sessionId).set({
        clientId: client.id,
        role: client.role,
        createdAt: new Date(),
        expiresAt,
    });

    adminSessionCache.set(sessionId, {
        clientId: client.id,
        role: client.role,
        expiresAt,
    });

    touchClientLastUsed(client.id);

    reply.header('Set-Cookie', buildSessionCookie(sessionId, ADMIN_SESSION_TTL_SECONDS));
    reply.send({
        status: 'success',
        data: {
            id: client.id,
            name: client.name,
            role: client.role,
        },
    });
}

export async function authenticateAdminSession(
    request: FastifyRequest,
    reply: FastifyReply
): Promise<void> {
    const cookies = parseCookies(request.headers.cookie);
    const sessionId = cookies[ADMIN_SESSION_COOKIE];

    if (!sessionId) {
        reply.code(401).send({ status: 'error', message: 'Admin session required' });
        return;
    }

    const cachedSession = adminSessionCache.get(sessionId);
    const session = cachedSession ?? await (() => {
        const pending = adminSessionInFlight.get(sessionId);
        if (pending) {
            return pending;
        }

        const loadSession = (async () => {
            const sessionDoc = await db.collection(ADMIN_SESSIONS_COLLECTION).doc(sessionId).get();
            logAuthRead('admin_session_firestore_read', {
                collection: ADMIN_SESSIONS_COLLECTION,
                sessionFound: sessionDoc.exists,
            });

            if (!sessionDoc.exists) {
                return null;
            }

            const data = sessionDoc.data()!;
            const expiresAt = normalizeDate(data.expiresAt);
            if (!expiresAt) {
                return null;
            }

            const hydratedSession = {
                clientId: data.clientId,
                role: data.role,
                expiresAt,
            };
            adminSessionCache.set(sessionId, hydratedSession);
            return hydratedSession;
        })().finally(() => {
            adminSessionInFlight.delete(sessionId);
        });

        adminSessionInFlight.set(sessionId, loadSession);
        return loadSession;
    })();

    if (cachedSession) {
        logAuthRead('admin_session_cache_hit', {
            collection: ADMIN_SESSIONS_COLLECTION,
            sessionFound: true,
        });
    }

    if (!session) {
        invalidateAdminSessionCache(sessionId);
        reply.code(401).send({ status: 'error', message: 'Admin session expired' });
        return;
    }

    const expiresAt = session.expiresAt;
    if (!expiresAt || expiresAt.getTime() <= Date.now()) {
        invalidateAdminSessionCache(sessionId);
        await db.collection(ADMIN_SESSIONS_COLLECTION).doc(sessionId).delete();
        reply.header('Set-Cookie', buildClearedSessionCookie());
        reply.code(401).send({ status: 'error', message: 'Admin session expired' });
        return;
    }

    if (session.role !== 'ADMIN') {
        invalidateAdminSessionCache(sessionId);
        await db.collection(ADMIN_SESSIONS_COLLECTION).doc(sessionId).delete();
        reply.header('Set-Cookie', buildClearedSessionCookie());
        reply.code(403).send({ status: 'error', message: 'Admin access required' });
        return;
    }

    const client = await findClientById(session.clientId);
    if (!client) {
        invalidateAdminSessionCache(sessionId);
        await db.collection(ADMIN_SESSIONS_COLLECTION).doc(sessionId).delete();
        reply.header('Set-Cookie', buildClearedSessionCookie());
        reply.code(401).send({ status: 'error', message: 'Admin session expired' });
        return;
    }

    const accessError = getClientAccessError(client);
    if (accessError || client.role !== 'ADMIN') {
        invalidateAdminSessionCache(sessionId);
        await db.collection(ADMIN_SESSIONS_COLLECTION).doc(sessionId).delete();
        reply.header('Set-Cookie', buildClearedSessionCookie());
        if (accessError) {
            reply.code(accessError === 'Client is deactivated' ? 403 : 401).send({ status: 'error', message: accessError });
            return;
        }
        reply.code(403).send({ status: 'error', message: 'Admin access required' });
        return;
    }

    request.client = client;
}

export async function destroyAdminSession(
    request: FastifyRequest,
    reply: FastifyReply
): Promise<void> {
    const cookies = parseCookies(request.headers.cookie);
    const sessionId = cookies[ADMIN_SESSION_COOKIE];
    if (sessionId) {
        invalidateAdminSessionCache(sessionId);
        await db.collection(ADMIN_SESSIONS_COLLECTION).doc(sessionId).delete();
    }
    reply.header('Set-Cookie', buildClearedSessionCookie());
    reply.send({ status: 'success' });
}

/**
 * Require ADMIN role (must be used after authenticate).
 */
export async function requireAdmin(
    request: FastifyRequest,
    reply: FastifyReply
): Promise<void> {
    if (!request.client) {
        reply.code(401).send({ status: 'error', message: 'Not authenticated' });
        return;
    }
    if (request.client.role !== 'ADMIN') {
        reply.code(403).send({ status: 'error', message: 'Admin access required' });
        return;
    }
}
