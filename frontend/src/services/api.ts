const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {
        ...((options.headers as Record<string, string>) || {}),
    };

    if (options.body !== undefined && !headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(`${API_URL}${path}`, {
        ...options,
        credentials: 'include',
        headers,
    });

    const data = await res.json();

    if (!res.ok) {
        throw new Error(data.message || `Request failed with status ${res.status}`);
    }

    return data;
}

export const api = {
    // Auth validation
    validateToken: () => request<any>('/api/v1/auth/me'),
    login: (token: string) => request<any>('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ token }) }),
    logout: () => request<any>('/api/v1/auth/logout', { method: 'POST' }),

    // Providers
    getProviders: () => request<any>('/api/v1/providers'),
    getProvider: (id: string) => request<any>(`/api/v1/providers/${id}`),
    createProvider: (data: any) => request<any>('/api/v1/providers', { method: 'POST', body: JSON.stringify(data) }),
    updateProvider: (id: string, data: any) => request<any>(`/api/v1/providers/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    deleteProvider: (id: string) => request<any>(`/api/v1/providers/${id}`, { method: 'DELETE' }),
    toggleProvider: (id: string) => request<any>(`/api/v1/providers/${id}/toggle`, { method: 'PATCH' }),

    // Keys
    getKeys: () => request<any>('/api/v1/keys'),
    createKey: (data: any) => request<any>('/api/v1/keys', { method: 'POST', body: JSON.stringify(data) }),
    deleteKey: (id: string) => request<any>(`/api/v1/keys/${id}`, { method: 'DELETE' }),
    toggleKey: (id: string) => request<any>(`/api/v1/keys/${id}/toggle`, { method: 'PATCH' }),

    // Clients
    getClients: () => request<any>('/api/v1/clients'),
    createClient: (data: any) => request<any>('/api/v1/clients', { method: 'POST', body: JSON.stringify(data) }),
    deleteClient: (id: string) => request<any>(`/api/v1/clients/${id}`, { method: 'DELETE' }),
    toggleClient: (id: string) => request<any>(`/api/v1/clients/${id}/toggle`, { method: 'PATCH' }),
    revokeClient: (id: string) => request<any>(`/api/v1/clients/${id}/revoke`, { method: 'POST' }),
    rotateClient: (id: string) => request<any>(`/api/v1/clients/${id}/rotate`, { method: 'POST' }),

    // Usage
    getDashboardBootstrap: (range: '1h' | 'today' | '7d' | '30d') => request<any>(`/api/v1/dashboard/bootstrap?range=${range}`),
    getUsageLogs: (params?: Record<string, string>) => {
        const query = params ? '?' + new URLSearchParams(params).toString() : '';
        return request<any>(`/api/v1/usage/logs${query}`);
    },
    getUsageStats: () => request<any>('/api/v1/usage/stats'),
    getUsageDashboard: (range: '1h' | 'today' | '7d' | '30d') => request<any>(`/api/v1/usage/dashboard?range=${range}`),

    // Models
    getModels: (providerId?: string) => {
        const q = providerId ? `?providerId=${providerId}` : '';
        return request<any>(`/api/v1/models${q}`);
    },
    createModel: (data: any) => request<any>('/api/v1/models', { method: 'POST', body: JSON.stringify(data) }),
    deleteModel: (id: string) => request<any>(`/api/v1/models/${id}`, { method: 'DELETE' }),

    // Key-Model Rules
    getKeyModelRules: (params?: { keyId?: string; modelName?: string }) => {
        const q = params ? '?' + new URLSearchParams(params as any).toString() : '';
        return request<any>(`/api/v1/key-model-rules${q}`);
    },
    createKeyModelRule: (data: any) => request<any>('/api/v1/key-model-rules', { method: 'POST', body: JSON.stringify(data) }),
    bulkCreateKeyModelRules: (data: any) => request<any>('/api/v1/key-model-rules/bulk', { method: 'POST', body: JSON.stringify(data) }),
    deleteKeyModelRule: (id: string) => request<any>(`/api/v1/key-model-rules/${id}`, { method: 'DELETE' }),
};
