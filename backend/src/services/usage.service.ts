import admin from 'firebase-admin';
import { db } from '../lib/firebase.js';
import { TTLCache } from '../lib/cache.js';

// Short-lived caches reduce repeated dashboard reads during active usage.
const statsCache = new TTLCache<any>(30 * 1000);
const recentLogsCache = new TTLCache<any[]>(30 * 1000);
const dashboardCache = new TTLCache<any>(30 * 1000);
const dashboardInFlight = new Map<DashboardRange, Promise<any>>();
const STORE_SUCCESS_USAGE_LOGS = false;

const COLLECTION = 'usageLogs';
const GLOBAL_COLLECTION = 'usageStatsGlobal';
const DAILY_COLLECTION = 'usageDailyStats';
const TEN_MIN_COLLECTION = 'usageTenMinuteStats';
const LEGACY_DAILY_KEY_COLLECTION = 'usageDailyKeyUsage';
const LEGACY_DAILY_MODEL_COLLECTION = 'usageDailyModelUsage';

const LATENCY_BUCKETS = [
    { key: 'lte50', upperBound: 50 },
    { key: 'lte100', upperBound: 100 },
    { key: 'lte250', upperBound: 250 },
    { key: 'lte500', upperBound: 500 },
    { key: 'lte1000', upperBound: 1000 },
    { key: 'gt1000', upperBound: 2000 },
] as const;

export interface UsageLog {
    id?: string;
    apiKeyId: string;
    clientId: string;
    model: string;
    providerName: string;
    status: 'success' | 'failed';
    statusCode: number;
    latencyMs: number;
    promptTokens?: number;
    completionTokens?: number;
    createdAt: Date;
}

type DashboardRange = '1h' | 'today' | '7d' | '30d';

function logUsageRead(event: string, details: Record<string, unknown>): void {
    console.info(`[USAGE_READ] ${event} ${JSON.stringify(details)}`);
}

function encodeAggregateKey(value: string): string {
    return Buffer.from(value).toString('base64url');
}

function decodeAggregateMap(value: Record<string, number> | undefined): Record<string, number> {
    if (!value) return {};

    return Object.fromEntries(
        Object.entries(value).map(([encoded, count]) => [
            Buffer.from(encoded, 'base64url').toString('utf8'),
            count,
        ])
    );
}

function decodeUsageCounterMap(
    value: Record<string, { requestCount?: number; tokenCount?: number }> | undefined,
    fieldName: 'apiKeyId' | 'model'
): Array<{ [key: string]: string | number; requestCount: number; tokenCount: number }> {
    if (!value) return [];

    return Object.entries(value).map(([encoded, counters]) => ({
        [fieldName]: Buffer.from(encoded, 'base64url').toString('utf8'),
        requestCount: counters?.requestCount ?? 0,
        tokenCount: counters?.tokenCount ?? 0,
    }));
}

function extractAggregateMapFromDoc(
    doc: Record<string, any>,
    fieldName: 'byProvider' | 'byModel'
): Record<string, number> {
    const nested = doc[fieldName];
    if (nested && typeof nested === 'object') {
        return decodeAggregateMap(nested);
    }

    const prefix = `${fieldName}.`;
    const encodedTotals = Object.entries(doc).reduce<Record<string, number>>((acc, [key, value]) => {
        if (!key.startsWith(prefix)) return acc;
        acc[key.slice(prefix.length)] = Number(value ?? 0);
        return acc;
    }, {});

    return decodeAggregateMap(encodedTotals);
}

function extractUsageCounterMapFromDoc(
    doc: Record<string, any>,
    fieldName: 'keyUsage' | 'modelUsage',
    resultField: 'apiKeyId' | 'model'
): Array<{ [key: string]: string | number; requestCount: number; tokenCount: number }> {
    const nested = doc[fieldName];
    if (nested && typeof nested === 'object') {
        return decodeUsageCounterMap(nested, resultField);
    }

    const prefix = `${fieldName}.`;
    const encodedTotals = Object.entries(doc).reduce<Record<string, { requestCount: number; tokenCount: number }>>((acc, [key, value]) => {
        if (!key.startsWith(prefix)) return acc;

        const remainder = key.slice(prefix.length);
        const lastDotIndex = remainder.lastIndexOf('.');
        if (lastDotIndex === -1) return acc;

        const encodedKey = remainder.slice(0, lastDotIndex);
        const counterField = remainder.slice(lastDotIndex + 1);
        if (!acc[encodedKey]) {
            acc[encodedKey] = { requestCount: 0, tokenCount: 0 };
        }

        if (counterField === 'requestCount' || counterField === 'tokenCount') {
            acc[encodedKey][counterField] = Number(value ?? 0);
        }

        return acc;
    }, {});

    return decodeUsageCounterMap(encodedTotals, resultField);
}

function sumAggregateMaps(
    docs: Array<Record<string, any>>,
    fieldName: 'byProvider' | 'byModel'
): Record<string, number> {
    const encodedTotals = docs.reduce<Record<string, number>>((acc, doc) => {
        const source = extractAggregateMapFromDoc(doc, fieldName);
        for (const [key, value] of Object.entries(source)) {
            const encodedKey = encodeAggregateKey(key);
            acc[encodedKey] = (acc[encodedKey] ?? 0) + Number(value ?? 0);
        }
        return acc;
    }, {});

    return decodeAggregateMap(encodedTotals);
}

function sumUsageCounterMaps(
    docs: Array<Record<string, any>>,
    fieldName: 'keyUsage' | 'modelUsage',
    resultField: 'apiKeyId' | 'model'
): Array<{ [key: string]: string | number; requestCount: number; tokenCount: number }> {
    const encodedTotals = docs.reduce<Record<string, { requestCount: number; tokenCount: number }>>((acc, doc) => {
        const source = extractUsageCounterMapFromDoc(doc, fieldName, resultField);
        for (const entry of source) {
            const rawKey = String(entry[resultField]);
            const encodedKey = encodeAggregateKey(rawKey);
            if (!acc[encodedKey]) {
                acc[encodedKey] = { requestCount: 0, tokenCount: 0 };
            }
            acc[encodedKey].requestCount += Number(entry.requestCount ?? 0);
            acc[encodedKey].tokenCount += Number(entry.tokenCount ?? 0);
        }
        return acc;
    }, {});

    return decodeUsageCounterMap(encodedTotals, resultField);
}

function getLatencyBucketKey(latencyMs: number): string {
    for (const bucket of LATENCY_BUCKETS) {
        if (latencyMs <= bucket.upperBound) return bucket.key;
    }
    return LATENCY_BUCKETS[LATENCY_BUCKETS.length - 1].key;
}

function approximateP95FromHistogram(histogram: Record<string, number> | undefined): number {
    if (!histogram) return 0;

    const total = Object.values(histogram).reduce((sum, value) => sum + value, 0);
    if (total === 0) return 0;

    const threshold = total * 0.95;
    let running = 0;

    for (const bucket of LATENCY_BUCKETS) {
        running += histogram[bucket.key] ?? 0;
        if (running >= threshold) {
            return bucket.upperBound;
        }
    }

    return LATENCY_BUCKETS[LATENCY_BUCKETS.length - 1].upperBound;
}

function startOfUtcDay(date: Date): Date {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function startOfTenMinuteBucket(date: Date): Date {
    return new Date(Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate(),
        date.getUTCHours(),
        Math.floor(date.getUTCMinutes() / 10) * 10,
        0,
        0
    ));
}

function formatDayId(date: Date): string {
    return startOfUtcDay(date).toISOString().slice(0, 10);
}

function formatTenMinuteId(date: Date): string {
    return startOfTenMinuteBucket(date).toISOString().slice(0, 16);
}

function getRangeStart(range: DashboardRange): Date {
    const now = new Date();

    if (range === '1h') {
        return new Date(now.getTime() - 60 * 60 * 1000);
    }

    if (range === 'today') {
        return startOfUtcDay(now);
    }

    if (range === '7d') {
        return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    }

    return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
}

function formatChartLabel(date: Date, range: DashboardRange): string {
    if (range === '1h' || range === 'today') {
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function buildEmptySeries(range: DashboardRange, now = new Date()): Date[] {
    const start = getRangeStart(range);
    const result: Date[] = [];

    if (range === '1h' || range === 'today') {
        const cursor = startOfTenMinuteBucket(start);
        while (cursor.getTime() <= now.getTime()) {
            result.push(new Date(cursor));
            cursor.setUTCMinutes(cursor.getUTCMinutes() + 10);
        }
        return result;
    }

    const cursor = startOfUtcDay(start);
    while (cursor.getTime() <= now.getTime()) {
        result.push(new Date(cursor));
        cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return result;
}

async function updateUsageAggregates(data: Omit<UsageLog, 'id'>): Promise<void> {
    const increment = admin.firestore.FieldValue.increment;
    const totalTokens = (data.promptTokens ?? 0) + (data.completionTokens ?? 0);
    const providerKey = encodeAggregateKey(data.providerName);
    const modelKey = encodeAggregateKey(data.model);
    const apiKeyAggregateKey = encodeAggregateKey(data.apiKeyId);
    const latencyBucketKey = getLatencyBucketKey(data.latencyMs ?? 0);
    const dayStart = startOfUtcDay(data.createdAt);
    const tenMinuteStart = startOfTenMinuteBucket(data.createdAt);
    const dayId = formatDayId(data.createdAt);
    const tenMinuteId = formatTenMinuteId(data.createdAt);

    const aggregatePayload = {
        totalRequests: increment(1),
        successCount: increment(data.status === 'success' ? 1 : 0),
        failedCount: increment(data.status === 'failed' ? 1 : 0),
        totalLatencyMs: increment(data.latencyMs ?? 0),
        totalTokens: increment(totalTokens),
        providerErrors: increment(data.statusCode >= 500 ? 1 : 0),
        exhaustedKeys: increment(data.statusCode === 429 ? 1 : 0),
        unauthorizedModel: increment(data.statusCode === 403 ? 1 : 0),
        [`latencyHistogram.${latencyBucketKey}`]: increment(1),
    };

    const writes: Promise<any>[] = [
        db.collection(GLOBAL_COLLECTION).doc('summary').set({
            ...aggregatePayload,
            [`byProvider.${providerKey}`]: increment(1),
            [`byModel.${modelKey}`]: increment(1),
            updatedAt: new Date(),
        }, { merge: true }),
        db.collection(DAILY_COLLECTION).doc(dayId).set({
            ...aggregatePayload,
            dayStart,
            updatedAt: new Date(),
            [`byProvider.${providerKey}`]: increment(1),
            [`byModel.${modelKey}`]: increment(1),
            ...(data.status === 'success' ? {
                [`keyUsage.${apiKeyAggregateKey}.requestCount`]: increment(1),
                [`keyUsage.${apiKeyAggregateKey}.tokenCount`]: increment(totalTokens),
                [`modelUsage.${modelKey}.requestCount`]: increment(1),
                [`modelUsage.${modelKey}.tokenCount`]: increment(totalTokens),
            } : {}),
        }, { merge: true }),
        db.collection(TEN_MIN_COLLECTION).doc(tenMinuteId).set({
            ...aggregatePayload,
            bucketStart: tenMinuteStart,
            updatedAt: new Date(),
            [`byProvider.${providerKey}`]: increment(1),
            [`byModel.${modelKey}`]: increment(1),
            ...(data.status === 'success' ? {
                [`keyUsage.${apiKeyAggregateKey}.requestCount`]: increment(1),
                [`keyUsage.${apiKeyAggregateKey}.tokenCount`]: increment(totalTokens),
                [`modelUsage.${modelKey}.requestCount`]: increment(1),
                [`modelUsage.${modelKey}.tokenCount`]: increment(totalTokens),
            } : {}),
        }, { merge: true }),
    ];

    await Promise.all(writes);
}

async function writeUsage(
    data: Omit<UsageLog, 'id'>,
    options?: { storeRawLog?: boolean }
): Promise<void> {
    const storedRawLog = options?.storeRawLog ?? (data.status === 'failed' || STORE_SUCCESS_USAGE_LOGS);
    if (storedRawLog) {
        await db.collection(COLLECTION).add(data);
    }
    await updateUsageAggregates(data);

    logUsageRead('write_usage', {
        rawLogCollection: storedRawLog ? COLLECTION : null,
        status: data.status,
        statusCode: data.statusCode,
        model: data.model,
        providerName: data.providerName,
    });

    statsCache.invalidate();
    if (storedRawLog) recentLogsCache.invalidate();
    dashboardCache.invalidate();
}

export async function logUsage(data: Omit<UsageLog, 'id'>): Promise<void> {
    await writeUsage(data);
}

export async function logUsageAggregateOnly(data: Omit<UsageLog, 'id'>): Promise<void> {
    await writeUsage(data, { storeRawLog: false });
}

export async function getLogs(filters?: {
    providerId?: string;
    status?: string;
    limit?: number;
}): Promise<UsageLog[]> {
    let query: FirebaseFirestore.Query = db.collection(COLLECTION);

    if (filters?.providerId) {
        query = query.where('providerName', '==', filters.providerId);
    }
    if (filters?.status) {
        query = query.where('status', '==', filters.status);
    }

    query = query.orderBy('createdAt', 'desc');
    query = query.limit(filters?.limit ?? 100);

    const isSimpleQuery = !filters?.providerId && !filters?.status && (filters?.limit ?? 100) <= 100;
    if (isSimpleQuery) {
        const cached = recentLogsCache.get('recent');
        if (cached) {
            logUsageRead('get_logs_cache_hit', {
                collection: COLLECTION,
                key: 'recent',
                docCount: cached.length,
                limit: filters?.limit ?? 100,
            });
            return cached;
        }
    }

    const snapshot = await query.get();
    const result = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() } as UsageLog));

    logUsageRead('get_logs_firestore_read', {
        collection: COLLECTION,
        docCount: snapshot.size,
        providerId: filters?.providerId ?? null,
        status: filters?.status ?? null,
        limit: filters?.limit ?? 100,
        cacheable: isSimpleQuery,
    });

    if (isSimpleQuery) recentLogsCache.set('recent', result);
    return result;
}

export async function getStats(): Promise<{
    totalRequests: number;
    successCount: number;
    failedCount: number;
    avgLatencyMs: number;
    byProvider: Record<string, number>;
    byModel: Record<string, number>;
    last24h: number;
}> {
    const cached = statsCache.get('stats');
    if (cached) {
        logUsageRead('get_stats_cache_hit', {
            collection: GLOBAL_COLLECTION,
            key: 'stats',
        });
        return cached;
    }

    const last24hStart = new Date(Date.now() - 86_400_000);
    const [globalDoc, last24hSnapshot] = await Promise.all([
        db.collection(GLOBAL_COLLECTION).doc('summary').get(),
        db.collection(TEN_MIN_COLLECTION)
            .where('bucketStart', '>=', last24hStart)
            .get(),
    ]);

    logUsageRead('get_stats_firestore_read', {
        collections: [GLOBAL_COLLECTION, TEN_MIN_COLLECTION],
        globalDocExists: globalDoc.exists,
        last24hBucketDocs: last24hSnapshot.size,
    });

    const globalData = globalDoc.data() ?? {};
    const totalRequests = globalData.totalRequests ?? 0;

    const result = {
        totalRequests,
        successCount: globalData.successCount ?? 0,
        failedCount: globalData.failedCount ?? 0,
        avgLatencyMs: totalRequests > 0 ? Math.round((globalData.totalLatencyMs ?? 0) / totalRequests) : 0,
        byProvider: decodeAggregateMap(globalData.byProvider),
        byModel: decodeAggregateMap(globalData.byModel),
        last24h: last24hSnapshot.docs.reduce((sum, doc) => sum + (doc.data().totalRequests ?? 0), 0),
    };

    statsCache.set('stats', result);
    return result;
}

export async function getDashboardData(range: DashboardRange): Promise<{
    rangeMetrics: {
        totalRequests: number;
        successCount: number;
        failedCount: number;
        successRate: number;
        failureRate: number;
        avgLatencyMs: number;
        p95LatencyMs: number;
        totalTokens: number;
        exhaustedKeys: number;
        unauthorizedModel: number;
        providerErrors: number;
    };
    chart: Array<{ label: string; requests: number }>;
    keyUsageToday: Array<{ apiKeyId: string; requestCount: number; tokenCount: number }>;
    modelUsageToday: Array<{ model: string; requestCount: number; tokenCount: number }>;
    providerTotals: Record<string, number>;
    modelTotals: Record<string, number>;
}> {
    const cached = dashboardCache.get(range);
    if (cached) {
        logUsageRead('get_dashboard_cache_hit', {
            range,
        });
        return cached;
    }

    const pending = dashboardInFlight.get(range);
    if (pending) {
        return pending;
    }
    const loadDashboard = (async () => {
        const now = new Date();
        const todayStart = startOfUtcDay(now);
        const tomorrowStart = new Date(todayStart.getTime() + 86_400_000);
        const rangeStart = getRangeStart(range);
        const useTenMinuteBuckets = range === '1h' || range === 'today';
        const todayId = formatDayId(now);

        const [globalDoc, bucketSnapshot, todayDailyDoc] = await Promise.all([
            db.collection(GLOBAL_COLLECTION).doc('summary').get(),
            useTenMinuteBuckets
                ? db.collection(TEN_MIN_COLLECTION).where('bucketStart', '>=', rangeStart).get()
                : db.collection(DAILY_COLLECTION).where('dayStart', '>=', startOfUtcDay(rangeStart)).get(),
            db.collection(DAILY_COLLECTION).doc(todayId).get(),
        ]);

        logUsageRead('get_dashboard_firestore_read', {
            range,
            collections: {
                global: GLOBAL_COLLECTION,
                buckets: useTenMinuteBuckets ? TEN_MIN_COLLECTION : DAILY_COLLECTION,
                dailyUsage: DAILY_COLLECTION,
            },
            docCounts: {
                globalDoc: globalDoc.exists ? 1 : 0,
                buckets: bucketSnapshot.size,
                dailyUsageDoc: todayDailyDoc.exists ? 1 : 0,
            },
        });

        const bucketDocs = bucketSnapshot.docs.map((doc) => doc.data());
        const totalRequests = bucketDocs.reduce((sum, doc) => sum + (doc.totalRequests ?? 0), 0);
        const successCount = bucketDocs.reduce((sum, doc) => sum + (doc.successCount ?? 0), 0);
        const failedCount = bucketDocs.reduce((sum, doc) => sum + (doc.failedCount ?? 0), 0);
        const totalLatencyMs = bucketDocs.reduce((sum, doc) => sum + (doc.totalLatencyMs ?? 0), 0);
        const totalTokens = bucketDocs.reduce((sum, doc) => sum + (doc.totalTokens ?? 0), 0);
        const exhaustedKeys = bucketDocs.reduce((sum, doc) => sum + (doc.exhaustedKeys ?? 0), 0);
        const unauthorizedModel = bucketDocs.reduce((sum, doc) => sum + (doc.unauthorizedModel ?? 0), 0);
        const providerErrors = bucketDocs.reduce((sum, doc) => sum + (doc.providerErrors ?? 0), 0);
        const latencyHistogram = bucketDocs.reduce<Record<string, number>>((acc, doc) => {
            const source = doc.latencyHistogram ?? {};
            for (const [key, value] of Object.entries(source)) {
                acc[key] = (acc[key] ?? 0) + Number(value ?? 0);
            }
            return acc;
        }, {});

        const bucketValueByTime = new Map<number, number>();
        for (const doc of bucketDocs) {
            const pointDate = useTenMinuteBuckets
                ? (doc.bucketStart?.toDate?.() ?? new Date(doc.bucketStart))
                : (doc.dayStart?.toDate?.() ?? new Date(doc.dayStart));
            bucketValueByTime.set(pointDate.getTime(), doc.totalRequests ?? 0);
        }

        const chart = buildEmptySeries(range, now).map((date) => ({
            label: formatChartLabel(date, range),
            requests: bucketValueByTime.get(date.getTime()) ?? 0,
        }));

        const globalData = globalDoc.data() ?? {};
        const todayData = todayDailyDoc.data() ?? {};
        let keyUsageToday = extractUsageCounterMapFromDoc(todayData, 'keyUsage', 'apiKeyId')
            .map((entry) => entry as { apiKeyId: string; requestCount: number; tokenCount: number });
        let modelUsageToday = extractUsageCounterMapFromDoc(todayData, 'modelUsage', 'model')
            .map((entry) => entry as { model: string; requestCount: number; tokenCount: number });

        if (keyUsageToday.length === 0 || modelUsageToday.length === 0) {
            const [legacyKeyUsageSnapshot, legacyModelUsageSnapshot] = await Promise.all([
                db.collection(LEGACY_DAILY_KEY_COLLECTION)
                    .where('dayStart', '>=', todayStart)
                    .where('dayStart', '<', tomorrowStart)
                    .get(),
                db.collection(LEGACY_DAILY_MODEL_COLLECTION)
                    .where('dayStart', '>=', todayStart)
                    .where('dayStart', '<', tomorrowStart)
                    .get(),
            ]);

            if (keyUsageToday.length === 0) {
                keyUsageToday = legacyKeyUsageSnapshot.docs
                    .map((doc) => doc.data() as { apiKeyId: string; requestCount: number; tokenCount: number });
            }
            if (modelUsageToday.length === 0) {
                modelUsageToday = legacyModelUsageSnapshot.docs
                    .map((doc) => doc.data() as { model: string; requestCount: number; tokenCount: number });
            }

            logUsageRead('get_dashboard_legacy_daily_usage_fallback', {
                range,
                keyUsageDocs: legacyKeyUsageSnapshot.size,
                modelUsageDocs: legacyModelUsageSnapshot.size,
            });
        }

        if ((keyUsageToday.length === 0 || modelUsageToday.length === 0) && useTenMinuteBuckets && range === 'today') {
            const todayBucketsSnapshot = await db
                .collection(TEN_MIN_COLLECTION)
                .where('bucketStart', '>=', todayStart)
                .where('bucketStart', '<', tomorrowStart)
                .get();
            const todayBucketDocs = todayBucketsSnapshot.docs.map((doc) => doc.data());

            if (keyUsageToday.length === 0) {
                keyUsageToday = sumUsageCounterMaps(todayBucketDocs, 'keyUsage', 'apiKeyId')
                    .map((entry) => entry as { apiKeyId: string; requestCount: number; tokenCount: number });
            }
            if (modelUsageToday.length === 0) {
                modelUsageToday = sumUsageCounterMaps(todayBucketDocs, 'modelUsage', 'model')
                    .map((entry) => entry as { model: string; requestCount: number; tokenCount: number });
            }

            logUsageRead('get_dashboard_bucket_daily_usage_fallback', {
                range,
                bucketDocs: todayBucketsSnapshot.size,
                keyUsageCount: keyUsageToday.length,
                modelUsageCount: modelUsageToday.length,
            });
        }

        const providerTotals = sumAggregateMaps(bucketDocs, 'byProvider');
        const modelTotals = sumAggregateMaps(bucketDocs, 'byModel');

        logUsageRead('get_dashboard_totals_source', {
            range,
            providerTotalsSource: Object.keys(providerTotals).length > 0 ? 'buckets' : 'global',
            modelTotalsSource: Object.keys(modelTotals).length > 0 ? 'buckets' : 'global',
            keyUsageCount: keyUsageToday.length,
            modelUsageCount: modelUsageToday.length,
        });

        const result = {
            rangeMetrics: {
                totalRequests,
                successCount,
                failedCount,
                successRate: totalRequests > 0 ? (successCount / totalRequests) * 100 : 0,
                failureRate: totalRequests > 0 ? (failedCount / totalRequests) * 100 : 0,
                avgLatencyMs: totalRequests > 0 ? Math.round(totalLatencyMs / totalRequests) : 0,
                p95LatencyMs: approximateP95FromHistogram(latencyHistogram),
                totalTokens,
                exhaustedKeys,
                unauthorizedModel,
                providerErrors,
            },
            chart,
            keyUsageToday: keyUsageToday
                .sort((a, b) => (b.requestCount ?? 0) - (a.requestCount ?? 0)),
            modelUsageToday: modelUsageToday
                .sort((a, b) => (b.requestCount ?? 0) - (a.requestCount ?? 0)),
            providerTotals: Object.keys(providerTotals).length > 0 ? providerTotals : decodeAggregateMap(globalData.byProvider),
            modelTotals: Object.keys(modelTotals).length > 0 ? modelTotals : decodeAggregateMap(globalData.byModel),
        };

        dashboardCache.set(range, result);
        return result;
    })().finally(() => {
        dashboardInFlight.delete(range);
    });

    dashboardInFlight.set(range, loadDashboard);
    return loadDashboard;
}
