'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '../../context/AuthContext';

export default function LoginPage() {
    const [token, setToken] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const { login, isAuthenticated } = useAuth();
    const router = useRouter();

    useEffect(() => {
        if (isAuthenticated) {
            router.push('/');
        }
    }, [isAuthenticated, router]);

    if (isAuthenticated) {
        return null; // Prevent rendering login form while redirecting
    }

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        setLoading(true);
        try {
            await login(token.trim());
            router.push('/');
        } catch (err: any) {
            setError(err.message || 'Invalid token');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="login-page">
            <div className="login-card">
                <div className="login-icon">🔑</div>
                <h1>API Key Manager</h1>
                <p className="subtitle">Enter your admin token to continue</p>
                {error && <div className="login-error">{error}</div>}
                <form onSubmit={handleSubmit}>
                    <div className="form-group">
                        <label>Admin Token</label>
                        <input
                            type="password"
                            className="form-control"
                            placeholder="Enter your bearer token..."
                            value={token}
                            onChange={(e) => setToken(e.target.value)}
                            autoFocus
                        />
                    </div>
                    <button type="submit" className="btn btn-primary" disabled={loading || !token.trim()}>
                        {loading ? 'Validating...' : 'Sign In'}
                    </button>
                </form>
            </div>
        </div>
    );
}
