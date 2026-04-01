'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '../context/AuthContext';

const navItems = [
    { href: '/', label: 'Dashboard', icon: '📊' },
    { href: '/playground', label: 'Playground', icon: '🧪' },
    { href: '/providers', label: 'Providers', icon: '🔌' },
    { href: '/models', label: 'Models', icon: '🧠' },
    { href: '/keys', label: 'API Keys', icon: '🔑' },
    { href: '/rules', label: 'Rules', icon: '📋' },
    { href: '/clients', label: 'Clients', icon: '👥' },
];

export default function Sidebar() {
    const pathname = usePathname();
    const { logout } = useAuth();

    return (
        <aside className="sidebar">
            <div className="sidebar-logo">
                <div className="logo-icon">K</div>
                <div>
                    <h2>KeyManager</h2>
                    <span>API Proxy Admin</span>
                </div>
            </div>
            <nav className="sidebar-nav">
                {navItems.map((item) => (
                    <Link
                        key={item.href}
                        href={item.href}
                        className={pathname === item.href ? 'active' : ''}
                    >
                        <span className="nav-icon">{item.icon}</span>
                        {item.label}
                    </Link>
                ))}
            </nav>
            <div className="sidebar-footer">
                <button onClick={logout}>
                    <span className="nav-icon">🚪</span>
                    Sign Out
                </button>
            </div>
        </aside>
    );
}
