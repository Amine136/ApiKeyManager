import { db } from '../lib/firebase.js';
import { TTLCache } from '../lib/cache.js';
import { listProviders } from './provider.service.js';
import { listKeys } from './key.service.js';
import { listAllRules } from './keyModelRule.service.js';

const COLLECTION = 'models';
const listCache = new TTLCache<Model[]>(2 * 60 * 1000);
const byProviderCache = new TTLCache<Model[]>(2 * 60 * 1000);
const availableModelsCache = new TTLCache<AvailableModelSummary[]>(60 * 1000);
let listInFlight: Promise<Model[]> | null = null;
const byProviderInFlight = new Map<string, Promise<Model[]>>();
let availableModelsInFlight: Promise<AvailableModelSummary[]> | null = null;

function logModelRead(event: string, details: Record<string, unknown>): void {
    console.info(`[MODEL_READ] ${event} ${JSON.stringify(details)}`);
}

export function invalidateModelCache(): void {
    listCache.invalidate();
    byProviderCache.invalidate();
    availableModelsCache.invalidate();
    listInFlight = null;
    byProviderInFlight.clear();
    availableModelsInFlight = null;
}

export function invalidateAvailableModelsCache(): void {
    availableModelsCache.invalidate();
    availableModelsInFlight = null;
}

export interface Model {
    id?: string;
    name: string;        // e.g. "gemini-2.5-pro"
    displayName: string;
    providerId: string;
    cost?: string;
    description?: string;
    inputModalities?: Array<'TEXT' | 'IMAGE'>;
    outputModalities?: Array<'TEXT' | 'IMAGE'>;
    createdAt?: Date;
    updatedAt?: Date;
}

export interface AvailableModelSummary {
    id: string;
    name: string;
    displayName: string;
    cost?: string;
    description?: string;
    provider: {
        id: string;
        name: string;
        displayName: string;
        type: string;
    };
    inputModalities: Array<'TEXT' | 'IMAGE'>;
    outputModalities: Array<'TEXT' | 'IMAGE'>;
}

export interface AvailableModelCatalogEntry {
    provider: string;
    model_id: string;
    display_name: string;
    cost?: string;
    description?: string;
    input_modalities: Array<'TEXT' | 'IMAGE'>;
    output_modalities: Array<'TEXT' | 'IMAGE'>;
}

export interface AvailableModelCatalog {
    model_catalog: {
        text: Record<string, AvailableModelCatalogEntry>;
        image: Record<string, AvailableModelCatalogEntry>;
        multimodal: Record<string, AvailableModelCatalogEntry>;
    };
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

export async function getModelByNameAndProvider(name: string, providerId: string): Promise<Model | null> {
    const models = await listModelsByProvider(providerId);
    return models.find((model) => model.name === name) ?? null;
}

export async function createModel(
    data: Pick<Model, 'name' | 'displayName' | 'providerId' | 'cost' | 'description' | 'inputModalities' | 'outputModalities'>
): Promise<Model> {
    const now = new Date();
    const payload = { ...data, createdAt: now, updatedAt: now };
    const docRef = await db.collection(COLLECTION).add(payload);
    invalidateModelCache();
    return { id: docRef.id, ...payload };
}

export async function updateModel(
    id: string,
    data: Pick<Model, 'name' | 'displayName' | 'providerId' | 'cost' | 'description' | 'inputModalities' | 'outputModalities'>
): Promise<Model | null> {
    const docRef = db.collection(COLLECTION).doc(id);
    const doc = await docRef.get();
    if (!doc.exists) return null;

    const payload = {
        ...data,
        updatedAt: new Date(),
    };

    await docRef.update(payload);
    invalidateModelCache();
    return { id, ...doc.data(), ...payload } as Model;
}

export async function deleteModel(id: string): Promise<boolean> {
    const doc = await db.collection(COLLECTION).doc(id).get();
    if (!doc.exists) return false;
    await db.collection(COLLECTION).doc(id).delete();
    invalidateModelCache();
    return true;
}

function inferModelCapabilities(model: Model, providerType: string): {
    inputModalities: Array<'TEXT' | 'IMAGE'>;
    outputModalities: Array<'TEXT' | 'IMAGE'>;
} {
    if (providerType === 'google-imagen') {
        return { inputModalities: ['TEXT'], outputModalities: ['IMAGE'] };
    }

    if (providerType === 'google-gemini' && model.name.toLowerCase().includes('image')) {
        return { inputModalities: ['TEXT', 'IMAGE'], outputModalities: ['TEXT', 'IMAGE'] };
    }

    return { inputModalities: ['TEXT'], outputModalities: ['TEXT'] };
}

export async function listAvailableModels(): Promise<AvailableModelSummary[]> {
    const cached = availableModelsCache.get('all');
    if (cached) {
        logModelRead('list_available_models_cache_hit', { docCount: cached.length });
        return cached;
    }

    if (availableModelsInFlight) {
        return availableModelsInFlight;
    }

    availableModelsInFlight = (async () => {
        const [models, providers, keys, rules] = await Promise.all([
            listModels(),
            listProviders(),
            listKeys(),
            listAllRules(),
        ]);

        const activeProviders = providers.filter((provider) => provider.isActive && provider.id);
        const activeProviderIds = new Set(activeProviders.map((provider) => provider.id!));
        const activeKeys = keys.filter((key) => key.status === 'ACTIVE' && activeProviderIds.has(key.providerId));
        const keysByProvider = activeKeys.reduce<Record<string, typeof activeKeys>>((acc, key) => {
            if (!acc[key.providerId]) acc[key.providerId] = [];
            acc[key.providerId].push(key);
            return acc;
        }, {});

        const rulesByKeyId = rules.reduce<Record<string, typeof rules>>((acc, rule) => {
            if (!acc[rule.keyId]) acc[rule.keyId] = [];
            acc[rule.keyId].push(rule);
            return acc;
        }, {});

        const result = models
            .filter((model) => model.id && activeProviderIds.has(model.providerId))
            .filter((model) => {
                const provider = activeProviders.find((entry) => entry.id === model.providerId);
                if (!provider) return false;
                if (provider.supportedModels.length > 0 && !provider.supportedModels.includes(model.name)) {
                    return false;
                }

                const providerKeys = keysByProvider[model.providerId] ?? [];
                if (providerKeys.length === 0) return false;

                return providerKeys.some((key) => {
                    const keyRules = rulesByKeyId[key.id!] ?? [];
                    return keyRules.length === 0 || keyRules.some((rule) => rule.modelName === model.name);
                });
            })
            .map((model) => {
                const provider = activeProviders.find((entry) => entry.id === model.providerId)!;
                const inferred = inferModelCapabilities(model, provider.type);
                return {
                    id: model.id!,
                    name: model.name,
                    displayName: model.displayName || model.name,
                    cost: model.cost,
                    description: model.description,
                    provider: {
                        id: provider.id!,
                        name: provider.name,
                        displayName: provider.displayName,
                        type: provider.type,
                    },
                    inputModalities: model.inputModalities ?? inferred.inputModalities,
                    outputModalities: model.outputModalities ?? inferred.outputModalities,
                } satisfies AvailableModelSummary;
            })
            .sort((a, b) => a.displayName.localeCompare(b.displayName));

        logModelRead('list_available_models_resolved', { docCount: result.length });
        availableModelsCache.set('all', result);
        return result;
    })().finally(() => {
        availableModelsInFlight = null;
    });

    return availableModelsInFlight;
}

function classifyAvailableModel(model: AvailableModelSummary): 'text' | 'image' | 'multimodal' {
    const outputs = new Set(model.outputModalities);
    if (outputs.has('IMAGE') && outputs.has('TEXT')) {
        return 'multimodal';
    }
    if (outputs.has('IMAGE')) {
        return 'image';
    }
    return 'text';
}

export async function getAvailableModelCatalog(): Promise<AvailableModelCatalog> {
    const models = await listAvailableModels();
    const catalog: AvailableModelCatalog = {
        model_catalog: {
            text: {},
            image: {},
            multimodal: {},
        },
    };

    for (const model of models) {
        const bucket = classifyAvailableModel(model);
        catalog.model_catalog[bucket][model.name] = {
            provider: model.provider.type,
            model_id: model.name,
            display_name: model.displayName,
            cost: model.cost,
            description: model.description,
            input_modalities: model.inputModalities,
            output_modalities: model.outputModalities,
        };
    }

    return catalog;
}
