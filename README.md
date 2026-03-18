# API Key Manager

A proxy server that manages API keys for AI providers (Google Gemini, Google Imagen, OpenAI). Sits between client apps and AI APIs, handling key rotation, encryption, rate limiting, and usage tracking.

## Architecture

```
Client App → [Bearer Token Auth] → Fastify Proxy → [Key Selection] → AI Provider
                                        ↓
                                   Firestore DB
                                  (providers, keys, clients, logs)
```

**Stack:** Fastify + TypeScript (backend) · Next.js 14 (frontend) · Firebase Firestore (database) · AES-256-GCM (encryption)

## Features

- 🔐 **AES-256-GCM encryption** for all API keys at rest
- 🔄 **Priority + weighted key selection** with automatic rotation
- ⏱️ **In-memory rate limiting** (RPM/RPH/RPD/TPM/TPD + cooldown)
- 🔌 **Adapter pattern** for providers (Gemini, Imagen, OpenAI)
- 👥 **ADMIN / CLIENT** role-based access
- 📊 **Dashboard** with usage stats and logs
- 🌙 **Dark theme** admin frontend

## Quick Start

### Prerequisites

- Node.js 18+
- Firebase project with Firestore enabled
- Service account JSON file

### 1. Clone and install

```bash
git clone <repo>
cd ApiKeyManagerNewVersion

# Backend
cd backend && npm install

# Frontend
cd ../frontend && npm install
```

### 2. Configure environment

```bash
# In project root
cp .env.example backend/.env
```

Edit `backend/.env`:

```env
PORT=3000
ENCRYPTION_KEY=<run: openssl rand -hex 32>
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_SERVICE_ACCOUNT_PATH=./serviceAccountKey.json
FRONTEND_URL=http://localhost:3001
GLOBAL_RATE_LIMIT_RPM=100
```

Place your Firebase `serviceAccountKey.json` in the `backend/` folder.

Create `frontend/.env.local`:

```env
NEXT_PUBLIC_API_URL=http://localhost:3000
```

### 3. Create your first admin client

Before using the frontend, you need an ADMIN token. Use this script:

```bash
# Generate a token and hash it
TOKEN=$(openssl rand -hex 32)
HASH=$(echo -n "$TOKEN" | sha256sum | cut -d' ' -f1)
echo "Your admin token: $TOKEN"
echo "SHA-256 hash: $HASH"
```

Then add a document to the `clients` Firestore collection:

```json
{
  "name": "Admin",
  "hashedToken": "<paste HASH here>",
  "role": "ADMIN",
  "isActive": true,
  "createdAt": "<timestamp>",
  "updatedAt": "<timestamp>"
}
```

### 4. Run

```bash
# Terminal 1 — Backend
cd backend && npm run dev

# Terminal 2 — Frontend
cd frontend && npm run dev
```

- Backend: http://localhost:3000
- Frontend: http://localhost:3001

### 5. Login

Open http://localhost:3001/login and paste your admin token.

## API Endpoints

### Admin Routes (ADMIN token required)

| Method | Path | Description |
|--------|------|-------------|
| GET/POST | `/api/v1/providers` | List / create providers |
| GET/PUT/DELETE | `/api/v1/providers/:id` | Get / update / delete provider |
| PATCH | `/api/v1/providers/:id/toggle` | Toggle provider active status |
| GET/POST | `/api/v1/keys` | List / create API keys |
| DELETE | `/api/v1/keys/:id` | Delete API key |
| PATCH | `/api/v1/keys/:id/toggle` | Toggle key status |
| GET/POST | `/api/v1/clients` | List / create clients |
| DELETE | `/api/v1/clients/:id` | Delete client |
| GET | `/api/v1/usage/logs` | Get usage logs |
| GET | `/api/v1/usage/stats` | Get usage statistics |

### Proxy Route (any valid token)

```
POST /api/v1/proxy
```

**Request:**
```json
{
  "prompt": "Hello, world!",
  "model": "gemini-2.5-flash",
  "provider": "google-gemini",
  "options": {
    "temperature": 0.8,
    "maxTokens": 1024
  }
}
```

**Response (200):**
```json
{
  "status": "success",
  "data": {
    "provider": "gemini-prod",
    "model": "gemini-2.5-flash",
    "response": "Hello! ...",
    "usage": { "promptTokens": 5, "completionTokens": 42 }
  },
  "meta": { "latencyMs": 850, "keyLabel": "gemini-key-1" }
}
```

## Data Model

| Collection | Key Fields |
|-----------|-----------|
| `providers` | name, displayName, type (`google-gemini` / `google-imagen` / `openai` / `custom`), supportedModels[], isActive |
| `apiKeys` | providerId, label, encryptedKey (`iv:tag:cipher`), status, priority, weight, rules |
| `clients` | name, hashedToken (SHA-256), role (`ADMIN` / `CLIENT`), isActive |
| `usageLogs` | apiKeyId, clientId, model, providerName, status, latencyMs, tokens |

## Key Selection Algorithm

1. Find active provider by type/name
2. Get all ACTIVE keys for that provider
3. Check in-memory rate limits (RPM/RPH/RPD/TPM/TPD + cooldown)
4. Sort by priority (lowest first)
5. Weighted random selection among same-priority keys
6. If no key available → return HTTP 429
