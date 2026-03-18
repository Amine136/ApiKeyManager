'use client';

import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { api } from '../services/api';

interface AuthContextType {
    isAuthenticated: boolean;
    isLoading: boolean;
    login: (token: string) => Promise<void>;
    logout: () => void;
}

const AuthContext = createContext<AuthContextType>({
    isAuthenticated: false,
    isLoading: true,
    login: async () => { },
    logout: () => { },
});

export function AuthProvider({ children }: { children: ReactNode }) {
    const [isAuthenticated, setIsAuthenticated] = useState(false);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        const timeout = setTimeout(() => setIsLoading(false), 5000);
        api.validateToken()
            .then(() => setIsAuthenticated(true))
            .catch(() => {
                setIsAuthenticated(false);
            })
            .finally(() => {
                clearTimeout(timeout);
                setIsLoading(false);
            });
    }, []);

    const login = async (token: string) => {
        try {
            await api.login(token);
            setIsAuthenticated(true);
        } catch (error: any) {
            throw new Error(error?.message || 'Invalid token');
        }
    };

    const logout = () => {
        api.logout().finally(() => {
            setIsAuthenticated(false);
        });
    };

    return (
        <AuthContext.Provider value={{ isAuthenticated, isLoading, login, logout }}>
            {children}
        </AuthContext.Provider>
    );
}

export const useAuth = () => useContext(AuthContext);
