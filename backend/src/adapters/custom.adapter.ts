import { ProviderAdapter, AdapterRequest, AdapterResponse, ProxyInput } from './base.adapter.js';

/**
 * Custom provider adapter.
 * POSTs directly to the provider's baseUrl with:
 *   { prompt, model, options }
 * Expects back:
 *   { response: string, usage: { promptTokens, completionTokens } }
 */
export class CustomAdapter implements ProviderAdapter {
    private baseUrl: string;

    constructor(baseUrl: string) {
        this.baseUrl = baseUrl;
    }

    buildRequest(input: ProxyInput, apiKey: string): AdapterRequest {
        return {
            url: this.baseUrl,
            headers: {
                'Content-Type': 'application/json',
                ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
            },
            body: {
                prompt: input.prompt,
                model: input.model,
                options: input.options ?? {},
            },
        };
    }

    parseResponse(raw: any): AdapterResponse {
        return {
            response: raw.response ?? raw.text ?? JSON.stringify(raw),
            usage: raw.usage
                ? {
                    promptTokens: raw.usage.promptTokens ?? 0,
                    completionTokens: raw.usage.completionTokens ?? 0,
                }
                : undefined,
        };
    }
}
