'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '../../context/AuthContext';
import { api } from '../../services/api';
import { Skeleton } from '../../components/Skeleton';

interface Client {
    id: string;
    name: string;
    role: string;
    isActive: boolean;
    revokedAt?: string | null;
    expiresAt?: string | null;
    lastUsedAt?: string | null;
    lastRotatedAt?: string | null;
    catalogWebhook?: {
        url: string;
        isEnabled: boolean;
        hasSecret: boolean;
        lastNotifiedAt?: string | null;
        lastVersion?: string | null;
    } | null;
}

function formatDateTime(value?: string | null): string {
    if (!value) return 'Never';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Invalid date';
    return date.toLocaleString();
}

export default function ClientsPage() {
    const { isAuthenticated, isLoading } = useAuth();
    const router = useRouter();
    const [clients, setClients] = useState<Client[]>([]);
    const [loading, setLoading] = useState(true);
    const [showModal, setShowModal] = useState(false);
    const [issuedToken, setIssuedToken] = useState<{ token: string; title: string } | null>(null);
    const [form, setForm] = useState({
        name: '',
        role: 'CLIENT',
        expiresAt: '',
        catalogWebhookUrl: '',
        catalogWebhookSecret: '',
    });

    useEffect(() => {
        if (!isLoading && !isAuthenticated) router.push('/login');
    }, [isAuthenticated, isLoading, router]);

    useEffect(() => {
        if (isAuthenticated) loadClients();
    }, [isAuthenticated]);

    const loadClients = async () => {
        try {
            const res = await api.getClients();
            setClients(res.data);
        } catch (e) { console.error(e); }
        finally { setLoading(false); }
    };

    const openCreate = () => {
        setIssuedToken(null);
        setForm({ name: '', role: 'CLIENT', expiresAt: '', catalogWebhookUrl: '', catalogWebhookSecret: '' });
        setShowModal(true);
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        try {
            const res = await api.createClient({
                name: form.name,
                role: form.role,
                ...(form.expiresAt ? { expiresAt: new Date(form.expiresAt).toISOString() } : {}),
                ...(form.catalogWebhookUrl || form.catalogWebhookSecret ? {
                    catalogWebhook: {
                        url: form.catalogWebhookUrl,
                        secret: form.catalogWebhookSecret,
                    },
                } : {}),
            });
            setIssuedToken({ token: res.data.plaintextToken, title: 'Client Created' });
            loadClients();
        } catch (e: any) { alert(e.message); }
    };

    const handleToggle = async (id: string) => {
        try {
            await api.toggleClient(id);
            loadClients();
        } catch (e: any) { alert(e.message); }
    };

    const handleRevoke = async (id: string) => {
        if (!confirm('Revoke this client token? The current token will stop working immediately.')) return;
        try {
            await api.revokeClient(id);
            loadClients();
        } catch (e: any) { alert(e.message); }
    };

    const handleRotate = async (id: string) => {
        if (!confirm('Rotate this client token? The previous token will stop working immediately.')) return;
        try {
            const res = await api.rotateClient(id);
            setIssuedToken({ token: res.data.plaintextToken, title: 'Client Token Rotated' });
            setShowModal(true);
            loadClients();
        } catch (e: any) { alert(e.message); }
    };

    const handleDelete = async (id: string) => {
        if (!confirm('Delete this client?')) return;
        try { await api.deleteClient(id); loadClients(); }
        catch (e: any) { alert(e.message); }
    };

    if (isLoading || !isAuthenticated) return null;

    return (
        <div>
            <div className="page-header flex-between">
                <div>
                    <h1>Clients</h1>
                    <p>Manage API client tokens and access roles</p>
                </div>
                <button className="btn btn-primary" onClick={openCreate}>+ Add Client</button>
            </div>

            <div className="card">
                <div className="card-body" style={{ padding: 0 }}>
                    {loading ? (
                        <table className="data-table">
                            <thead>
                                <tr>
                                    <th>Name</th>
                                    <th>Role</th>
                                    <th>Status</th>
                                    <th>Last Used</th>
                                    <th>Expires</th>
                                    <th style={{ textAlign: 'right' }}>Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {Array.from({ length: 3 }).map((_, i) => (
                                    <tr key={i}>
                                        <td><Skeleton width="120px" height={18} /></td>
                                        <td><Skeleton width="60px" height={22} borderRadius={20} /></td>
                                        <td><Skeleton width="60px" height={22} borderRadius={20} /></td>
                                        <td><Skeleton width="110px" height={16} /></td>
                                        <td><Skeleton width="110px" height={16} /></td>
                                        <td className="text-right">
                                            <Skeleton width="180px" height={26} borderRadius={4} style={{ display: 'inline-block' }} />
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    ) : clients.length === 0 ? (
                        <div className="empty-state">
                            <div className="empty-icon">👥</div>
                            <p>No clients configured yet</p>
                        </div>
                    ) : (
                        <table className="data-table">
                            <thead>
                                <tr>
                                    <th>Name</th>
                                    <th>Role</th>
                                    <th>Status</th>
                                    <th>Last Used</th>
                                    <th>Expires</th>
                                    <th style={{ textAlign: 'right' }}>Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {clients.map((c) => (
                                    <tr key={c.id}>
                                        <td>
                                            <strong>{c.name}</strong>
                                            <div className="text-muted text-sm">
                                                Rotated {formatDateTime(c.lastRotatedAt)}
                                            </div>
                                            {c.catalogWebhook?.isEnabled && (
                                                <div className="text-muted text-sm">
                                                    Catalog webhook: {c.catalogWebhook.url}
                                                </div>
                                            )}
                                        </td>
                                        <td>
                                            <span className={`badge badge-${c.role === 'ADMIN' ? 'warning' : 'info'}`}>
                                                {c.role}
                                            </span>
                                        </td>
                                        <td>
                                            <span className={`badge badge-${c.revokedAt ? 'danger' : c.isActive ? 'success' : 'muted'}`}>
                                                {c.revokedAt ? 'Revoked' : c.isActive ? 'Active' : 'Inactive'}
                                            </span>
                                        </td>
                                        <td>{formatDateTime(c.lastUsedAt)}</td>
                                        <td>{c.expiresAt ? formatDateTime(c.expiresAt) : 'No expiry'}</td>
                                        <td className="text-right">
                                            <div className="action-buttons" style={{ justifyContent: 'flex-end' }}>
                                                <button className="btn btn-ghost btn-sm" onClick={() => handleToggle(c.id)}>
                                                    {c.isActive ? 'Disable' : 'Enable'}
                                                </button>
                                                <button className="btn btn-ghost btn-sm" onClick={() => handleRotate(c.id)}>Rotate</button>
                                                <button className="btn btn-danger btn-sm" onClick={() => handleRevoke(c.id)}>Revoke</button>
                                                <button className="btn btn-danger btn-sm" onClick={() => handleDelete(c.id)}>Delete</button>
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
                            <h3>{issuedToken ? issuedToken.title : 'Add Client'}</h3>
                            <button className="close-btn" onClick={() => setShowModal(false)}>✕</button>
                        </div>

                        {issuedToken ? (
                            <div className="modal-body">
                                <div className="token-display">
                                    <p>⚠️ Copy this token now — it will not be shown again!</p>
                                    <code>{issuedToken.token}</code>
                                </div>
                                <div className="modal-footer" style={{ border: 'none', padding: '0' }}>
                                    <button className="btn btn-primary" onClick={() => {
                                        navigator.clipboard.writeText(issuedToken.token);
                                    }}>Copy to Clipboard</button>
                                    <button className="btn btn-ghost" onClick={() => {
                                        setIssuedToken(null);
                                        setShowModal(false);
                                    }}>Close</button>
                                </div>
                            </div>
                        ) : (
                            <form onSubmit={handleSubmit}>
                                <div className="modal-body">
                                    <div className="form-group">
                                        <label>Client Name</label>
                                        <input className="form-control" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="My App" required />
                                    </div>
                                    <div className="form-group">
                                        <label>Role</label>
                                        <select className="form-control" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                                            <option value="CLIENT">CLIENT</option>
                                            <option value="ADMIN">ADMIN</option>
                                        </select>
                                    </div>
                                    <div className="form-group">
                                        <label>Expires At (optional)</label>
                                        <input
                                            className="form-control"
                                            type="datetime-local"
                                            value={form.expiresAt}
                                            onChange={(e) => setForm({ ...form, expiresAt: e.target.value })}
                                        />
                                    </div>
                                    <div className="form-group">
                                        <label>Catalog Webhook URL (optional)</label>
                                        <input
                                            className="form-control"
                                            type="url"
                                            value={form.catalogWebhookUrl}
                                            onChange={(e) => setForm({ ...form, catalogWebhookUrl: e.target.value })}
                                            placeholder="https://vibecraft.ouni.space/api/internal/catalog-updated"
                                        />
                                    </div>
                                    <div className="form-group">
                                        <label>Catalog Webhook Secret (optional)</label>
                                        <input
                                            className="form-control"
                                            type="password"
                                            value={form.catalogWebhookSecret}
                                            onChange={(e) => setForm({ ...form, catalogWebhookSecret: e.target.value })}
                                            placeholder="X-Catalog-Webhook-Secret value"
                                        />
                                    </div>
                                </div>
                                <div className="modal-footer">
                                    <button type="button" className="btn btn-ghost" onClick={() => setShowModal(false)}>Cancel</button>
                                    <button type="submit" className="btn btn-primary">Create Client</button>
                                </div>
                            </form>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
