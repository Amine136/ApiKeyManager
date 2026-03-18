'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '../../context/AuthContext';
import { api } from '../../services/api';
import { Skeleton } from '../../components/Skeleton';

interface ApiKey {
    id: string;
    providerId: string;
    label: string;
    status: string;
    priority: number;
    weight: number;
}

interface Provider {
    id: string;
    name: string;
    displayName: string;
}

export default function KeysPage() {
    const { isAuthenticated, isLoading } = useAuth();
    const router = useRouter();
    const [keys, setKeys] = useState<ApiKey[]>([]);
    const [providers, setProviders] = useState<Provider[]>([]);
    const [loading, setLoading] = useState(true);
    const [showModal, setShowModal] = useState(false);
    const [form, setForm] = useState({
        providerId: '',
        label: '',
        rawKey: '',
        priority: 1,
        weight: 1,
    });

    useEffect(() => {
        if (!isLoading && !isAuthenticated) router.push('/login');
    }, [isAuthenticated, isLoading, router]);

    useEffect(() => {
        if (isAuthenticated) loadData();
    }, [isAuthenticated]);

    const loadData = async () => {
        try {
            const [keysRes, provRes] = await Promise.all([api.getKeys(), api.getProviders()]);
            setKeys(keysRes.data);
            setProviders(provRes.data);
        } catch (e) { console.error(e); }
        finally { setLoading(false); }
    };

    const getProviderName = (id: string) => {
        const p = providers.find(p => p.id === id);
        return p?.displayName || p?.name || id;
    };

    const openCreate = () => {
        setForm({ providerId: providers[0]?.id || '', label: '', rawKey: '', priority: 1, weight: 1 });
        setShowModal(true);
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        try {
            await api.createKey({
                providerId: form.providerId,
                label: form.label,
                rawKey: form.rawKey,
                priority: form.priority,
                weight: form.weight,
                rules: {},
            });
            setShowModal(false);
            loadData();
        } catch (e: any) { alert(e.message); }
    };

    const handleDelete = async (id: string) => {
        if (!confirm('Delete this API key?')) return;
        try { await api.deleteKey(id); loadData(); }
        catch (e: any) { alert(e.message); }
    };

    const handleToggle = async (id: string) => {
        try { await api.toggleKey(id); loadData(); }
        catch (e: any) { alert(e.message); }
    };

    if (isLoading || !isAuthenticated) return null;

    return (
        <div>
            <div className="page-header flex-between">
                <div>
                    <h1>API Keys</h1>
                    <p>Manage encrypted API keys — assign per-model rate limits via the Rules page</p>
                </div>
                <button className="btn btn-primary" onClick={openCreate}>+ Add Key</button>
            </div>

            <div className="card">
                <div className="card-body" style={{ padding: 0 }}>
                    {loading ? (
                        <table className="data-table">
                            <thead>
                                <tr>
                                    <th>Label</th>
                                    <th>Provider</th>
                                    <th>Priority</th>
                                    <th>Weight</th>
                                    <th>Status</th>
                                    <th style={{ textAlign: 'right' }}>Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {Array.from({ length: 4 }).map((_, i) => (
                                    <tr key={i}>
                                        <td><Skeleton width="140px" height={18} /></td>
                                        <td><Skeleton width="100px" height={16} /></td>
                                        <td><Skeleton width="30px" height={16} /></td>
                                        <td><Skeleton width="30px" height={16} /></td>
                                        <td><Skeleton width="42px" height={24} borderRadius={24} /></td>
                                        <td className="text-right">
                                            <Skeleton width="58px" height={26} borderRadius={4} style={{ display: 'inline-block' }} />
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    ) : keys.length === 0 ? (
                        <div className="empty-state">
                            <div className="empty-icon">🔑</div>
                            <p>No API keys configured yet</p>
                        </div>
                    ) : (
                        <table className="data-table">
                            <thead>
                                <tr>
                                    <th>Label</th>
                                    <th>Provider</th>
                                    <th>Priority</th>
                                    <th>Weight</th>
                                    <th>Status</th>
                                    <th style={{ textAlign: 'right' }}>Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {keys.map((k) => (
                                    <tr key={k.id}>
                                        <td><strong>{k.label}</strong></td>
                                        <td>{getProviderName(k.providerId)}</td>
                                        <td>{k.priority}</td>
                                        <td>{k.weight}</td>
                                        <td>
                                            <label className="toggle">
                                                <input type="checkbox" checked={k.status === 'ACTIVE'} onChange={() => handleToggle(k.id)} />
                                                <span className="toggle-slider" />
                                            </label>
                                        </td>
                                        <td className="text-right">
                                            <button className="btn btn-danger btn-sm" onClick={() => handleDelete(k.id)}>Delete</button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>
            </div>

            {/* Modal */}
            {showModal && (
                <div className="modal-overlay" onClick={() => setShowModal(false)}>
                    <div className="modal" onClick={(e) => e.stopPropagation()}>
                        <div className="modal-header">
                            <h3>Add API Key</h3>
                            <button className="close-btn" onClick={() => setShowModal(false)}>✕</button>
                        </div>
                        <form onSubmit={handleSubmit}>
                            <div className="modal-body">
                                <div className="form-group">
                                    <label>Provider</label>
                                    <select className="form-control" value={form.providerId} onChange={(e) => setForm({ ...form, providerId: e.target.value })} required>
                                        {providers.map((p) => <option key={p.id} value={p.id}>{p.displayName || p.name}</option>)}
                                    </select>
                                </div>
                                <div className="form-group">
                                    <label>Label</label>
                                    <input className="form-control" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="gemini-key-1" required />
                                </div>
                                <div className="form-group">
                                    <label>API Key (plaintext — will be encrypted at rest)</label>
                                    <input className="form-control" type="password" value={form.rawKey} onChange={(e) => setForm({ ...form, rawKey: e.target.value })} placeholder="AIza..." required />
                                </div>
                                <div className="grid-2">
                                    <div className="form-group">
                                        <label>Priority (lower = first)</label>
                                        <input className="form-control" type="number" value={form.priority} onChange={(e) => setForm({ ...form, priority: parseInt(e.target.value) || 1 })} min={1} />
                                    </div>
                                    <div className="form-group">
                                        <label>Weight</label>
                                        <input className="form-control" type="number" value={form.weight} onChange={(e) => setForm({ ...form, weight: parseInt(e.target.value) || 1 })} min={1} />
                                    </div>
                                </div>
                                <p className="text-muted text-sm" style={{ marginTop: '8px' }}>
                                    💡 Rate limits per model are configured in the <strong>Rules</strong> page after creating the key.
                                </p>
                            </div>
                            <div className="modal-footer">
                                <button type="button" className="btn btn-ghost" onClick={() => setShowModal(false)}>Cancel</button>
                                <button type="submit" className="btn btn-primary">Create Key</button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}
