# API Key Manager
<img width="1298" height="653" alt="image" src="https://github.com/user-attachments/assets/7b93e097-6b28-41e1-8194-60eebf89319f" />

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
- ⏱️ **Shared Firestore-backed rate limiting** (RPM/RPH/RPD/TPM/TPD + cooldown)
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
NODE_ENV=development
PORT=3000
ENCRYPTION_KEY=<run: openssl rand -hex 32>
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_SERVICE_ACCOUNT_PATH=/absolute/path/to/serviceAccountKey.json
FRONTEND_URL=http://localhost:3001
GLOBAL_RATE_LIMIT_RPM=100
LOGIN_RATE_LIMIT_ATTEMPTS_PER_MINUTE=20
PROXY_RATE_LIMIT_PER_IP_PER_MINUTE=180
PROXY_RATE_LIMIT_PER_CLIENT_PER_MINUTE=600
CLIENT_LAST_USED_WRITE_INTERVAL_MS=300000
PROVIDER_REQUEST_TIMEOUT_MS=30000
CUSTOM_PROVIDER_ALLOWED_HOSTS=api.openai.com,generativelanguage.googleapis.com,api.anthropic.com,api.cloudflare.com
ALLOW_UNSAFE_CUSTOM_PROVIDER_URLS=true
```

Create `frontend/.env.local`:

```env
NEXT_PUBLIC_API_URL=
```

### 3. Create your first admin client

Before using the frontend, create an `ADMIN` token:

```bash
cd backend
npx tsx scripts/generate-admin.ts
```

The script prints the plaintext token once. Save it securely. It cannot be recovered later.

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

## Production Admin Access

For a production deployment, keep admin access separate from proxy usage.

### Credentials you need

- `username:` Nginx basic-auth username for the admin panel
- `password:` Nginx basic-auth password for the admin panel
- `admin token:` app-level `ADMIN` token used after the basic-auth prompt

### How to create them

#### 1. Nginx basic-auth username

Choose a fixed username, for example:

```text
admin-panel
```

#### 2. Nginx basic-auth password

Generate a strong password:

```bash
openssl rand -base64 24
```

Create the htpasswd entry:

```bash
USERNAME="admin-panel"
PASSWORD="$(openssl rand -base64 24 | tr -d '\n')"
HASH="$(openssl passwd -apr1 "$PASSWORD")"
printf '%s:%s\n' "$USERNAME" "$HASH"
```

Store the printed `USERNAME` and `PASSWORD` in your password manager. Put the printed `USERNAME:HASH` entry into your Nginx htpasswd file.

#### 3. App admin token

Create a new app-level `ADMIN` token:

```bash
cd backend
npx tsx scripts/generate-admin.ts
```

This token is only for the admin frontend login screen.

### Correct separation

- `ADMIN` token:
  - only for logging into the frontend admin panel
  - should be used only by you
- `CLIENT` token:
  - only for calling `/api/v1/proxy`
  - should be used by apps, scripts, and integrations

Never use the same token for both admin access and proxy usage.

## API Endpoints

### Admin Routes (admin session required)

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
3. Check shared rate limits (RPM/RPH/RPD/TPM/TPD + cooldown)
4. Sort by priority (lowest first)
5. Weighted random selection among same-priority keys
6. If no key available → return HTTP 429
