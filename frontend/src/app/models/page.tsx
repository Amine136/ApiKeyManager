'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '../../context/AuthContext';
import { api } from '../../services/api';
import { Skeleton } from '../../components/Skeleton';

interface Model {
    id: string;
    name: string;
    displayName: string;
    providerId: string;
    cost?: string;
    description?: string;
    inputModalities?: Array<'TEXT' | 'IMAGE'>;
    outputModalities?: Array<'TEXT' | 'IMAGE'>;
}

interface Provider {
    id: string;
    name: string;
    displayName: string;
}

function getProviderSectionTone(provider: Provider): 'purple' | 'teal' | 'default' {
    const value = `${provider.name} ${provider.displayName}`.toLowerCase();
    if (value.includes('imagen')) return 'purple';
    if (value.includes('gemini')) return 'teal';
    return 'default';
}

export default function ModelsPage() {
    const { isAuthenticated, isLoading } = useAuth();
    const router = useRouter();
    const [models, setModels] = useState<Model[]>([]);
    const [providers, setProviders] = useState<Provider[]>([]);
    const [loading, setLoading] = useState(true);
    const [showModal, setShowModal] = useState(false);
    const [editingModelId, setEditingModelId] = useState<string | null>(null);
    const [form, setForm] = useState({
        name: '',
        displayName: '',
        providerId: '',
        cost: '',
        description: '',
        inputModalities: ['TEXT'] as Array<'TEXT' | 'IMAGE'>,
        outputModalities: ['TEXT'] as Array<'TEXT' | 'IMAGE'>,
    });

    useEffect(() => {
        if (!isLoading && !isAuthenticated) router.push('/login');
    }, [isAuthenticated, isLoading, router]);

    useEffect(() => {
        if (isAuthenticated) loadData();
    }, [isAuthenticated]);

    const loadData = async () => {
        try {
            const [modRes, provRes] = await Promise.all([api.getModels(), api.getProviders()]);
            setModels(modRes.data);
            setProviders(provRes.data);
            if (provRes.data.length > 0) setForm(f => ({ ...f, providerId: provRes.data[0].id }));
        } catch (e) { console.error(e); }
        finally { setLoading(false); }
    };

    const toggleModality = (
        field: 'inputModalities' | 'outputModalities',
        modality: 'TEXT' | 'IMAGE'
    ) => {
        setForm((prev) => {
            const current = prev[field];
            const next = current.includes(modality)
                ? current.filter((value) => value !== modality)
                : [...current, modality];

            return {
                ...prev,
                [field]: next.length > 0 ? next : [modality],
            };
        });
    };

    const resetForm = () => {
        setEditingModelId(null);
        setForm({
            name: '',
            displayName: '',
            providerId: providers[0]?.id ?? '',
            cost: '',
            description: '',
            inputModalities: ['TEXT'],
            outputModalities: ['TEXT'],
        });
    };

    const openCreateModal = () => {
        resetForm();
        setShowModal(true);
    };

    const openEditModal = (model: Model) => {
        setEditingModelId(model.id);
        setForm({
            name: model.name,
            displayName: model.displayName || model.name,
            providerId: model.providerId,
            cost: model.cost || '',
            description: model.description || '',
            inputModalities: model.inputModalities ?? ['TEXT'],
            outputModalities: model.outputModalities ?? ['TEXT'],
        });
        setShowModal(true);
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        try {
            const payload = {
                name: form.name.trim(),
                displayName: form.displayName.trim(),
                providerId: form.providerId,
                cost: form.cost.trim() || undefined,
                description: form.description.trim() || undefined,
                inputModalities: form.inputModalities,
                outputModalities: form.outputModalities,
            };

            if (editingModelId) {
                await api.updateModel(editingModelId, payload);
            } else {
                await api.createModel(payload);
            }
            setShowModal(false);
            resetForm();
            loadData();
        } catch (e: any) { alert(e.message); }
    };

    const handleDelete = async (id: string) => {
        if (!confirm('Delete this model? Existing rules that reference it will also stop working.')) return;
        try { await api.deleteModel(id); loadData(); }
        catch (e: any) { alert(e.message); }
    };

    if (isLoading || !isAuthenticated) return null;

    // Group models by provider
    const grouped = providers.map(p => ({
        provider: p,
        models: models.filter(m => m.providerId === p.id),
    })).filter(g => g.models.length > 0);

    return (
        <div>
            <div className="page-header flex-between">
                <div>
                    <h1>Models</h1>
                    <p>Define authorised models per provider</p>
                </div>
                <button className="btn models-add-btn" onClick={openCreateModal}>+ Add Model</button>
            </div>

            {loading ? (
                <div className="models-section">
                    <div className="models-section-header">
                        <Skeleton width="140px" height={28} borderRadius={999} />
                        <div className="models-section-rule" />
                        <Skeleton width="72px" height={18} borderRadius={999} />
                    </div>
                    <div className="models-grid">
                        {Array.from({ length: 4 }).map((_, i) => (
                            <div key={i} className="models-card">
                                <div className="models-card-top">
                                    <div>
                                        <Skeleton width="120px" height={18} />
                                        <div style={{ marginTop: '8px' }}>
                                            <Skeleton width="150px" height={12} />
                                        </div>
                                    </div>
                                    <Skeleton width="58px" height={24} borderRadius={999} />
                                </div>
                                <div className="models-card-description">
                                    <Skeleton width="100%" height={14} />
                                    <div style={{ marginTop: '8px' }}>
                                        <Skeleton width="72%" height={14} />
                                    </div>
                                </div>
                                <div className="models-card-footer">
                                    <div style={{ display: 'flex', gap: '8px' }}>
                                        <Skeleton width="44px" height={24} borderRadius={999} />
                                        <Skeleton width="16px" height={14} />
                                        <Skeleton width="50px" height={24} borderRadius={999} />
                                    </div>
                                    <div style={{ display: 'flex', gap: '8px' }}>
                                        <Skeleton width="52px" height={30} borderRadius={10} />
                                        <Skeleton width="62px" height={30} borderRadius={10} />
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            ) : models.length === 0 ? (
                <div className="card">
                    <div className="empty-state">
                        <div className="empty-icon">🧠</div>
                        <p>No models defined yet</p>
                    </div>
                </div>
            ) : (
                grouped.map(({ provider, models: pModels }) => {
                    const tone = getProviderSectionTone(provider);

                    return (
                    <section
                        key={provider.id}
                        className={`models-section models-section-${tone}`}
                    >
                        <div className="models-section-header">
                            <div className="models-provider-pill">
                                <span className="models-provider-pill-dot" />
                                <span>{provider.displayName || provider.name}</span>
                            </div>
                            <div className="models-section-rule" />
                            <div className="models-count-label">{pModels.length} {pModels.length === 1 ? 'model' : 'models'}</div>
                        </div>
                        <div className="models-grid">
                            {pModels.map(m => (
                                <article key={m.id} className="models-card">
                                    <div className="models-card-top">
                                        <div className="models-card-title-wrap">
                                            <div className="models-card-title">{m.displayName || m.name}</div>
                                            <div className="models-card-id">{m.name}</div>
                                        </div>
                                        <div className="models-cost-pill">{m.cost || '—'}</div>
                                    </div>

                                    <div className="models-card-description">
                                        {m.description || 'No description provided for this model yet.'}
                                    </div>

                                    <div className="models-card-footer">
                                        <div className="models-io-row">
                                            {(m.inputModalities ?? ['TEXT']).map((modality) => (
                                                <span key={`in-${m.id}-${modality}`} className={`models-io-chip models-io-chip-${modality.toLowerCase()}`}>
                                                    {modality}
                                                </span>
                                            ))}
                                            <span className="models-io-arrow">→</span>
                                            {(m.outputModalities ?? ['TEXT']).map((modality) => (
                                                <span key={`out-${m.id}-${modality}`} className={`models-io-chip models-io-chip-${modality.toLowerCase()}`}>
                                                    {modality}
                                                </span>
                                            ))}
                                        </div>

                                        <div className="models-card-actions">
                                            <button className="models-action-btn models-action-btn-edit" onClick={() => openEditModal(m)}>Edit</button>
                                            <button className="models-action-btn models-action-btn-delete" onClick={() => handleDelete(m.id)}>Delete</button>
                                        </div>
                                    </div>
                                </article>
                            ))}
                        </div>
                    </section>
                )})
            )}

            {/* Modal */}
            {showModal && (
                <div className="modal-overlay" onClick={() => { setShowModal(false); resetForm(); }}>
                    <div className="modal" onClick={e => e.stopPropagation()}>
                        <div className="modal-header">
                            <h3>{editingModelId ? 'Edit Model' : 'Add Model'}</h3>
                            <button className="close-btn" onClick={() => { setShowModal(false); resetForm(); }}>✕</button>
                        </div>
                        <form onSubmit={handleSubmit}>
                            <div className="modal-body">
                                <div className="form-group">
                                    <label>Provider</label>
                                    <select className="form-control" value={form.providerId} onChange={e => setForm({ ...form, providerId: e.target.value })} required>
                                        {providers.map(p => <option key={p.id} value={p.id}>{p.displayName || p.name}</option>)}
                                    </select>
                                </div>
                                <div className="form-group">
                                    <label>Model ID</label>
                                    <input className="form-control" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="gemini-2.5-pro" required />
                                </div>
                                <div className="form-group">
                                    <label>Display Name</label>
                                    <input className="form-control" value={form.displayName} onChange={e => setForm({ ...form, displayName: e.target.value })} placeholder="Gemini 2.5 Pro" required />
                                </div>
                                <div className="form-group">
                                    <label>Cost</label>
                                    <input className="form-control" value={form.cost} onChange={e => setForm({ ...form, cost: e.target.value })} placeholder="$0.03 / 1K tokens" />
                                </div>
                                <div className="form-group">
                                    <label>Description</label>
                                    <textarea className="form-control" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="Fast multimodal model for image and text generation." rows={3} />
                                </div>
                                <div className="form-group">
                                    <label>Input Modalities</label>
                                    <div className="playground-check-group">
                                        <label className="playground-check">
                                            <input
                                                type="checkbox"
                                                checked={form.inputModalities.includes('TEXT')}
                                                onChange={() => toggleModality('inputModalities', 'TEXT')}
                                            />
                                            <span>Text</span>
                                        </label>
                                        <label className="playground-check">
                                            <input
                                                type="checkbox"
                                                checked={form.inputModalities.includes('IMAGE')}
                                                onChange={() => toggleModality('inputModalities', 'IMAGE')}
                                            />
                                            <span>Image</span>
                                        </label>
                                    </div>
                                </div>
                                <div className="form-group">
                                    <label>Output Modalities</label>
                                    <div className="playground-check-group">
                                        <label className="playground-check">
                                            <input
                                                type="checkbox"
                                                checked={form.outputModalities.includes('TEXT')}
                                                onChange={() => toggleModality('outputModalities', 'TEXT')}
                                            />
                                            <span>Text</span>
                                        </label>
                                        <label className="playground-check">
                                            <input
                                                type="checkbox"
                                                checked={form.outputModalities.includes('IMAGE')}
                                                onChange={() => toggleModality('outputModalities', 'IMAGE')}
                                            />
                                            <span>Image</span>
                                        </label>
                                    </div>
                                </div>
                            </div>
                            <div className="modal-footer">
                                <button type="button" className="btn btn-ghost" onClick={() => { setShowModal(false); resetForm(); }}>Cancel</button>
                                <button type="submit" className="btn btn-primary">{editingModelId ? 'Save' : 'Add'}</button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}
