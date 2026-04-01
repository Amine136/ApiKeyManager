'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '../../context/AuthContext';
import { api } from '../../services/api';

interface Provider {
    id: string;
    name: string;
    type: string;
}

interface Model {
    id: string;
    name: string;
    displayName: string;
    providerId: string;
}

type ResponseModality = 'TEXT' | 'IMAGE';

function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = typeof reader.result === 'string' ? reader.result : '';
            const [, base64 = ''] = result.split(',');
            resolve(base64);
        };
        reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
        reader.readAsDataURL(file);
    });
}

export default function PlaygroundPage() {
    const { isAuthenticated, isLoading } = useAuth();
    const router = useRouter();

    const [providers, setProviders] = useState<Provider[]>([]);
    const [models, setModels] = useState<Model[]>([]);
    const [loading, setLoading] = useState(true);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [response, setResponse] = useState<any>(null);

    const [providerId, setProviderId] = useState('');
    const [model, setModel] = useState('');
    const [bearerToken, setBearerToken] = useState('');
    const [prompt, setPrompt] = useState('');
    const [imagePart, setImagePart] = useState<{ mimeType: string; data: string; previewUrl: string; name: string } | null>(null);
    const [includeText, setIncludeText] = useState(true);
    const [includeImageInput, setIncludeImageInput] = useState(false);
    const [includeTextOutput, setIncludeTextOutput] = useState(true);
    const [includeImageOutput, setIncludeImageOutput] = useState(false);
    const [aspectRatio, setAspectRatio] = useState('1:1');
    const [imageSize, setImageSize] = useState('1K');
    const [temperature, setTemperature] = useState('0.7');
    const [maxTokens, setMaxTokens] = useState('1024');

    useEffect(() => {
        if (!isLoading && !isAuthenticated) {
            router.push('/login');
        }
    }, [isAuthenticated, isLoading, router]);

    useEffect(() => {
        if (!isAuthenticated) return;

        Promise.all([api.getProviders(), api.getModels()])
            .then(([providersRes, modelsRes]) => {
                const providerData = providersRes.data as Provider[];
                const modelData = modelsRes.data as Model[];
                setProviders(providerData);
                setModels(modelData);

                const defaultProvider = providerData.find((provider) => provider.type === 'google-gemini')
                    ?? providerData.find((provider) => provider.type === 'google-imagen')
                    ?? providerData[0];

                if (defaultProvider) {
                    setProviderId(defaultProvider.id);
                    const firstModel = modelData.find((entry) => entry.providerId === defaultProvider.id);
                    if (firstModel) setModel(firstModel.name);
                }
            })
            .catch((fetchError: any) => {
                setError(fetchError.message ?? 'Failed to load playground data');
            })
            .finally(() => setLoading(false));
    }, [isAuthenticated]);

    const selectedProvider = providers.find((provider) => provider.id === providerId) ?? null;
    const filteredModels = useMemo(
        () => models.filter((entry) => entry.providerId === providerId),
        [models, providerId]
    );

    const responseImage = response?.data?.outputs?.imageBase64
        ? `data:image/png;base64,${response.data.outputs.imageBase64}`
        : response?.data?.response && includeImageOutput
            ? `data:image/png;base64,${response.data.response}`
            : null;

    const responseText = response?.data?.outputs?.text ?? (typeof response?.data?.response === 'string' && !responseImage ? response.data.response : '');

    const handleProviderChange = (nextProviderId: string) => {
        setProviderId(nextProviderId);
        const nextModel = models.find((entry) => entry.providerId === nextProviderId);
        setModel(nextModel?.name ?? '');
    };

    const handleImageChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) {
            setImagePart(null);
            return;
        }

        const data = await fileToBase64(file);
        setImagePart({
            mimeType: file.type || 'image/jpeg',
            data,
            previewUrl: URL.createObjectURL(file),
            name: file.name,
        });
        setIncludeImageInput(true);
    };

    const handleSubmit = async (event: React.FormEvent) => {
        event.preventDefault();
        setError(null);
        setResponse(null);

        const input: any[] = [];
        if (includeText && prompt.trim()) {
            input.push({ type: 'text', text: prompt });
        }
        if (includeImageInput && imagePart) {
            input.push({ type: 'image', mimeType: imagePart.mimeType, data: imagePart.data });
        }

        if (input.length === 0) {
            setError('Add text, an image, or both.');
            return;
        }

        if (!bearerToken.trim()) {
            setError('Bearer token is required for proxy requests.');
            return;
        }

        const responseModalities: ResponseModality[] = [];
        if (includeTextOutput) responseModalities.push('TEXT');
        if (includeImageOutput) responseModalities.push('IMAGE');

        const payload: any = {
            provider: selectedProvider?.type ?? undefined,
            model,
            input,
            options: {
                maxTokens: Number(maxTokens) || undefined,
                temperature: Number(temperature),
            },
        };

        if (responseModalities.length > 0) {
            payload.options.responseModalities = responseModalities;
        }
        if (includeImageOutput) {
            payload.options.aspectRatio = aspectRatio;
            payload.options.imageSize = imageSize;
        }
        if (selectedProvider?.type === 'google-imagen') {
            payload.options.outputMimeType = 'image/jpeg';
            payload.options.sampleCount = 1;
        }

        Object.keys(payload.options).forEach((key) => {
            if (payload.options[key] === undefined || payload.options[key] === '') {
                delete payload.options[key];
            }
        });

        setSubmitting(true);
        try {
            const result = await api.proxy(payload, bearerToken.trim());
            setResponse(result);
        } catch (submitError: any) {
            setError(submitError.message ?? 'Request failed');
        } finally {
            setSubmitting(false);
        }
    };

    if (isLoading || !isAuthenticated) return null;

    return (
        <div className="playground-page">
            <div className="page-header">
                <div>
                    <h1>Playground</h1>
                    <p>Small admin-only tester for the new multimodal proxy input format.</p>
                </div>
            </div>

            <div className="playground-grid">
                <section className="card">
                    <div className="card-header">
                        <h3>Request</h3>
                    </div>
                    <div className="card-body">
                        <form onSubmit={handleSubmit}>
                            <div className="grid-2">
                                <div className="form-group">
                                    <label>Provider</label>
                                    <select className="form-control" value={providerId} onChange={(event) => handleProviderChange(event.target.value)}>
                                        {providers.map((provider) => (
                                            <option key={provider.id} value={provider.id}>{provider.name} ({provider.type})</option>
                                        ))}
                                    </select>
                                </div>

                                <div className="form-group">
                                    <label>Model</label>
                                    <select className="form-control" value={model} onChange={(event) => setModel(event.target.value)}>
                                        {filteredModels.map((entry) => (
                                            <option key={entry.id} value={entry.name}>{entry.displayName || entry.name}</option>
                                        ))}
                                    </select>
                                </div>
                            </div>

                            <div className="form-group">
                                <label>Bearer Token</label>
                                <input
                                    className="form-control"
                                    type="password"
                                    value={bearerToken}
                                    onChange={(event) => setBearerToken(event.target.value)}
                                    placeholder="Paste an ADMIN or CLIENT token for /api/v1/proxy"
                                />
                            </div>

                            <div className="form-group">
                                <label>Text Input</label>
                                <textarea
                                    className="form-control playground-textarea"
                                    value={prompt}
                                    onChange={(event) => setPrompt(event.target.value)}
                                    placeholder="Describe the task or the image transformation you want."
                                />
                                <label className="playground-check">
                                    <input type="checkbox" checked={includeText} onChange={(event) => setIncludeText(event.target.checked)} />
                                    <span>Include text part in request</span>
                                </label>
                            </div>

                            <div className="form-group">
                                <label>Image Input</label>
                                <input className="form-control" type="file" accept="image/*" onChange={handleImageChange} />
                                <label className="playground-check">
                                    <input
                                        type="checkbox"
                                        checked={includeImageInput}
                                        onChange={(event) => setIncludeImageInput(event.target.checked)}
                                        disabled={!imagePart}
                                    />
                                    <span>Include uploaded image part in request</span>
                                </label>
                                {imagePart && (
                                    <div className="playground-preview">
                                        <img src={imagePart.previewUrl} alt={imagePart.name} />
                                        <div>
                                            <strong>{imagePart.name}</strong>
                                            <p>{imagePart.mimeType}</p>
                                        </div>
                                    </div>
                                )}
                            </div>

                            <div className="grid-2">
                                <div className="form-group">
                                    <label>Temperature</label>
                                    <input className="form-control" value={temperature} onChange={(event) => setTemperature(event.target.value)} />
                                </div>

                                <div className="form-group">
                                    <label>Max Tokens</label>
                                    <input className="form-control" value={maxTokens} onChange={(event) => setMaxTokens(event.target.value)} />
                                </div>
                            </div>

                            <div className="grid-2">
                                <div className="form-group">
                                    <label>Output Modalities</label>
                                    <div className="playground-check-group">
                                        <label className="playground-check">
                                            <input type="checkbox" checked={includeTextOutput} onChange={(event) => setIncludeTextOutput(event.target.checked)} />
                                            <span>Text</span>
                                        </label>
                                        <label className="playground-check">
                                            <input type="checkbox" checked={includeImageOutput} onChange={(event) => setIncludeImageOutput(event.target.checked)} />
                                            <span>Image</span>
                                        </label>
                                    </div>
                                </div>

                                <div className="form-group">
                                    <label>Image Size</label>
                                    <select className="form-control" value={imageSize} onChange={(event) => setImageSize(event.target.value)} disabled={!includeImageOutput}>
                                        <option value="1K">1K</option>
                                        <option value="2K">2K</option>
                                    </select>
                                </div>
                            </div>

                            <div className="form-group">
                                <label>Aspect Ratio</label>
                                <select className="form-control" value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value)} disabled={!includeImageOutput}>
                                    <option value="1:1">1:1</option>
                                    <option value="16:9">16:9</option>
                                    <option value="9:16">9:16</option>
                                    <option value="4:3">4:3</option>
                                    <option value="3:4">3:4</option>
                                </select>
                            </div>

                            {error && <div className="playground-error">{error}</div>}

                            <div className="playground-actions">
                                <button type="submit" className="btn btn-primary" disabled={submitting}>
                                    {submitting ? 'Sending...' : 'Send Request'}
                                </button>
                            </div>
                        </form>
                    </div>
                </section>

                <section className="card">
                    <div className="card-header">
                        <h3>Response</h3>
                    </div>
                    <div className="card-body playground-response-card">
                        {responseText ? (
                            <div className="playground-response-block">
                                <h4>Text</h4>
                                <pre>{responseText}</pre>
                            </div>
                        ) : null}

                        {responseImage ? (
                            <div className="playground-response-block">
                                <h4>Image</h4>
                                <img className="playground-result-image" src={responseImage} alt="Generated output" />
                            </div>
                        ) : null}

                        <div className="playground-response-block">
                            <h4>Raw JSON</h4>
                            <pre>{response ? JSON.stringify(response, null, 2) : 'No response yet.'}</pre>
                        </div>
                    </div>
                </section>
            </div>
        </div>
    );
}
