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
    inputModalities?: Array<'TEXT' | 'IMAGE'>;
    outputModalities?: Array<'TEXT' | 'IMAGE'>;
}

interface Provider {
    id: string;
    name: string;
    displayName: string;
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

    const getProviderName = (id: string) => {
        const p = providers.find(p => p.id === id);
        return p?.displayName || p?.name || id;
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
                <button className="btn btn-primary" onClick={openCreateModal}>+ Add Model</button>
            </div>

            {loading ? (
                <div className="card">
                    <div className="card-header">
                        <Skeleton width="100px" height={22} borderRadius={20} />
                    </div>
                    <div className="card-body" style={{ padding: 0 }}>
                        <table className="data-table">
                            <thead>
                                <tr>
                                    <th>Model Name</th>
                                    <th style={{ textAlign: 'right' }}>Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {Array.from({ length: 2 }).map((_, i) => (
                                    <tr key={i}>
                                        <td><Skeleton width="150px" height={18} /></td>
                                        <td className="text-right">
                                            <Skeleton width="58px" height={26} borderRadius={4} style={{ display: 'inline-block' }} />
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
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
                grouped.map(({ provider, models: pModels }) => (
                    <div key={provider.id} className="card" style={{ marginBottom: '16px' }}>
                        <div className="card-header">
                            <h3 style={{ margin: 0, fontSize: '15px' }}>
                                <span className="badge badge-info" style={{ marginRight: '8px' }}>{provider.displayName || provider.name}</span>
                            </h3>
                        </div>
                        <div className="card-body" style={{ padding: 0 }}>
                            <table className="data-table">
                                <thead>
                                    <tr>
                                        <th>Display Name</th>
                                        <th>Model Name</th>
                                        <th>Input</th>
                                        <th>Output</th>
                                        <th style={{ textAlign: 'right' }}>Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {pModels.map(m => (
                                        <tr key={m.id}>
                                            <td><strong>{m.displayName || m.name}</strong></td>
                                            <td><strong>{m.name}</strong></td>
                                            <td>{(m.inputModalities ?? ['TEXT']).join(', ')}</td>
                                            <td>{(m.outputModalities ?? ['TEXT']).join(', ')}</td>
                                            <td className="text-right">
                                                <button className="btn btn-primary btn-sm" style={{ marginRight: '8px' }} onClick={() => openEditModal(m)}>Edit</button>
                                                <button className="btn btn-danger btn-sm" onClick={() => handleDelete(m.id)}>Delete</button>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                ))
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
