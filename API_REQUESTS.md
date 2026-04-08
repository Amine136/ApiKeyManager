# API Request Guide

This file documents how to send requests to the ApiKeyManager proxy.

Base endpoint:

```text
POST /api/v1/proxy
```

Authentication:

```text
Authorization: Bearer <ADMIN_OR_CLIENT_TOKEN>
Content-Type: application/json
```

The proxy accepts the new multimodal `input` format and still supports the legacy `prompt` field for backward compatibility.

## 1. Recommended request format

```json
{
  "model": "gemini-3-pro-image-preview",
  "provider": "google-gemini",
  "input": [
    { "type": "text", "text": "Describe this product and make a matching ad image." },
    { "type": "image", "mimeType": "image/jpeg", "data": "<base64-image>" }
  ],
  "options": {
    "responseModalities": ["TEXT", "IMAGE"],
    "aspectRatio": "1:1",
    "imageSize": "1K"
  }
}
```

Input parts:

```json
{ "type": "text", "text": "..." }
{ "type": "image", "mimeType": "image/jpeg", "data": "<base64>" }
```

Supported output modalities:

```json
["TEXT"]
["IMAGE"]
["TEXT", "IMAGE"]
```

## 2. Legacy text-only request

```json
{
  "prompt": "Hello, world!",
  "model": "gemini-3.1-flash-lite-preview",
  "provider": "google-gemini",
  "options": {
    "temperature": 0.8,
    "maxTokens": 1024
  }
}
```

## 3. Text-only example

```bash
curl -s https://apikeymanager.ouni.space/api/v1/proxy \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "input": [
      { "type": "text", "text": "Say hello in one short sentence." }
    ],
    "model": "gemini-3.1-flash-lite-preview",
    "provider": "google-gemini",
    "options": {
      "temperature": 0.2,
      "maxTokens": 64
    }
  }'
```

## 4. Imagen text-to-image example

```bash
curl -s https://apikeymanager.ouni.space/api/v1/proxy \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "input": [
      { "type": "text", "text": "A cinematic desert landscape at sunset, ultra detailed, realistic lighting" }
    ],
    "model": "imagen-4.0-ultra-generate-001",
    "provider": "google-imagen",
    "options": {
      "aspectRatio": "1:1",
      "sampleCount": 1,
      "outputMimeType": "image/jpeg"
    }
  }' | jq -r '.data.response' | base64 -d > image.jpg
```

Note:
- Imagen currently supports text input only in this app.
- If you send image input to Imagen, the backend should reject it with `400`.

## 5. Gemini text + image output example

```bash
curl -s https://apikeymanager.ouni.space/api/v1/proxy \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "input": [
      { "type": "text", "text": "Create a product mockup for a modern coffee bag and also describe the design briefly." }
    ],
    "model": "gemini-3-pro-image-preview",
    "provider": "google-gemini",
    "options": {
      "responseModalities": ["TEXT", "IMAGE"],
      "aspectRatio": "1:1",
      "imageSize": "1K"
    }
  }' | jq
```

Save only the returned image:

```bash
curl -s https://apikeymanager.ouni.space/api/v1/proxy \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "input": [
      { "type": "text", "text": "Create a product mockup for a modern coffee bag and also describe the design briefly." }
    ],
    "model": "gemini-3-pro-image-preview",
    "provider": "google-gemini",
    "options": {
      "responseModalities": ["TEXT", "IMAGE"],
      "aspectRatio": "1:1",
      "imageSize": "1K"
    }
  }' | jq -er '.data.outputs.imageBase64' | base64 -d > gemini-image.jpg
```

Print only the returned text:

```bash
curl -s https://apikeymanager.ouni.space/api/v1/proxy \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "input": [
      { "type": "text", "text": "Create a product mockup for a modern coffee bag and also describe the design briefly." }
    ],
    "model": "gemini-3-pro-image-preview",
    "provider": "google-gemini",
    "options": {
      "responseModalities": ["TEXT", "IMAGE"],
      "aspectRatio": "1:1",
      "imageSize": "1K"
    }
  }' | jq -r '.data.outputs.text'
```

## 6. Gemini multimodal input example

```bash
curl -s https://apikeymanager.ouni.space/api/v1/proxy \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "input": [
      { "type": "text", "text": "Describe this uploaded image and generate a matching ad variation." },
      { "type": "image", "mimeType": "image/jpeg", "data": "<base64-image>" }
    ],
    "model": "gemini-3-pro-image-preview",
    "provider": "google-gemini",
    "options": {
      "responseModalities": ["TEXT", "IMAGE"],
      "aspectRatio": "1:1",
      "imageSize": "1K"
    }
  }'
```

## 7. Response shape

Text response:

```json
{
  "status": "success",
  "data": {
    "provider": "gemini-google",
    "model": "gemini-3.1-flash-lite-preview",
    "response": "Hello, it is nice to meet you!",
    "outputs": {
      "text": "Hello, it is nice to meet you!"
    },
    "usage": {
      "promptTokens": 8,
      "completionTokens": 9
    }
  },
  "meta": {
    "latencyMs": 6263,
    "keyLabel": "your-key-label"
  }
}
```

Image response:

```json
{
  "status": "success",
  "data": {
    "provider": "google-imagen",
    "model": "imagen-4.0-ultra-generate-001",
    "response": "<base64-image>",
    "outputs": {
      "imageBase64": "<base64-image>"
    },
    "usage": null
  },
  "meta": {
    "latencyMs": 14000,
    "keyLabel": "your-key-label"
  }
}
```

Multimodal Gemini response:

```json
{
  "status": "success",
  "data": {
    "provider": "gemini-google",
    "model": "gemini-3-pro-image-preview",
    "response": "<base64-image-or-text-fallback>",
    "outputs": {
      "text": "Brief description...",
      "imageBase64": "<base64-image>"
    },
    "usage": {
      "promptTokens": 123,
      "completionTokens": 45
    }
  },
  "meta": {
    "latencyMs": 9000,
    "keyLabel": "your-key-label"
  }
}
```

## 8. Important notes

- Use the model `name` field, not the UI `displayName`, in actual API requests.
- Requests are validated against each model's configured input/output capabilities.
- If a model only supports text input, image input will be rejected.
- If a model only supports text output, requesting `IMAGE` output will be rejected.
- Rotate any token that has been exposed in chat or logs.
