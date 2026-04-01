import {
    ProviderAdapter,
    ProxyInput,
    AdapterRequest,
    AdapterResponse,
    getCombinedTextPrompt,
    getImageParts,
} from './base.adapter.js';

export class ImagenAdapter implements ProviderAdapter {
    buildRequest(params: ProxyInput, apiKey: string): AdapterRequest {
        if (getImageParts(params).length > 0) {
            throw new Error('Imagen requests currently support text input only');
        }

        // Imagen uses "models/" prefix in the URL path, e.g. "models/imagen-4.0-generate-001"
        const modelPath = params.model.startsWith('models/') ? params.model : `models/${params.model}`;
        const url = `https://generativelanguage.googleapis.com/v1beta/${modelPath}:predict?key=${apiKey}`;

        const parameters: any = {
            personGeneration: 'ALLOW_ADULT',
            imageSize: '1K',
        };
        if (params.options?.outputMimeType) parameters.outputMimeType = params.options.outputMimeType;
        else parameters.outputMimeType = 'image/jpeg';
        if (params.options?.sampleCount !== undefined) parameters.sampleCount = params.options.sampleCount;
        else parameters.sampleCount = 1;
        if (params.options?.aspectRatio) parameters.aspectRatio = params.options.aspectRatio;
        else parameters.aspectRatio = '1:1';

        const body = {
            instances: [{ prompt: getCombinedTextPrompt(params) }],
            parameters,
        };

        return {
            url,
            headers: { 'Content-Type': 'application/json' },
            body,
        };
    }

    parseResponse(raw: any): AdapterResponse {
        const base64 = raw?.predictions?.[0]?.bytesBase64Encoded ?? '';
        return { response: base64 };
    }
}
