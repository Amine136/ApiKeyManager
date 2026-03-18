/**
 * Provider adapter interface.
 * Each AI provider (Gemini, Imagen, OpenAI) implements this.
 */

export interface ProxyInput {
    prompt: string;
    model: string;
    provider?: string;
    options?: {
        temperature?: number;
        topP?: number;
        thinkingBudget?: number;
        maxTokens?: number;
        outputMimeType?: string;
        sampleCount?: number;
        aspectRatio?: string;
    };
}

export interface AdapterRequest {
    url: string;
    headers: Record<string, string>;
    body: any;
}

export interface AdapterResponse {
    response: string; // text or base64
    usage?: {
        promptTokens: number;
        completionTokens: number;
    };
}

export interface ProviderAdapter {
    buildRequest(params: ProxyInput, apiKey: string): AdapterRequest;
    parseResponse(raw: any): AdapterResponse;
}
