import {
    ProviderAdapter,
    ProxyInput,
    AdapterRequest,
    AdapterResponse,
    getImageParts,
    getTextParts,
} from './base.adapter.js';

export class GeminiAdapter implements ProviderAdapter {
    private isImageGenerationModel(model: string): boolean {
        return model.toLowerCase().includes('image');
    }

    private getResponseModalities(params: ProxyInput): Array<'TEXT' | 'IMAGE'> | undefined {
        if (params.options?.responseModalities && params.options.responseModalities.length > 0) {
            return params.options.responseModalities;
        }

        if (this.isImageGenerationModel(params.model)) {
            return ['IMAGE'];
        }

        return undefined;
    }

    buildRequest(params: ProxyInput, apiKey: string): AdapterRequest {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${params.model}:generateContent?key=${apiKey}`;

        const generationConfig: any = {};
        if (params.options?.temperature !== undefined) generationConfig.temperature = params.options.temperature;
        if (params.options?.topP !== undefined) generationConfig.topP = params.options.topP;
        if (params.options?.maxTokens !== undefined) generationConfig.maxOutputTokens = params.options.maxTokens;
        if (params.options?.thinkingBudget !== undefined) {
            generationConfig.thinkingConfig = { thinkingBudget: params.options.thinkingBudget };
        }
        if (params.options?.thinkingLevel) {
            generationConfig.thinkingConfig = { ...(generationConfig.thinkingConfig ?? {}), thinkingLevel: params.options.thinkingLevel };
        }

        const responseModalities = this.getResponseModalities(params);
        if (responseModalities) {
            generationConfig.responseModalities = responseModalities;
        }

        if (responseModalities?.includes('IMAGE')) {
            generationConfig.imageConfig = {
                aspectRatio: params.options?.aspectRatio ?? '1:1',
                imageSize: params.options?.imageSize ?? '1K',
            };
        }

        const body: any = {
            contents: [{
                role: 'user',
                parts: [
                    ...getTextParts(params).map((part) => ({ text: part.text })),
                    ...getImageParts(params).map((part) => ({
                        inlineData: {
                            mimeType: part.mimeType,
                            data: part.data,
                        },
                    })),
                ],
            }],
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
        const parts = raw?.candidates?.[0]?.content?.parts;
        const imageBase64 = Array.isArray(parts)
            ? parts.find((part: any) => typeof part?.inlineData?.data === 'string')?.inlineData?.data ?? ''
            : '';
        const text = Array.isArray(parts)
            ? parts
                .filter((part: any) => typeof part?.text === 'string')
                .map((part: any) => part.text.trim())
                .filter(Boolean)
                .join('\n')
            : '';
        const usage = raw?.usageMetadata
            ? {
                promptTokens: raw.usageMetadata.promptTokenCount ?? 0,
                completionTokens: raw.usageMetadata.candidatesTokenCount ?? 0,
            }
            : undefined;

        const outputs = {
            ...(text ? { text } : {}),
            ...(imageBase64 ? { imageBase64 } : {}),
        };

        return {
            response: imageBase64 || text,
            usage,
            outputs: Object.keys(outputs).length > 0 ? outputs : undefined,
        };
    }
}
