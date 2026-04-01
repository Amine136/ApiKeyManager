'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '../../context/AuthContext';
import { api } from '../../services/api';
import { Skeleton } from '../../components/Skeleton';

interface Rule {
    id: string;
    keyId: string;
    modelId: string;
    modelName: string;
    rules: Record<string, number>;
}

interface ApiKey {
    id: string;
    label: string;
    providerId: string;
}

interface Model {
    id: string;
    name: string;
    displayName: string;
    providerId: string;
}

interface UsageLog {
    id: string;
    apiKeyId: string;
    model: string;
    promptTokens?: number;
    completionTokens?: number;
    createdAt: string | { _seconds?: number; seconds?: number; toDate?: () => Date } | Date;
}

interface BubblePosition {
    x: number;
    y: number;
}

interface DragPayload {
    side: 'key' | 'model';
    ids: string[];
    anchorId: string;
}

type FocusedBubble =
    | { side: 'key'; id: string }
    | { side: 'model'; id: string }
    | null;

type TooltipState = {
    x: number;
    y: number;
    rule: Rule;
    usagePercent: number;
    lineClass: 'healthy' | 'warning' | 'danger';
} | null;

const EMPTY_RATE_LIMITS = {
    maxRequestsPerMinute: '',
    maxRequestsPerHour: '',
    maxRequestsPerDay: '',
    maxTokensPerMinute: '',
    maxTokensPerDay: '',
    cooldownSeconds: '',
};

function normalizeDate(value: UsageLog['createdAt']): Date | null {
    if (!value) return null;
    if (value instanceof Date) return value;
    if (typeof value === 'string') return new Date(value);
    if (typeof value.toDate === 'function') return value.toDate();
    if (typeof value._seconds === 'number') return new Date(value._seconds * 1000);
    if (typeof value.seconds === 'number') return new Date(value.seconds * 1000);
    return null;
}

function usageClass(percent: number): 'healthy' | 'warning' | 'danger' {
    if (percent >= 1) return 'danger';
    if (percent >= 0.7) return 'warning';
    return 'healthy';
}

function formatRuleLimits(rule: Rule): string {
    if (!rule.rules || Object.keys(rule.rules).length === 0) return 'No limits';

    return Object.entries(rule.rules)
        .map(([key, value]) => `${key}: ${value}`)
        .join(' · ');
}

function getSingleProviderId(providerIds: string[]): string | null {
    const unique = Array.from(new Set(providerIds.filter(Boolean)));
    return unique.length === 1 ? unique[0] : null;
}

export default function RulesPage() {
    const { isAuthenticated, isLoading } = useAuth();
    const router = useRouter();

    const [rules, setRules] = useState<Rule[]>([]);
    const [keys, setKeys] = useState<ApiKey[]>([]);
    const [models, setModels] = useState<Model[]>([]);
    const [usageLogs, setUsageLogs] = useState<UsageLog[]>([]);
    const [loading, setLoading] = useState(true);
    const [showModal, setShowModal] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
    const [selectedLineId, setSelectedLineId] = useState<string | null>(null);
    const [focusedBubble, setFocusedBubble] = useState<FocusedBubble>(null);
    const [hoveredTooltip, setHoveredTooltip] = useState<TooltipState>(null);
    const [dragPayload, setDragPayload] = useState<DragPayload | null>(null);

    const [selectedKeyIds, setSelectedKeyIds] = useState<Set<string>>(new Set());
    const [selectedModelIds, setSelectedModelIds] = useState<Set<string>>(new Set());
    const [rateLimits, setRateLimits] = useState(EMPTY_RATE_LIMITS);

    const workspaceRef = useRef<HTMLDivElement | null>(null);
    const keyRefs = useRef<Record<string, HTMLButtonElement | null>>({});
    const modelRefs = useRef<Record<string, HTMLButtonElement | null>>({});
    const [positions, setPositions] = useState<{
        keys: Record<string, BubblePosition>;
        models: Record<string, BubblePosition>;
    }>({ keys: {}, models: {} });

    useEffect(() => {
        if (!isLoading && !isAuthenticated) router.push('/login');
    }, [isAuthenticated, isLoading, router]);

    useEffect(() => {
        if (isAuthenticated) loadData();
    }, [isAuthenticated]);

    useEffect(() => {
        const measure = () => {
            if (!workspaceRef.current) return;

            const frame = window.requestAnimationFrame(() => {
                if (!workspaceRef.current) return;
                const workspaceRect = workspaceRef.current.getBoundingClientRect();
                const nextKeys: Record<string, BubblePosition> = {};
                const nextModels: Record<string, BubblePosition> = {};

                for (const key of keys) {
                    const node = keyRefs.current[key.id];
                    if (!node) continue;
                    const rect = node.getBoundingClientRect();
                    nextKeys[key.id] = {
                        x: rect.right - workspaceRect.left,
                        y: rect.top - workspaceRect.top + rect.height / 2,
                    };
                }

                for (const model of models) {
                    const node = modelRefs.current[model.id];
                    if (!node) continue;
                    const rect = node.getBoundingClientRect();
                    nextModels[model.id] = {
                        x: rect.left - workspaceRect.left,
                        y: rect.top - workspaceRect.top + rect.height / 2,
                    };
                }

                setPositions({ keys: nextKeys, models: nextModels });
            });

            return () => window.cancelAnimationFrame(frame);
        };

        const cleanup = measure();
        window.addEventListener('resize', measure);
        window.addEventListener('scroll', measure, true);

        return () => {
            cleanup?.();
            window.removeEventListener('resize', measure);
            window.removeEventListener('scroll', measure, true);
        };
    }, [keys, models, loading]);

    const loadData = async () => {
        try {
            const [rulesRes, keysRes, modelsRes, usageRes] = await Promise.all([
                api.getKeyModelRules(),
                api.getKeys(),
                api.getModels(),
                api.getUsageLogs({ limit: '500' }),
            ]);

            setRules(rulesRes.data);
            setKeys(keysRes.data);
            setModels(modelsRes.data);
            setUsageLogs(usageRes.data);
        } catch (e) {
            console.error(e);
        } finally {
            setLoading(false);
        }
    };

    const keyLabelById = useMemo(
        () => Object.fromEntries(keys.map((key) => [key.id, key.label])),
        [keys]
    );

    const modelNameById = useMemo(
        () => Object.fromEntries(models.map((model) => [model.id, model.displayName || model.name])),
        [models]
    );

    const keyById = useMemo(
        () => Object.fromEntries(keys.map((key) => [key.id, key])),
        [keys]
    );

    const modelById = useMemo(
        () => Object.fromEntries(models.map((model) => [model.id, model])),
        [models]
    );

    const selectionProviderId = useMemo(() => {
        const providerIds = [
            ...Array.from(selectedKeyIds).map((id) => keyById[id]?.providerId).filter(Boolean),
            ...Array.from(selectedModelIds).map((id) => modelById[id]?.providerId).filter(Boolean),
        ] as string[];

        return getSingleProviderId(providerIds);
    }, [selectedKeyIds, selectedModelIds, keyById, modelById]);

    const ruleUsage = useMemo(() => {
        const oneDayAgo = Date.now() - 86_400_000;

        return Object.fromEntries(
            rules.map((rule) => {
                const relatedLogs = usageLogs.filter((log) => {
                    const createdAt = normalizeDate(log.createdAt);
                    return (
                        log.apiKeyId === rule.keyId &&
                        log.model === rule.modelName &&
                        createdAt &&
                        createdAt.getTime() >= oneDayAgo
                    );
                });

                const requestCount = relatedLogs.length;
                const tokenCount = relatedLogs.reduce(
                    (sum, log) => sum + (log.promptTokens ?? 0) + (log.completionTokens ?? 0),
                    0
                );

                const requestDailyPercent = rule.rules.maxRequestsPerDay
                    ? requestCount / rule.rules.maxRequestsPerDay
                    : 0;
                const tokenDailyPercent = rule.rules.maxTokensPerDay
                    ? tokenCount / rule.rules.maxTokensPerDay
                    : 0;
                const usagePercent = Math.max(requestDailyPercent, tokenDailyPercent, 0);

                return [
                    rule.id,
                    {
                        requestCount,
                        tokenCount,
                        usagePercent,
                        lineClass: usageClass(usagePercent),
                    },
                ];
            })
        );
    }, [rules, usageLogs]);

    const bubbleUsage = useMemo(() => {
        const keyUsage: Record<string, number> = {};
        const modelUsage: Record<string, number> = {};

        for (const rule of rules) {
            const usagePercent = ruleUsage[rule.id]?.usagePercent ?? 0;
            keyUsage[rule.keyId] = Math.max(keyUsage[rule.keyId] ?? 0, usagePercent);
            modelUsage[rule.modelId] = Math.max(modelUsage[rule.modelId] ?? 0, usagePercent);
        }

        return { keyUsage, modelUsage };
    }, [rules, ruleUsage]);

    const connectedRuleIds = useMemo(() => {
        if (!focusedBubble) return new Set<string>();

        return new Set(
            rules
                .filter((rule) =>
                    focusedBubble.side === 'key' ? rule.keyId === focusedBubble.id : rule.modelId === focusedBubble.id
                )
                .map((rule) => rule.id)
        );
    }, [focusedBubble, rules]);

    const linkedBubbleIds = useMemo(() => {
        const keyIds = new Set<string>();
        const modelIds = new Set<string>();

        if (focusedBubble) {
            for (const rule of rules) {
                const isConnected = focusedBubble.side === 'key'
                    ? rule.keyId === focusedBubble.id
                    : rule.modelId === focusedBubble.id;

                if (!isConnected) continue;
                keyIds.add(rule.keyId);
                modelIds.add(rule.modelId);
            }
        }

        if (selectedLineId) {
            const rule = rules.find((item) => item.id === selectedLineId);
            if (rule) {
                keyIds.add(rule.keyId);
                modelIds.add(rule.modelId);
            }
        }

        return { keyIds, modelIds };
    }, [focusedBubble, rules, selectedLineId]);

    const canvasRules = useMemo(() => {
        return rules
            .filter((rule) => positions.keys[rule.keyId] && positions.models[rule.modelId])
            .map((rule) => {
                const start = positions.keys[rule.keyId];
                const end = positions.models[rule.modelId];
                const delta = Math.max((end.x - start.x) * 0.35, 80);
                const path = `M ${start.x} ${start.y} C ${start.x + delta} ${start.y}, ${end.x - delta} ${end.y}, ${end.x} ${end.y}`;
                const usage = ruleUsage[rule.id] ?? { requestCount: 0, tokenCount: 0, usagePercent: 0, lineClass: 'healthy' as const };

                return {
                    rule,
                    path,
                    start,
                    end,
                    usage,
                    isHighlighted: connectedRuleIds.has(rule.id) || selectedLineId === rule.id,
                };
            });
    }, [rules, positions, ruleUsage, connectedRuleIds, selectedLineId]);

    const totalCombinations = selectedKeyIds.size * selectedModelIds.size;

    const selectedRule = rules.find((rule) => rule.id === selectedLineId) ?? null;
    const editingRule = rules.find((rule) => rule.id === editingRuleId) ?? null;
    const focusedRules = focusedBubble
        ? rules.filter((rule) => (focusedBubble.side === 'key' ? rule.keyId === focusedBubble.id : rule.modelId === focusedBubble.id))
        : [];

    const resetModalState = () => {
        setShowModal(false);
        setEditingRuleId(null);
        setSelectedKeyIds(new Set());
        setSelectedModelIds(new Set());
        setRateLimits(EMPTY_RATE_LIMITS);
    };

    const openCreateModal = (keyIds: string[], modelIds: string[], ruleToEdit?: Rule) => {
        const providerId = getSingleProviderId([
            ...keyIds.map((id) => keyById[id]?.providerId).filter(Boolean),
            ...modelIds.map((id) => modelById[id]?.providerId).filter(Boolean),
        ] as string[]);

        if ((keyIds.length > 0 || modelIds.length > 0) && !providerId && !ruleToEdit) {
            alert('API keys and models must belong to the same provider');
            return;
        }

        setSelectedKeyIds(new Set(keyIds));
        setSelectedModelIds(new Set(modelIds));
        setEditingRuleId(ruleToEdit?.id ?? null);
        setRateLimits({
            maxRequestsPerMinute: ruleToEdit?.rules.maxRequestsPerMinute?.toString() ?? '',
            maxRequestsPerHour: ruleToEdit?.rules.maxRequestsPerHour?.toString() ?? '',
            maxRequestsPerDay: ruleToEdit?.rules.maxRequestsPerDay?.toString() ?? '',
            maxTokensPerMinute: ruleToEdit?.rules.maxTokensPerMinute?.toString() ?? '',
            maxTokensPerDay: ruleToEdit?.rules.maxTokensPerDay?.toString() ?? '',
            cooldownSeconds: ruleToEdit?.rules.cooldownSeconds?.toString() ?? '',
        });
        setShowModal(true);
    };

    const handleBubbleClick = (
        side: 'key' | 'model',
        id: string,
        event: React.MouseEvent<HTMLButtonElement>
    ) => {
        if (event.shiftKey) {
            if (side === 'key') {
                setSelectedKeyIds((prev) => {
                    const next = new Set(prev);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                });
            } else {
                setSelectedModelIds((prev) => {
                    const next = new Set(prev);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                });
            }
            return;
        }

        setSelectedLineId(null);
        setFocusedBubble((prev) => (prev?.side === side && prev.id === id ? null : { side, id }));
    };

    const handleDragStart = (side: 'key' | 'model', id: string) => {
        const selectedIds = side === 'key' ? selectedKeyIds : selectedModelIds;
        const currentProviderId = side === 'key' ? keyById[id]?.providerId : modelById[id]?.providerId;
        const ids = selectedIds.has(id) && selectedIds.size > 0
            ? Array.from(selectedIds).filter((selectedId) => {
                const providerId = side === 'key' ? keyById[selectedId]?.providerId : modelById[selectedId]?.providerId;
                return providerId === currentProviderId;
            })
            : [id];
        setDragPayload({ side, ids, anchorId: id });
    };

    const handleDrop = (targetSide: 'key' | 'model', targetId: string) => {
        if (!dragPayload || dragPayload.side === targetSide) return;

        const keyIds = dragPayload.side === 'key'
            ? dragPayload.ids
            : selectedKeyIds.has(targetId) && selectedKeyIds.size > 0
                ? Array.from(selectedKeyIds)
                : [targetId];

        const modelIds = dragPayload.side === 'model'
            ? dragPayload.ids
            : selectedModelIds.has(targetId) && selectedModelIds.size > 0
                ? Array.from(selectedModelIds)
                : [targetId];

        const providerId = getSingleProviderId([
            ...keyIds.map((id) => keyById[id]?.providerId).filter(Boolean),
            ...modelIds.map((id) => modelById[id]?.providerId).filter(Boolean),
        ] as string[]);

        if (!providerId) {
            alert('API keys and models must belong to the same provider');
            setDragPayload(null);
            return;
        }

        openCreateModal(keyIds, modelIds);
        setDragPayload(null);
    };

    const handleSubmit = async (event: React.FormEvent) => {
        event.preventDefault();
        if (!editingRuleId && selectedKeyIds.size === 0) {
            alert('Select at least one API key');
            return;
        }
        if (!editingRuleId && selectedModelIds.size === 0) {
            alert('Select at least one model');
            return;
        }

        const ruleData: Record<string, number> = {};
        if (rateLimits.maxRequestsPerMinute) ruleData.maxRequestsPerMinute = +rateLimits.maxRequestsPerMinute;
        if (rateLimits.maxRequestsPerHour) ruleData.maxRequestsPerHour = +rateLimits.maxRequestsPerHour;
        if (rateLimits.maxRequestsPerDay) ruleData.maxRequestsPerDay = +rateLimits.maxRequestsPerDay;
        if (rateLimits.maxTokensPerMinute) ruleData.maxTokensPerMinute = +rateLimits.maxTokensPerMinute;
        if (rateLimits.maxTokensPerDay) ruleData.maxTokensPerDay = +rateLimits.maxTokensPerDay;
        if (rateLimits.cooldownSeconds) ruleData.cooldownSeconds = +rateLimits.cooldownSeconds;

        const selectedProviderIds = [
            ...Array.from(selectedKeyIds).map((id) => keyById[id]?.providerId).filter(Boolean),
            ...Array.from(selectedModelIds).map((id) => modelById[id]?.providerId).filter(Boolean),
        ] as string[];

        if (!editingRuleId && !getSingleProviderId(selectedProviderIds)) {
            alert('API keys and models must belong to the same provider');
            return;
        }

        setSubmitting(true);

        try {
            if (editingRuleId) {
                if (!editingRule) {
                    throw new Error('Rule not found');
                }

                await api.deleteKeyModelRule(editingRuleId);

                const response = await api.bulkCreateKeyModelRules({
                    keyIds: [editingRule.keyId],
                    models: [{ id: editingRule.modelId, name: editingRule.modelName }],
                    rules: ruleData,
                });

                resetModalState();
                alert(response.message || 'Rule updated');
                await loadData();
                return;
            }

            const selectedModels = models
                .filter((model) => selectedModelIds.has(model.id))
                .map((model) => ({ id: model.id, name: model.name }));

            const response = await api.bulkCreateKeyModelRules({
                keyIds: Array.from(selectedKeyIds),
                models: selectedModels,
                rules: ruleData,
            });

            resetModalState();
            alert(response.message || `Created ${response.data.created} rules`);
            await loadData();
        } catch (error: any) {
            alert(error.message);
        } finally {
            setSubmitting(false);
        }
    };

    const handleDelete = async (ruleId: string) => {
        try {
            await api.deleteKeyModelRule(ruleId);
            if (selectedLineId === ruleId) setSelectedLineId(null);
            await loadData();
        } catch (error: any) {
            alert(error.message);
        }
    };

    if (isLoading || !isAuthenticated) return null;

    return (
        <div className="rules-page">
            <div className="page-header flex-between">
                <div>
                    <h1>Rules</h1>
                    <p>Map API keys to models visually. Drag to create, click to inspect, keep the old modal flow as backup.</p>
                </div>
                <div className="rules-header-actions">
                    <div className="rules-hint">Shift+click to multi-select bubbles before dragging</div>
                    <button className="btn btn-primary" onClick={() => openCreateModal([], [])}>+ Add Rules</button>
                </div>
            </div>

            <div className="rules-dashboard-grid">
                <section className="card rules-workspace-card">
                    <div className="rules-workspace-header">
                        <div>
                            <h3>Rule Graph</h3>
                            <p>{rules.length} active connection{rules.length !== 1 ? 's' : ''}</p>
                        </div>
                        <div className="rules-legend">
                            <span><i className="healthy" /> Healthy</span>
                            <span><i className="warning" /> Near daily limit</span>
                            <span><i className="danger" /> Exhausted</span>
                        </div>
                    </div>

                    <div className="rules-workspace" ref={workspaceRef}>
                        {loading ? (
                            <div className="rules-columns">
                                <div className="rules-column">
                                    <h4>API Keys</h4>
                                    {Array.from({ length: 4 }).map((_, index) => (
                                        <div key={index} className="rules-bubble-skeleton">
                                            <Skeleton width="170px" height={74} borderRadius={999} />
                                        </div>
                                    ))}
                                </div>
                                <div className="rules-column">
                                    <h4>Models</h4>
                                    {Array.from({ length: 4 }).map((_, index) => (
                                        <div key={index} className="rules-bubble-skeleton">
                                            <Skeleton width="170px" height={74} borderRadius={999} />
                                        </div>
                                    ))}
                                </div>
                            </div>
                        ) : (
                            <>
                                <svg className="rules-lines-layer" aria-hidden="true">
                                    {canvasRules.map(({ rule, path, usage, start, end, isHighlighted }) => (
                                        <g key={rule.id}>
                                            <path
                                                d={path}
                                                className={`rules-line-hitbox ${selectedLineId === rule.id ? 'selected' : ''}`}
                                                onMouseEnter={() => {
                                                    setHoveredTooltip({
                                                        x: (start.x + end.x) / 2,
                                                        y: (start.y + end.y) / 2,
                                                        rule,
                                                        usagePercent: usage.usagePercent,
                                                        lineClass: usage.lineClass,
                                                    });
                                                }}
                                                onMouseLeave={() => setHoveredTooltip(null)}
                                                onClick={() => {
                                                    setFocusedBubble(null);
                                                    setSelectedLineId(rule.id);
                                                }}
                                            />
                                            <path
                                                d={path}
                                                className={`rules-line ${usage.lineClass} ${isHighlighted ? 'highlighted' : ''} ${selectedLineId === rule.id ? 'selected' : ''}`}
                                            />
                                        </g>
                                    ))}
                                </svg>

                                <div className="rules-columns">
                                    <div className="rules-column">
                                        <h4>API Keys</h4>
                                        {keys.map((key) => {
                                            const usagePercent = bubbleUsage.keyUsage[key.id] ?? 0;
                                            const bubbleState = usageClass(usagePercent);
                                            const isLinked = linkedBubbleIds.keyIds.has(key.id);
                                            const isSelected = selectedKeyIds.has(key.id);

                                            return (
                                                <div
                                                    key={key.id}
                                                    className={`rules-bubble-shell ${bubbleState} ${isLinked ? 'linked' : ''} ${isSelected ? 'selected' : ''}`}
                                                    style={{ ['--usage-angle' as string]: `${Math.min(usagePercent, 1) * 360}deg` }}
                                                >
                                                    <button
                                                        ref={(node) => { keyRefs.current[key.id] = node; }}
                                                        className={`rules-bubble ${focusedBubble?.side === 'key' && focusedBubble.id === key.id ? 'focused' : ''}`}
                                                        draggable
                                                        onClick={(event) => handleBubbleClick('key', key.id, event)}
                                                        onDragStart={(event) => {
                                                            handleDragStart('key', key.id);
                                                            event.dataTransfer.effectAllowed = 'copy';
                                                        }}
                                                        onDragEnd={() => setDragPayload(null)}
                                                        onDragOver={(event) => event.preventDefault()}
                                                        onDrop={(event) => {
                                                            event.preventDefault();
                                                            handleDrop('key', key.id);
                                                        }}
                                                    >
                                                        <span className="rules-bubble-label">{key.label}</span>
                                                        <span className="rules-bubble-meta">
                                                            {rules.filter((rule) => rule.keyId === key.id).length} rule{rules.filter((rule) => rule.keyId === key.id).length !== 1 ? 's' : ''}
                                                        </span>
                                                    </button>
                                                </div>
                                            );
                                        })}
                                    </div>

                                    <div className="rules-column">
                                        <h4>Models</h4>
                                        {models.map((model) => {
                                            const usagePercent = bubbleUsage.modelUsage[model.id] ?? 0;
                                            const bubbleState = usageClass(usagePercent);
                                            const isLinked = linkedBubbleIds.modelIds.has(model.id);
                                            const isSelected = selectedModelIds.has(model.id);

                                            return (
                                                <div
                                                    key={model.id}
                                                    className={`rules-bubble-shell ${bubbleState} ${isLinked ? 'linked' : ''} ${isSelected ? 'selected' : ''}`}
                                                    style={{ ['--usage-angle' as string]: `${Math.min(usagePercent, 1) * 360}deg` }}
                                                >
                                                    <button
                                                        ref={(node) => { modelRefs.current[model.id] = node; }}
                                                        className={`rules-bubble ${focusedBubble?.side === 'model' && focusedBubble.id === model.id ? 'focused' : ''}`}
                                                        draggable
                                                        onClick={(event) => handleBubbleClick('model', model.id, event)}
                                                        onDragStart={(event) => {
                                                            handleDragStart('model', model.id);
                                                            event.dataTransfer.effectAllowed = 'copy';
                                                        }}
                                                        onDragEnd={() => setDragPayload(null)}
                                                        onDragOver={(event) => event.preventDefault()}
                                                        onDrop={(event) => {
                                                            event.preventDefault();
                                                            handleDrop('model', model.id);
                                                        }}
                                                    >
                                                        <span className="rules-bubble-label">{model.displayName || model.name}</span>
                                                        <span className="rules-bubble-meta">
                                                            {rules.filter((rule) => rule.modelId === model.id).length} rule{rules.filter((rule) => rule.modelId === model.id).length !== 1 ? 's' : ''}
                                                        </span>
                                                    </button>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>

                                {hoveredTooltip && (
                                    <div
                                        className={`rules-tooltip ${hoveredTooltip.lineClass}`}
                                        style={{ left: hoveredTooltip.x, top: hoveredTooltip.y }}
                                    >
                                        <strong>{keyLabelById[hoveredTooltip.rule.keyId] ?? hoveredTooltip.rule.keyId}</strong>
                                        <span>{hoveredTooltip.rule.modelName}</span>
                                        <span>RPM: {hoveredTooltip.rule.rules.maxRequestsPerMinute ?? '—'}</span>
                                        <span>TPM: {hoveredTooltip.rule.rules.maxTokensPerMinute ?? '—'}</span>
                                        <span>Daily usage: {(hoveredTooltip.usagePercent * 100).toFixed(0)}%</span>
                                    </div>
                                )}

                                {!loading && rules.length === 0 && (
                                    <div className="rules-empty-state">
                                        <div className="empty-icon">🫧</div>
                                        <p>No visual links yet</p>
                                        <p className="text-muted text-sm">Drag a key bubble onto a model bubble to create the first rule.</p>
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                </section>

                <aside className="card rules-inspector-card">
                    <div className="card-header">
                        <h3>Inspector</h3>
                    </div>
                    <div className="card-body">
                        {selectedRule ? (
                            <div className="rules-inspector-content">
                                <div className="rules-inspector-pill">{keyLabelById[selectedRule.keyId] ?? selectedRule.keyId}</div>
                                <div className="rules-inspector-arrow">→</div>
                                <div className="rules-inspector-pill model">{selectedRule.modelName}</div>

                                <div className="rules-inspector-block">
                                    <h4>Limits</h4>
                                    <p>{formatRuleLimits(selectedRule)}</p>
                                </div>

                                <div className="rules-inspector-block">
                                    <h4>Daily usage</h4>
                                    <p>{((ruleUsage[selectedRule.id]?.usagePercent ?? 0) * 100).toFixed(0)}%</p>
                                </div>

                                <div className="action-buttons">
                                    <button
                                        className="btn btn-primary btn-sm"
                                        onClick={() => openCreateModal([selectedRule.keyId], [selectedRule.modelId], selectedRule)}
                                    >
                                        Edit
                                    </button>
                                    <button
                                        className="btn btn-danger btn-sm"
                                        onClick={() => {
                                            if (!window.confirm('Delete this rule?')) return;
                                            handleDelete(selectedRule.id);
                                        }}
                                    >
                                        Delete
                                    </button>
                                </div>
                            </div>
                        ) : focusedBubble ? (
                            <div className="rules-inspector-content">
                                <h4>{focusedBubble.side === 'key'
                                    ? keyLabelById[focusedBubble.id] ?? focusedBubble.id
                                    : modelNameById[focusedBubble.id] ?? focusedBubble.id}
                                </h4>
                                <p className="text-muted text-sm">{focusedRules.length} linked rule{focusedRules.length !== 1 ? 's' : ''}</p>

                                <div className="rules-inspector-list">
                                    {focusedRules.map((rule) => (
                                        <button
                                            key={rule.id}
                                            className={`rules-inspector-item ${selectedLineId === rule.id ? 'selected' : ''}`}
                                            onClick={() => setSelectedLineId(rule.id)}
                                        >
                                            <strong>{focusedBubble.side === 'key'
                                                ? rule.modelName
                                                : keyLabelById[rule.keyId] ?? rule.keyId}
                                            </strong>
                                            <span>{formatRuleLimits(rule)}</span>
                                        </button>
                                    ))}
                                </div>
                            </div>
                        ) : (
                            <div className="rules-empty-inspector">
                                <div className="empty-icon">🧭</div>
                                <p>Select a bubble or line</p>
                                <p className="text-muted text-sm">Bubble selection highlights linked rules. Line selection exposes edit and delete actions.</p>
                            </div>
                        )}
                    </div>
                </aside>
            </div>

            {showModal && (
                <div className="modal-overlay" onClick={resetModalState}>
                    <div className="modal" onClick={(event) => event.stopPropagation()} style={{ maxWidth: '620px' }}>
                        <div className="modal-header">
                            <h3>{editingRuleId ? 'Edit Rule' : 'Add Rules'}</h3>
                            <button className="close-btn" onClick={resetModalState}>✕</button>
                        </div>
                        <form onSubmit={handleSubmit}>
                            <div className="modal-body">
                                {keys.length === 0 && (
                                    <div className="badge badge-warning" style={{ display: 'block', marginBottom: '12px' }}>
                                        No API keys found. Add a key first.
                                    </div>
                                )}
                                {models.length === 0 && (
                                    <div className="badge badge-warning" style={{ display: 'block', marginBottom: '12px' }}>
                                        No models found. Add models first.
                                    </div>
                                )}

                                {editingRule ? (
                                    <div className="grid-2">
                                        <div className="form-group">
                                            <label>API Key</label>
                                            <div className="rules-modal-selector">
                                                <div className="rules-modal-option selected">
                                                    <span>{keyLabelById[editingRule.keyId] ?? editingRule.keyId}</span>
                                                </div>
                                            </div>
                                        </div>

                                        <div className="form-group">
                                            <label>Model</label>
                                            <div className="rules-modal-selector">
                                                <div className="rules-modal-option selected">
                                                    <span>{editingRule.modelName}</span>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="grid-2">
                                        <div className="form-group">
                                            <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                                <span>API Keys <span className="badge badge-info" style={{ marginLeft: '6px', fontSize: '11px' }}>{selectedKeyIds.size} selected</span></span>
                                                <button
                                                    type="button"
                                                    className="btn btn-ghost"
                                                    style={{ fontSize: '11px', padding: '2px 8px' }}
                                                    onClick={() => {
                                                        if (selectedKeyIds.size === keys.length) {
                                                            setSelectedKeyIds(new Set());
                                                            return;
                                                        }

                                                        const allowedProviderId = selectionProviderId ?? models[0]?.providerId ?? null;
                                                        setSelectedKeyIds(new Set(
                                                            keys
                                                                .filter((key) => !allowedProviderId || key.providerId === allowedProviderId)
                                                                .map((key) => key.id)
                                                        ));
                                                    }}
                                                >
                                                    {selectedKeyIds.size === keys.length ? 'Deselect All' : 'Select All'}
                                                </button>
                                            </label>
                                            <div className="rules-modal-selector">
                                                {keys.map((key) => (
                                                    <label
                                                        key={key.id}
                                                        className={`rules-modal-option ${selectedKeyIds.has(key.id) ? 'selected' : ''} ${selectionProviderId && key.providerId !== selectionProviderId ? 'disabled' : ''}`}
                                                    >
                                                        <input
                                                            type="checkbox"
                                                            checked={selectedKeyIds.has(key.id)}
                                                            disabled={!!selectionProviderId && key.providerId !== selectionProviderId}
                                                            onChange={() => {
                                                                setSelectedKeyIds((prev) => {
                                                                    const next = new Set(prev);
                                                                    if (next.has(key.id)) next.delete(key.id);
                                                                    else next.add(key.id);
                                                                    return next;
                                                                });
                                                            }}
                                                        />
                                                        <span>{key.label}</span>
                                                    </label>
                                                ))}
                                            </div>
                                        </div>

                                        <div className="form-group">
                                            <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                                <span>Models <span className="badge badge-info" style={{ marginLeft: '6px', fontSize: '11px' }}>{selectedModelIds.size} selected</span></span>
                                                <button
                                                    type="button"
                                                    className="btn btn-ghost"
                                                    style={{ fontSize: '11px', padding: '2px 8px' }}
                                                    onClick={() => {
                                                        if (selectedModelIds.size === models.length) {
                                                            setSelectedModelIds(new Set());
                                                            return;
                                                        }

                                                        const allowedProviderId = selectionProviderId ?? keys[0]?.providerId ?? null;
                                                        setSelectedModelIds(new Set(
                                                            models
                                                                .filter((model) => !allowedProviderId || model.providerId === allowedProviderId)
                                                                .map((model) => model.id)
                                                        ));
                                                    }}
                                                >
                                                    {selectedModelIds.size === models.length ? 'Deselect All' : 'Select All'}
                                                </button>
                                            </label>
                                            <div className="rules-modal-selector">
                                                {models.map((model) => (
                                                    <label
                                                        key={model.id}
                                                        className={`rules-modal-option ${selectedModelIds.has(model.id) ? 'selected' : ''} ${selectionProviderId && model.providerId !== selectionProviderId ? 'disabled' : ''}`}
                                                    >
                                                        <input
                                                            type="checkbox"
                                                            checked={selectedModelIds.has(model.id)}
                                                            disabled={!!selectionProviderId && model.providerId !== selectionProviderId}
                                                            onChange={() => {
                                                                setSelectedModelIds((prev) => {
                                                                    const next = new Set(prev);
                                                                    if (next.has(model.id)) next.delete(model.id);
                                                                    else next.add(model.id);
                                                                    return next;
                                                                });
                                                            }}
                                                        />
                                                        <span>{model.displayName || model.name}</span>
                                                    </label>
                                                ))}
                                            </div>
                                        </div>
                                    </div>
                                )}

                                {!editingRule && totalCombinations > 0 && (
                                    <div className="rules-modal-summary">
                                        {selectedKeyIds.size} key{selectedKeyIds.size > 1 ? 's' : ''} × {selectedModelIds.size} model{selectedModelIds.size > 1 ? 's' : ''} = <strong>{totalCombinations} rule{totalCombinations > 1 ? 's' : ''}</strong>
                                    </div>
                                )}

                                <h4 style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '12px' }}>Rate Limits</h4>
                                <div className="rules-grid">
                                    {[
                                        { key: 'maxRequestsPerMinute', label: 'RPM' },
                                        { key: 'maxRequestsPerHour', label: 'RPH' },
                                        { key: 'maxRequestsPerDay', label: 'RPD' },
                                        { key: 'maxTokensPerMinute', label: 'TPM' },
                                        { key: 'maxTokensPerDay', label: 'TPD' },
                                        { key: 'cooldownSeconds', label: 'Cooldown (s)' },
                                    ].map(({ key, label }) => (
                                        <div key={key} className="form-group">
                                            <label>{label}</label>
                                            <input
                                                className="form-control"
                                                type="number"
                                                value={(rateLimits as Record<string, string>)[key]}
                                                onChange={(event) => setRateLimits({ ...rateLimits, [key]: event.target.value })}
                                                placeholder="—"
                                            />
                                        </div>
                                    ))}
                                </div>
                            </div>
                            <div className="modal-footer">
                                <button type="button" className="btn btn-ghost" onClick={resetModalState}>Cancel</button>
                                <button type="submit" className="btn btn-primary" disabled={(!editingRuleId && (selectedKeyIds.size === 0 || selectedModelIds.size === 0)) || submitting}>
                                    {submitting
                                        ? (editingRuleId ? 'Saving...' : 'Creating...')
                                        : (editingRuleId ? 'Save Rule' : `Create ${totalCombinations} Rule${totalCombinations !== 1 ? 's' : ''}`)}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}
