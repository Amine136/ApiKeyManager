import {
    ProviderAdapter,
    ProxyInput,
    AdapterRequest,
    AdapterResponse,
    getImageParts,
    getTextParts,
} from './base.adapter.js';

export class OpenAIAdapter implements ProviderAdapter {
    buildRequest(params: ProxyInput, apiKey: string): AdapterRequest {
        const url = 'https://api.openai.com/v1/chat/completions';

        const content: any[] = [
            ...getTextParts(params).map((part) => ({ type: 'text', text: part.text })),
            ...getImageParts(params).map((part) => ({
                type: 'image_url',
                image_url: {
                    url: `data:${part.mimeType};base64,${part.data}`,
                },
            })),
        ];

        const body: any = {
            model: params.model,
            messages: [{ role: 'user', content: content.length === 1 && content[0].type === 'text' ? content[0].text : content }],
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
