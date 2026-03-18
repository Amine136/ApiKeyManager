import { ProviderAdapter, ProxyInput, AdapterRequest, AdapterResponse } from './base.adapter.js';

export class GeminiAdapter implements ProviderAdapter {
    buildRequest(params: ProxyInput, apiKey: string): AdapterRequest {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${params.model}:generateContent?key=${apiKey}`;

        const generationConfig: any = {};
        if (params.options?.temperature !== undefined) generationConfig.temperature = params.options.temperature;
        if (params.options?.topP !== undefined) generationConfig.topP = params.options.topP;
        if (params.options?.maxTokens !== undefined) generationConfig.maxOutputTokens = params.options.maxTokens;
        if (params.options?.thinkingBudget !== undefined) {
            generationConfig.thinkingConfig = { thinkingBudget: params.options.thinkingBudget };
        }

        const body: any = {
            contents: [{ role: 'user', parts: [{ text: params.prompt }] }],
        };

        if (Object.keys(generationConfig).length > 0) {
            body.generationConfig = generationConfig;
        }

        return {
            url,
            headers: { 'Content-Type': 'application/json' },
            body,
        };
    }

    parseResponse(raw: any): AdapterResponse {
        const text = raw?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
        const usage = raw?.usageMetadata
            ? {
                promptTokens: raw.usageMetadata.promptTokenCount ?? 0,
                completionTokens: raw.usageMetadata.candidatesTokenCount ?? 0,
            }
            : undefined;

        return { response: text, usage };
    }
}
