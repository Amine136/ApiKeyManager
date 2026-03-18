import { db } from './firebase.js';

const COLLECTION = 'requestThrottleCounters';

function encodeKey(value: string): string {
    return Buffer.from(value).toString('base64url');
}

function getWindowStart(now: number, windowMs: number): number {
    return Math.floor(now / windowMs) * windowMs;
}

export async function consumeRateLimit(
    key: string,
    limit: number,
    windowMs: number
): Promise<{ allowed: boolean; remaining: number; retryAfterSeconds: number }> {
    const now = Date.now();
    const windowStart = getWindowStart(now, windowMs);
    const resetAt = windowStart + windowMs;
    const docId = encodeKey(`${key}:${windowMs}:${windowStart}`);
    const docRef = db.collection(COLLECTION).doc(docId);

    return db.runTransaction(async (tx) => {
        const snapshot = await tx.get(docRef);
        const currentCount = snapshot.exists ? Number(snapshot.data()?.count ?? 0) : 0;

        if (currentCount >= limit) {
            return {
                allowed: false,
                remaining: 0,
                retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)),
            };
        }

        tx.set(docRef, {
            key,
            count: currentCount + 1,
            windowMs,
            windowStart: new Date(windowStart),
            expiresAt: new Date(resetAt),
            updatedAt: new Date(),
        }, { merge: true });

        return {
            allowed: true,
            remaining: Math.max(limit - (currentCount + 1), 0),
            retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)),
        };
    });
}
