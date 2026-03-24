# MoltGhost Backend

Standalone Express.js + TypeScript backend for the MoltGhost platform. Manages AI agent deployment, infrastructure provisioning (Cloudflare Tunnel + RunPod GPU), authentication via Privy, and real-time updates via WebSocket.

---

## Tech Stack

| Layer | Library |
|---|---|
| Runtime | Node.js 24 |
| Framework | Express.js 4 |
| Language | TypeScript 5 (strict mode) |
| Database | Neon Serverless PostgreSQL + Drizzle ORM |
| Auth | `@privy-io/node` v0.1.0 |
| WebSocket | `ws` 8 |
| Infrastructure | Cloudflare Tunnel API + RunPod GraphQL API |
| Package Manager | pnpm |

---

## Project Structure

```
moltghost-backend/
├── src/
│   ├── index.ts                  # Entry point (Express + HTTP + WebSocket)
│   ├── types/
│   │   └── index.ts              # Global types + Express Request augmentation
│   ├── db/
│   │   ├── index.ts              # Neon DB client (Drizzle)
│   │   ├── schema.ts             # Table definitions + enums
│   │   └── seed.ts               # Seed data (models)
│   ├── lib/
│   │   ├── privy.ts              # Privy client singleton
│   │   ├── cloudflare.ts         # Cloudflare Tunnel + DNS helpers
│   │   ├── logger.ts             # Winston logger (local file + console)
│   │   └── runpod.ts             # RunPod GraphQL + pod management
│   ├── middleware/
│   │   └── auth.ts               # requireAuth, requireDeploySecret, requireWorkerSecret
│   ├── ws/
│   │   └── wsServer.ts           # WebSocket server + deployment event emitter
│   └── routes/
│       ├── models.ts             # GET /api/models
│       ├── runpod.ts             # GET /api/runpod/gpu-types
│       ├── deployments.ts        # Full deployment CRUD + orchestration + logs
│       ├── users.ts              # GET|PATCH /api/users/me
│       └── admin.ts              # Admin endpoints (users, deployments, stats)
├── scripts/
│   └── tunnel.sh                 # Auto-setup cloudflared quick tunnel + update .env
├── drizzle/                      # Generated SQL migrations
├── logs/                         # Local log files (Winston)
├── drizzle.config.ts
├── .env.example
├── package.json
└── tsconfig.json
```

---

## Setup

### 1. Install dependencies

```bash
pnpm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with the appropriate values (see [Environment Variables](#environment-variables)).

### 3. Generate + migrate database

```bash
pnpm db:generate   # generate SQL migration from schema
pnpm db:migrate    # run migration against the database
pnpm db:seed       # populate models table with initial data
```

### 4. Run the server

```bash
pnpm dev     # development (tsx watch)
pnpm build   # compile TypeScript to dist/
pnpm start   # run compiled build
```

Server runs on `http://localhost:3001` by default.

---

## Environment Variables

| Variable | Description |
|---|---|
| `PORT` | Server port (default: `3001`) |
| `DATABASE_URL` | PostgreSQL connection string |
| `PRIVY_APP_ID` | Privy App ID from the Privy dashboard |
| `PRIVY_APP_SECRET` | Privy App Secret from the Privy dashboard |
| `CLOUDFLARE_API_TOKEN` | CF API token with Zone DNS + Account Tunnel permissions |
| `CLOUDFLARE_ZONE_ID` | Zone ID of the domain on Cloudflare |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID |
| `CLOUDFLARE_TUNNEL_DOMAIN` | Base domain for agent subdomains (e.g. `moltghost.io`) |
| `RUNPOD_API_KEY` | API key from RunPod |
| `RUNPOD_NETWORK_VOLUME_ID` | Network volume ID for persistent storage (e.g. `vol_xxxxxxxx`) |
| `RUNPOD_ALLOWED_GPU_IDS` | Comma-separated GPU display names that are allowed |
| `DEPLOY_SECRET` | Secret for internal orchestration endpoint |
| `WORKER_SECRET` | Secret for CF Worker → backend callback |
| `WORKER_URL` | URL of the Cloudflare Worker that triggers orchestration |
| `BACKEND_PUBLIC_URL` | Public URL of the backend (used by pods for callbacks) |
| `FRONTEND_URL` | Frontend URL for CORS (default: `http://localhost:3000`) |

---

## API Reference

### Health Check

```
GET /health
```

Response:
```json
{ "status": "ok", "ts": "2026-03-22T..." }
```

---

### Models

#### List all active models

```
GET /api/models
```

Response: array of model objects.

```json
[
  {
    "id": "qwen3-8b",
    "label": "Qwen3 8B",
    "size": "8B",
    "desc": "Fast general-purpose model",
    "recommended": true,
    "image": "moltghost/qwen3-8b:latest",
    "minVram": 8,
    "isActive": true,
    "createdAt": "..."
  }
]
```

---

### RunPod

> All endpoints require `Authorization: Bearer <privy-token>`.

#### List GPU types

```
GET /api/runpod/gpu-types
```

Response is cached in-memory for 5 minutes.

```json
[
  {
    "id": "NVIDIA_L4",
    "displayName": "NVIDIA L4",
    "memoryInGb": 24,
    "securePrice": 0.44,
    "communityPrice": 0.28,
    "lowestPrice": { "minimumBidPrice": 0.2, "uninterruptablePrice": 0.28 }
  }
]
```

---

### Deployments

> All endpoints (except internal) require `Authorization: Bearer <privy-token>`.

#### List deployments for the authenticated user

```
GET /api/deployments
```

#### Get deployment details

```
GET /api/deployments/:id
```

#### Create a new deployment

```
POST /api/deployments
Content-Type: application/json

{
  "mode": "dedicated",            // "dedicated" | "shared" | "external"
  "modelId": "qwen3-8b",
  "modelLabel": "Qwen3 8B",
  "modelSize": "8B",
  "modelImage": "moltghost/qwen3-8b:latest",
  "modelMinVram": 8,
  "skills": ["search", "code"],
  "memory": {
    "enablePrivateMemory": true,
    "persistentMemory": true,
    "encryption": false
  },
  "agentBehavior": { ... },
  "notifications": { ... },
  "autoSleep": true
}
```

Response `201`:
```json
{ "id": "clx...", "status": "pending", ... }
```

After the record is created, the backend automatically triggers orchestration:
- If `WORKER_URL` is set → fires CF Worker
- Otherwise → calls the internal endpoint directly (dev mode)

#### Delete a deployment

```
DELETE /api/deployments/:id
```

Stops the pod on RunPod, removes the Cloudflare Tunnel + DNS record, and sets the status to `stopped`. Returns `204 No Content`.

---

### Deployment Logs

#### Fetch logs (paginated)

```
GET /api/deployments/:id/logs?limit=100
```

Response: array of log entries (ascending order by time).

```json
[
  { "id": "...", "deploymentId": "...", "level": "info", "message": "Pod started", "createdAt": "..." }
]
```

#### Stream logs (SSE)

```
GET /api/deployments/:id/logs/stream
Accept: text/event-stream
```

Real-time log stream via Server-Sent Events. Event format:

```
data: {"level":"info","message":"Downloading model..."}

event: status
data: {"status":"running"}
```

---

### Internal Endpoints

The `X-Deploy-Secret: <DEPLOY_SECRET>` header is required.

#### Trigger orchestration

```
POST /api/deployments/internal/orchestrate
X-Deploy-Secret: <secret>

{ "deploymentId": "clx..." }
```

Asynchronous flow:
1. Status → `provisioning`
2. Create Cloudflare Tunnel
3. Create DNS CNAME record
4. Generate startup script
5. Status → `starting`
6. Create RunPod pod
7. Pod calls `/callback` when ready → status → `running`

#### Pod callback (pod → backend)

```
POST /api/deployments/:id/callback
X-Worker-Secret: <secret>

{ "status": "running" }   // or "failed"
```

#### Pod push log

```
POST /api/deployments/:id/logs
X-Worker-Secret: <secret>

{ "level": "info", "message": "..." }
```

---

## WebSocket

Connect to `ws://localhost:3001/ws?token=<privy-jwt>`.

### Flow

1. Client connects with JWT in the query string
2. Server verifies the token and sends confirmation:
   ```json
   { "type": "connected", "privyId": "did:privy:..." }
   ```
3. Client subscribes to a deployment:
   ```json
   { "type": "subscribe", "deploymentId": "clx..." }
   ```
4. Server sends updates:
   ```json
   { "type": "log", "level": "info", "message": "..." }
   { "type": "status", "status": "running" }
   ```

### Close Codes

| Code | Reason |
|---|---|
| `4001` | Token missing or invalid |

---

## Database Schema

### `users`

| Column | Type | Description |
|---|---|---|
| `id` | text PK | Privy user ID (`did:privy:...`) |
| `wallet_address` | text | Solana wallet address (from Privy linked accounts) |
| `email` | text | Email address (nullable) |
| `display_name` | text | User-editable display name |
| `avatar_url` | text | Avatar URL (nullable) |
| `created_at` | timestamp | First login time |
| `updated_at` | timestamp | Last profile update time |

### `models`

| Column | Type | Description |
|---|---|---|
| `id` | text PK | Model ID (e.g. `qwen3-8b`) |
| `label` | text | Display name |
| `size` | text | Model size (e.g. `8B`) |
| `desc` | text | Short description |
| `recommended` | boolean | Shown as recommended |
| `image` | text | Docker image |
| `min_vram` | integer | Minimum VRAM in GB |
| `is_active` | boolean | Visible on frontend |

### `deployments`

| Column | Type | Description |
|---|---|---|
| `id` | text PK | CUID2 |
| `user_id` | text FK | References `users.id` |
| `agent_name` | text | User-defined agent name |
| `agent_description` | text | User-defined agent description |
| `mode` | enum | `dedicated`, `shared`, `external` |
| `model_id` | text FK | References `models.id` |
| `model_label/size/image/min_vram` | text/int | Snapshot of model at deploy time |
| `skills` | jsonb | Array of enabled skills |
| `memory` | jsonb | Agent memory configuration |
| `agent_behavior` | jsonb | Agent behavior configuration |
| `notifications` | jsonb | Notification configuration |
| `auto_sleep` | jsonb | Auto-sleep configuration |
| `status` | enum | `pending → provisioning → starting → running → stopped / failed` |
| `tunnel_id` | text | Cloudflare Tunnel ID |
| `tunnel_token` | text | Token for cloudflared |
| `agent_domain` | text | Agent subdomain (e.g. `agent-abc12345.moltghost.io`) |
| `dns_record_id` | text | Cloudflare DNS record ID |
| `pod_id` | text | RunPod pod ID |
| `created_at` | timestamp | Creation time |
| `updated_at` | timestamp | Last update time |

### `deployment_logs`

| Column | Type | Description |
|---|---|---|
| `id` | text PK | CUID2 |
| `deployment_id` | text FK | References `deployments.id` (cascade delete) |
| `level` | text | `info`, `warn`, `error` |
| `message` | text | Log content |
| `created_at` | timestamp | Log entry time |

---

## Deployment Status Flow

```
POST /api/deployments
        │
        ▼
    [pending]
        │  (trigger orchestration)
        ▼
 [provisioning] ← CF Tunnel created
        │
        ▼
  [starting] ← RunPod pod created
        │
        ▼
  [running]  ← Pod callback confirms ready
        │
        ▼  (DELETE /api/deployments/:id)
  [stopped]

  [failed]   ← Error at any stage
```

---

## Users API

> All endpoints require `Authorization: Bearer <privy-token>`.

#### Get authenticated user profile

```
GET /api/users/me
```

Response: user object. The record is automatically created/updated when the token is verified.

```json
{
  "id": "did:privy:...",
  "walletAddress": "0xabc...",
  "email": null,
  "displayName": null,
  "avatarUrl": null,
  "createdAt": "...",
  "updatedAt": "..."
}
```

#### Update profile

```
PATCH /api/users/me
Content-Type: application/json

{ "displayName": "Alice", "avatarUrl": "https://..." }
```

#### List all deployments for the authenticated user

```
GET /api/users/me/deployments
```

Equivalent to `GET /api/deployments`.

---

## Next.js Integration

Add the following to `.env.local` in the `moltghost-app-manager` project:

```env
NEXT_PUBLIC_API_URL=http://localhost:3001
NEXT_PUBLIC_WS_URL=ws://localhost:3001/ws
```

---

## Scripts

| Script | Command |
|---|---|
| `pnpm dev` | Hot-reload development (tsx watch) |
| `pnpm build` | Compile TypeScript to `dist/` |
| `pnpm start` | Run `dist/index.js` |
| `pnpm db:generate` | Generate SQL migration from schema |
| `pnpm db:migrate` | Run migrations |
| `pnpm db:seed` | Seed the models table |
| `pnpm db:studio` | Open Drizzle Studio (GUI) |
| `pnpm tunnel` | Run cloudflared quick tunnel + auto-update `BACKEND_PUBLIC_URL` in `.env` |
