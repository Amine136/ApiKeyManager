'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
    CategoryScale,
    Chart as ChartJS,
    Filler,
    LineElement,
    LinearScale,
    PointElement,
    Tooltip as ChartTooltip,
    type ChartData,
    type ChartOptions,
} from 'chart.js';
import { Line } from 'react-chartjs-2';
import { useAuth } from '../context/AuthContext';
import { api } from '../services/api';
import { Skeleton } from '../components/Skeleton';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Filler, ChartTooltip);

interface ApiKey {
    id: string;
    label: string;
    status?: 'ACTIVE' | 'DISABLED' | 'EXHAUSTED' | 'REVOKED';
    rules?: {
        maxRequestsPerDay?: number;
        maxTokensPerDay?: number;
    };
}

interface Model {
    id: string;
    name: string;
    status?: string;
    isActive?: boolean;
}

interface KeyModelRule {
    id: string;
    keyId: string;
    modelId: string;
    modelName: string;
    rules: {
        maxRequestsPerDay?: number;
        maxTokensPerDay?: number;
    };
}

interface DashboardData {
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
}

type RangeKey = '1h' | 'today' | '7d' | '30d';

const RANGE_OPTIONS: { key: RangeKey; label: string }[] = [
    { key: '1h', label: '1h' },
    { key: 'today', label: 'Today' },
    { key: '7d', label: '7d' },
    { key: '30d', label: '30d' },
];

export default function DashboardPage() {
    const { isAuthenticated, isLoading } = useAuth();
    const router = useRouter();
    const [dashboard, setDashboard] = useState<DashboardData | null>(null);
    const [keys, setKeys] = useState<ApiKey[]>([]);
    const [models, setModels] = useState<Model[]>([]);
    const [keyModelRules, setKeyModelRules] = useState<KeyModelRule[]>([]);
    const [loading, setLoading] = useState(true);
    const [range, setRange] = useState<RangeKey>('today');

    useEffect(() => {
        if (!isLoading && !isAuthenticated) {
            router.push('/login');
        }
    }, [isAuthenticated, isLoading, router]);

    useEffect(() => {
        if (isLoading || !isAuthenticated) return;

        setLoading(true);
        api.getDashboardBootstrap(range).then((response) => {
            setKeys(response.data.keys);
            setModels(response.data.models);
            setKeyModelRules(response.data.keyModelRules);
            setDashboard(response.data.dashboard);
        }).catch(console.error)
            .finally(() => setLoading(false));
    }, [isLoading, isAuthenticated, range]);

    const keyLabelById = useMemo(
        () => Object.fromEntries(keys.map((key) => [key.id, key.label])),
        [keys]
    );

    const lineChartData = useMemo<ChartData<'line'>>(() => ({
        labels: dashboard?.chart.map((point) => point.label) ?? [],
        datasets: [
            {
                data: dashboard?.chart.map((point) => point.requests) ?? [],
                borderColor: '#3b82f6',
                backgroundColor: 'rgba(59, 130, 246, 0.14)',
                pointRadius: 0,
                pointHoverRadius: 4,
                tension: 0.45,
                fill: true,
                borderWidth: 2.5,
            },
        ],
    }), [dashboard]);

    const lineChartOptions = useMemo<ChartOptions<'line'>>(() => ({
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
            mode: 'index',
            intersect: false,
        },
        plugins: {
            legend: {
                display: false,
            },
            tooltip: {
                backgroundColor: '#101827',
                borderColor: 'rgba(42, 53, 80, 0.95)',
                borderWidth: 1,
                cornerRadius: 10,
                displayColors: false,
                titleColor: '#f1f5f9',
                bodyColor: '#cbd5e1',
            },
        },
        scales: {
            x: {
                grid: { display: false },
                ticks: {
                    color: '#64748b',
                    font: { size: 11 },
                },
                border: { display: false },
            },
            y: {
                beginAtZero: true,
                ticks: {
                    color: '#64748b',
                    precision: 0,
                    font: { size: 11 },
                },
                grid: { color: 'rgba(42, 53, 80, 0.45)' },
                border: { display: false },
            },
        },
    }), []);

    const keyUsage = useMemo(() => {
        const items = dashboard?.keyUsageToday ?? [];
        const max = Math.max(...items.map((item) => item.requestCount), 1);

        return items.map((item) => ({
            ...item,
            percent: Math.round((item.requestCount / max) * 100),
        }));
    }, [dashboard]);

    const modelDailyRemaining = useMemo(() => {
        const modelUsageToday = Object.fromEntries(
            (dashboard?.modelUsageToday ?? []).map((item) => [item.model, item])
        );

        const rulesByKeyId = keyModelRules.reduce<Record<string, KeyModelRule[]>>((acc, rule) => {
            if (!acc[rule.keyId]) acc[rule.keyId] = [];
            acc[rule.keyId].push(rule);
            return acc;
        }, {});

        return models
            .filter((model) => model.isActive !== false && model.status !== 'STOPPED' && model.status !== 'DISABLED')
            .map((model) => {
                let totalRequestLimit = 0;
                let totalTokenLimit = 0;
                let hasUnlimitedRequests = false;
                let hasUnlimitedTokens = false;

                for (const key of keys) {
                    if (!key.id || key.status !== 'ACTIVE') continue;

                    const rulesForKey = rulesByKeyId[key.id] ?? [];
                    const matchingRule = rulesForKey.find((rule) => rule.modelId === model.id || rule.modelName === model.name);

                    if (rulesForKey.length > 0 && !matchingRule) {
                        continue;
                    }

                    const effectiveRules = matchingRule?.rules ?? key.rules ?? {};

                    if (typeof effectiveRules.maxRequestsPerDay === 'number') {
                        totalRequestLimit += effectiveRules.maxRequestsPerDay;
                    } else {
                        hasUnlimitedRequests = true;
                    }

                    if (typeof effectiveRules.maxTokensPerDay === 'number') {
                        totalTokenLimit += effectiveRules.maxTokensPerDay;
                    } else {
                        hasUnlimitedTokens = true;
                    }
                }

                const usage = modelUsageToday[model.name];
                const usedRequests = usage?.requestCount ?? 0;
                const usedTokens = usage?.tokenCount ?? 0;

                return {
                    id: model.id,
                    name: model.name,
                    usedRequests,
                    remainingRequests: hasUnlimitedRequests ? null : Math.max(totalRequestLimit - usedRequests, 0),
                    remainingTokens: hasUnlimitedTokens ? null : Math.max(totalTokenLimit - usedTokens, 0),
                };
            })
            .sort((a, b) => b.usedRequests - a.usedRequests);
    }, [dashboard, keyModelRules, keys, models]);

    const providerCards = useMemo(
        () => Object.entries(dashboard?.providerTotals ?? {}).sort((a, b) => b[1] - a[1]),
        [dashboard]
    );

    if (isLoading || !isAuthenticated) return null;

    return (
        <div className="dashboard-page">
            <div className="page-header dashboard-header">
                <div>
                    <h1>Dashboard</h1>
                    <p>Dashboard reads are now backed by compact aggregates instead of raw usage log scans.</p>
                </div>
                <div className="dashboard-range-switcher">
                    {RANGE_OPTIONS.map((option) => (
                        <button
                            key={option.key}
                            className={`dashboard-range-btn ${range === option.key ? 'active' : ''}`}
                            onClick={() => setRange(option.key)}
                        >
                            {option.label}
                        </button>
                    ))}
                </div>
            </div>

            {loading || !dashboard ? (
                <div className="dashboard-loading">
                    <div className="dashboard-metrics-grid">
                        {Array.from({ length: 5 }).map((_, index) => (
                            <div key={index} className="dashboard-metric-card">
                                <Skeleton className="skeleton-text" width="45%" />
                                <Skeleton height={28} width="58%" style={{ marginTop: 14 }} />
                                <Skeleton className="skeleton-text" width="40%" style={{ marginTop: 12 }} />
                            </div>
                        ))}
                    </div>
                </div>
            ) : (
                <>
                    <section className="dashboard-metrics-grid">
                        <div className="dashboard-metric-card">
                            <span className="dashboard-metric-label">Total Requests</span>
                            <strong className="dashboard-metric-value">{dashboard.rangeMetrics.totalRequests}</strong>
                            <span className="dashboard-metric-subtle">Aggregate-backed range window</span>
                        </div>

                        <div className="dashboard-metric-card">
                            <span className="dashboard-metric-label">Success</span>
                            <strong className="dashboard-metric-value success">{dashboard.rangeMetrics.successCount}</strong>
                            <span className="dashboard-metric-subtle">{dashboard.rangeMetrics.successRate.toFixed(0)}% success rate</span>
                        </div>

                        <div className="dashboard-metric-card">
                            <span className="dashboard-metric-label">Failed</span>
                            <strong className="dashboard-metric-value danger">{dashboard.rangeMetrics.failedCount}</strong>
                            <span className="dashboard-metric-subtle">{dashboard.rangeMetrics.failureRate.toFixed(0)}% failure rate</span>
                        </div>

                        <div className="dashboard-metric-card">
                            <span className="dashboard-metric-label">Avg Latency</span>
                            <strong className="dashboard-metric-value warning">{dashboard.rangeMetrics.avgLatencyMs}ms</strong>
                            <span className="dashboard-metric-subtle">P95 {dashboard.rangeMetrics.p95LatencyMs}ms</span>
                        </div>

                        <div className="dashboard-metric-card">
                            <span className="dashboard-metric-label">Daily Tokens</span>
                            <strong className="dashboard-metric-value info">{dashboard.rangeMetrics.totalTokens}</strong>
                            <span className="dashboard-metric-subtle">Aggregate token usage in range</span>
                        </div>
                    </section>

                    <section className="dashboard-row-two">
                        <div className="card dashboard-panel flat">
                            <div className="card-header">
                                <h3>Requests Over Time</h3>
                                <span className="dashboard-panel-note">{range.toUpperCase()}</span>
                            </div>
                            <div className="card-body dashboard-chart-body">
                                {dashboard.chart.every((point) => point.requests === 0) ? (
                                    <div className="dashboard-empty-panel">
                                        <div className="empty-icon">📉</div>
                                        <p>No request activity in the selected range</p>
                                    </div>
                                ) : (
                                    <div className="dashboard-chart-wrap">
                                        <Line data={lineChartData} options={lineChartOptions} />
                                    </div>
                                )}
                            </div>
                        </div>

                        <div className="card dashboard-panel flat">
                            <div className="card-header">
                                <h3>Issues Breakdown</h3>
                            </div>
                            <div className="card-body">
                                <div className="dashboard-issues-list">
                                    <div className="dashboard-issue-row">
                                        <div>
                                            <strong>Exhausted keys</strong>
                                            <span>Aggregate 429s in range</span>
                                        </div>
                                        <div className="dashboard-issue-meta">
                                            <span>{dashboard.rangeMetrics.exhaustedKeys}</span>
                                            <span className="badge badge-danger">429</span>
                                        </div>
                                    </div>
                                    <div className="dashboard-issue-row">
                                        <div>
                                            <strong>Unauthorized model</strong>
                                            <span>Aggregate 403s in range</span>
                                        </div>
                                        <div className="dashboard-issue-meta">
                                            <span>{dashboard.rangeMetrics.unauthorizedModel}</span>
                                            <span className="badge dashboard-badge-orange">403</span>
                                        </div>
                                    </div>
                                    <div className="dashboard-issue-row">
                                        <div>
                                            <strong>Provider errors</strong>
                                            <span>Aggregate 5xx failures</span>
                                        </div>
                                        <div className="dashboard-issue-meta">
                                            <span>{dashboard.rangeMetrics.providerErrors}</span>
                                            <span className="badge dashboard-badge-provider">502</span>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </section>

                    <section className="dashboard-row-three">
                        <div className="card dashboard-panel flat">
                            <div className="card-header">
                                <h3>API Key Daily Usage</h3>
                                <span className="dashboard-panel-note">Backed by daily aggregate docs</span>
                            </div>
                            <div className="card-body">
                                {keyUsage.length === 0 ? (
                                    <div className="dashboard-empty-panel">
                                        <div className="empty-icon">🔑</div>
                                        <p>No key activity today</p>
                                    </div>
                                ) : (
                                    <div className="dashboard-key-bars">
                                        {keyUsage.map((item) => (
                                            <div key={item.apiKeyId} className="dashboard-key-row">
                                                <div className="dashboard-key-labels">
                                                    <strong>{keyLabelById[item.apiKeyId] ?? item.apiKeyId}</strong>
                                                    <span>{item.requestCount} successful requests today</span>
                                                </div>
                                                <div className="dashboard-key-progress">
                                                    <div className="dashboard-key-track">
                                                        <div
                                                            className={`dashboard-key-fill ${item.percent >= 80 ? 'danger' : item.percent >= 60 ? 'warning' : 'success'}`}
                                                            style={{ width: `${item.percent}%` }}
                                                        />
                                                    </div>
                                                    <span>{item.percent}%</span>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>

                        <div className="dashboard-side-stack">
                            <div className="card dashboard-panel flat">
                                <div className="card-header">
                                    <h3>Requests by Provider</h3>
                                </div>
                                <div className="card-body">
                                    <div className="dashboard-provider-grid">
                                        {providerCards.map(([name, count]) => (
                                            <div key={name} className="dashboard-provider-card">
                                                <span>{name}</span>
                                                <strong>{count}</strong>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </div>

                            <div className="card dashboard-panel flat">
                                <div className="card-header">
                                    <h3>Model Daily Remaining</h3>
                                </div>
                                <div className="card-body">
                                    <div className="dashboard-top-models">
                                        {modelDailyRemaining.map((model, index) => (
                                            <div key={model.id} className="dashboard-model-row">
                                                <span className="dashboard-model-rank">{index + 1}</span>
                                                <div className="dashboard-model-copy">
                                                    <strong>{model.name}</strong>
                                                    <span>{model.usedRequests} successful requests today</span>
                                                    <span>
                                                        Requests left: {model.remainingRequests === null ? 'Unlimited' : model.remainingRequests}
                                                        {' · '}
                                                        Tokens left: {model.remainingTokens === null ? 'Unlimited' : model.remainingTokens}
                                                    </span>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        </div>
                    </section>
                </>
            )}
        </div>
    );
}
