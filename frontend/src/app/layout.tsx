'use client';

import React from 'react';
import { AuthProvider, useAuth } from '../context/AuthContext';
import Sidebar from '../components/Sidebar';
import '../styles/globals.css';

function LayoutInner({ children }: { children: React.ReactNode }) {
    const { isAuthenticated, isLoading } = useAuth();

    return (
        <html lang="en">
            <body>
                {isAuthenticated && !isLoading ? (
                    <div className="app-layout">
                        <Sidebar />
                        <main className="main-content">{children}</main>
                    </div>
                ) : (
                    children
                )}
            </body>
        </html>
    );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
    return (
        <AuthProvider>
            <LayoutInner>{children}</LayoutInner>
        </AuthProvider>
    );
}
