'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '../../context/AuthContext';
import { api } from '../../services/api';
import { Skeleton } from '../../components/Skeleton';

interface Provider {
    id: string;
    name: string;
    displayName: string;
    type: string;
    baseUrl?: string;
    supportedModels: string[];
    isActive: boolean;
}

const PROVIDER_TYPES = ['google-gemini', 'google-imagen', 'openai', 'custom'];

export default function ProvidersPage() {
    const { isAuthenticated, isLoading } = useAuth();
    const router = useRouter();
    const [providers, setProviders] = useState<Provider[]>([]);
    const [loading, setLoading] = useState(true);
    const [showModal, setShowModal] = useState(false);
    const [editing, setEditing] = useState<Provider | null>(null);
    const [form, setForm] = useState({ name: '', displayName: '', type: 'google-gemini', baseUrl: '' });

    useEffect(() => {
        if (!isLoading && !isAuthenticated) router.push('/login');
    }, [isAuthenticated, isLoading, router]);

    useEffect(() => {
        if (isAuthenticated) loadProviders();
    }, [isAuthenticated]);

    const loadProviders = async () => {
        try {
            const res = await api.getProviders();
            setProviders(res.data);
        } catch (e) { console.error(e); }
        finally { setLoading(false); }
    };

    const openCreate = () => {
        setEditing(null);
        setForm({ name: '', displayName: '', type: 'google-gemini', baseUrl: '' });
        setShowModal(true);
    };

    const openEdit = (p: Provider) => {
        setEditing(p);
        setForm({
            name: p.name,
            displayName: p.displayName,
            type: p.type,
            baseUrl: p.baseUrl || '',
        });
        setShowModal(true);
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        const data = {
            name: form.name,
            displayName: form.displayName,
            type: form.type,
            baseUrl: form.type === 'custom' ? form.baseUrl : undefined,
            supportedModels: [],
            isActive: true,
        };
        try {
            if (editing) {
                await api.updateProvider(editing.id, data);
            } else {
                await api.createProvider(data);
            }
            setShowModal(false);
            loadProviders();
        } catch (e: any) { alert(e.message); }
    };

    const handleDelete = async (id: string) => {
        if (!confirm('Delete this provider?')) return;
        try {
            await api.deleteProvider(id);
            loadProviders();
        } catch (e: any) { alert(e.message); }
    };

    const handleToggle = async (id: string) => {
        try {
            await api.toggleProvider(id);
            loadProviders();
        } catch (e: any) { alert(e.message); }
    };

    if (isLoading || !isAuthenticated) return null;

    return (
        <div>
            <div className="page-header flex-between">
                <div>
                    <h1>Providers</h1>
                    <p>Manage AI providers and their supported models</p>
                </div>
                <button className="btn btn-primary" onClick={openCreate}>+ Add Provider</button>
            </div>

            <div className="card">
                <div className="card-body" style={{ padding: 0 }}>
                    {loading ? (
                        <table className="data-table">
                            <thead>
                                <tr>
                                    <th>Name</th>
                                    <th>Type</th>
                                    <th>Status</th>
                                    <th style={{ textAlign: 'right' }}>Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {Array.from({ length: 3 }).map((_, i) => (
                                    <tr key={i}>
                                        <td>
                                            <Skeleton width="120px" height={18} style={{ marginBottom: 4 }} />
                                            <Skeleton width="80px" height={12} />
                                        </td>
                                        <td><Skeleton width="60px" height={22} borderRadius={20} /></td>
                                        <td><Skeleton width="42px" height={24} borderRadius={24} /></td>
                                        <td className="text-right">
                                            <div className="action-buttons" style={{ justifyContent: 'flex-end' }}>
                                                <Skeleton width="48px" height={26} borderRadius={4} />
                                                <Skeleton width="58px" height={26} borderRadius={4} />
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    ) : providers.length === 0 ? (
                        <div className="empty-state">
                            <div className="empty-icon">🔌</div>
                            <p>No providers configured yet</p>
                        </div>
                    ) : (
                        <table className="data-table">
                            <thead>
                                <tr>
                                    <th>Name</th>
                                    <th>Type</th>
                                    <th>Status</th>
                                    <th style={{ textAlign: 'right' }}>Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {providers.map((p) => (
                                    <tr key={p.id}>
                                        <td>
                                            <strong>{p.displayName}</strong>
                                            <div className="text-muted text-sm">{p.name}</div>
                                        </td>
                                        <td><span className="badge badge-info">{p.type}</span></td>
                                        <td>
                                            <label className="toggle">
                                                <input type="checkbox" checked={p.isActive} onChange={() => handleToggle(p.id)} />
                                                <span className="toggle-slider" />
                                            </label>
                                        </td>
                                        <td className="text-right">
                                            <div className="action-buttons" style={{ justifyContent: 'flex-end' }}>
                                                <button className="btn btn-ghost btn-sm" onClick={() => openEdit(p)}>Edit</button>
                                                <button className="btn btn-danger btn-sm" onClick={() => handleDelete(p.id)}>Delete</button>
                                            </div>
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
                            <h3>{editing ? 'Edit Provider' : 'Add Provider'}</h3>
                            <button className="close-btn" onClick={() => setShowModal(false)}>✕</button>
                        </div>
                        <form onSubmit={handleSubmit}>
                            <div className="modal-body">
                                <div className="grid-2">
                                    <div className="form-group">
                                        <label>Name (ID)</label>
                                        <input className="form-control" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="gemini-prod" required />
                                    </div>
                                    <div className="form-group">
                                        <label>Display Name</label>
                                        <input className="form-control" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} placeholder="Google Gemini" required />
                                    </div>
                                </div>
                                <div className="form-group">
                                    <label>Type</label>
                                    <select className="form-control" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                                        {PROVIDER_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                                    </select>
                                </div>
                                {form.type === 'custom' && (
                                    <div className="form-group">
                                        <label>Base URL</label>
                                        <input className="form-control" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://api.example.com/v1" />
                                    </div>
                                )}

                            </div>
                            <div className="modal-footer">
                                <button type="button" className="btn btn-ghost" onClick={() => setShowModal(false)}>Cancel</button>
                                <button type="submit" className="btn btn-primary">{editing ? 'Update' : 'Create'}</button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}
