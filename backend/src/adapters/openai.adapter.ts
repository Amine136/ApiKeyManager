import { ProviderAdapter, ProxyInput, AdapterRequest, AdapterResponse } from './base.adapter.js';

export class OpenAIAdapter implements ProviderAdapter {
    buildRequest(params: ProxyInput, apiKey: string): AdapterRequest {
        const url = 'https://api.openai.com/v1/chat/completions';

        const body: any = {
            model: params.model,
            messages: [{ role: 'user', content: params.prompt }],
        };

        if (params.options?.temperature !== undefined) body.temperature = params.options.temperature;
        else body.temperature = 0.7;
        if (params.options?.maxTokens !== undefined) body.max_tokens = params.options.maxTokens;
        else body.max_tokens = 1024;

        return {
            url,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body,
        };
    }

    parseResponse(raw: any): AdapterResponse {
        const text = raw?.choices?.[0]?.message?.content ?? '';
        const usage = raw?.usage
            ? {
                promptTokens: raw.usage.prompt_tokens ?? 0,
                completionTokens: raw.usage.completion_tokens ?? 0,
            }
            : undefined;

        return { response: text, usage };
    }
}
