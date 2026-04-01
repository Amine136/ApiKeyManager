/**
 * Provider adapter interface.
 * Each AI provider (Gemini, Imagen, OpenAI) implements this.
 */

export interface TextInputPart {
    type: 'text';
    text: string;
}

export interface ImageInputPart {
    type: 'image';
    mimeType: string;
    data: string;
}

export type ProxyInputPart = TextInputPart | ImageInputPart;

export interface ProxyInput {
    input: ProxyInputPart[];
    model: string;
    provider?: string;
    options?: {
        temperature?: number;
        topP?: number;
        thinkingBudget?: number;
        thinkingLevel?: 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH';
        maxTokens?: number;
        outputMimeType?: string;
        sampleCount?: number;
        aspectRatio?: string;
        imageSize?: string;
        personGeneration?: 'DONT_ALLOW' | 'ALLOW_ADULT';
        responseModalities?: Array<'TEXT' | 'IMAGE'>;
    };
}

export interface AdapterOutputs {
    text?: string;
    imageBase64?: string;
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
    outputs?: AdapterOutputs;
}

export interface ProviderAdapter {
    buildRequest(params: ProxyInput, apiKey: string): AdapterRequest;
    parseResponse(raw: any): AdapterResponse;
}

export function getTextParts(input: ProxyInput): TextInputPart[] {
    return input.input.filter((part): part is TextInputPart => part.type === 'text');
}

export function getImageParts(input: ProxyInput): ImageInputPart[] {
    return input.input.filter((part): part is ImageInputPart => part.type === 'image');
}

export function getCombinedTextPrompt(input: ProxyInput): string {
    return getTextParts(input)
        .map((part) => part.text.trim())
        .filter(Boolean)
        .join('\n\n');
}
