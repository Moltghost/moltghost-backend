# MoltGhost Backend

Standalone Express.js + TypeScript backend untuk platform MoltGhost. Mengelola deployment AI agent, provisioning infrastruktur (Cloudflare Tunnel + RunPod GPU), autentikasi via Privy, dan real-time updates via WebSocket.

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

## Struktur Project

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
│   │   └── runpod.ts             # RunPod GraphQL + pod management
│   ├── middleware/
│   │   └── auth.ts               # requireAuth, requireDeploySecret, requireWorkerSecret
│   ├── ws/
│   │   └── wsServer.ts           # WebSocket server + deployment event emitter
│   └── routes/
│       ├── models.ts             # GET /api/models
│       ├── runpod.ts             # GET /api/runpod/gpu-types
│       ├── deployments.ts        # Full deployment CRUD + orchestration + logs
│       └── users.ts              # GET|PATCH /api/users/me
├── scripts/
│   └── tunnel.sh                 # Auto-setup cloudflared quick tunnel + update .env
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

### 2. Konfigurasi environment

```bash
cp .env.example .env
```

Edit `.env` dengan nilai yang sesuai (lihat bagian [Environment Variables](#environment-variables)).

### 3. Generate + migrate database

```bash
pnpm db:generate   # generate SQL migration dari schema
pnpm db:migrate    # jalankan migration ke Neon DB
pnpm db:seed       # isi tabel models dengan data awal
```

### 4. Jalankan server

```bash
pnpm dev     # development (tsx watch)
pnpm build   # compile TypeScript ke dist/
pnpm start   # jalankan hasil build
```

Server berjalan di `http://localhost:3001` by default.

---

## Environment Variables

| Variable | Keterangan |
|---|---|
| `PORT` | Port server (default: `3001`) |
| `DATABASE_URL` | Neon PostgreSQL connection string |
| `PRIVY_APP_ID` | Privy App ID dari dashboard Privy |
| `PRIVY_APP_SECRET` | Privy App Secret dari dashboard Privy |
| `CLOUDFLARE_API_TOKEN` | CF API token dengan permission Zone DNS + Account Tunnel |
| `CLOUDFLARE_ZONE_ID` | Zone ID domain di Cloudflare |
| `CLOUDFLARE_ACCOUNT_ID` | Account ID Cloudflare |
| `CLOUDFLARE_TUNNEL_DOMAIN` | Base domain untuk agent subdomain (e.g. `moltghost.io`) |
| `RUNPOD_API_KEY` | API key dari RunPod |
| `RUNPOD_NETWORK_VOLUME_ID` | Network volume ID untuk persistent storage (e.g. `vol_xxxxxxxx`) |
| `RUNPOD_ALLOWED_GPU_IDS` | Comma-separated GPU display names yang diizinkan |
| `DEPLOY_SECRET` | Secret untuk internal orchestration endpoint (bebas diisi) |
| `WORKER_SECRET` | Secret untuk CF Worker → backend callback |
| `WORKER_URL` | URL Cloudflare Worker yang men-trigger orchestration |
| `BACKEND_PUBLIC_URL` | Public URL backend (dipakai pod untuk callback) |
| `FRONTEND_URL` | URL frontend untuk CORS (default: `http://localhost:3000`) |

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

#### List semua model aktif

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

> Semua endpoint memerlukan `Authorization: Bearer <privy-token>`.

#### List GPU types

```
GET /api/runpod/gpu-types
```

Response di-cache in-memory selama 5 menit.

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

> Semua endpoint (kecuali internal) memerlukan `Authorization: Bearer <privy-token>`.

#### List deployments milik user

```
GET /api/deployments
```

#### Detail deployment

```
GET /api/deployments/:id
```

#### Buat deployment baru

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

Setelah record dibuat, backend secara otomatis men-trigger orchestration:
- Jika `WORKER_URL` diset → fire CF Worker
- Jika tidak → panggil internal endpoint langsung (dev mode)

#### Hapus deployment

```
DELETE /api/deployments/:id
```

Menghentikan pod di RunPod, menghapus Cloudflare Tunnel + DNS record, dan mengubah status menjadi `stopped`. Response `204 No Content`.

---

### Deployment Logs

#### Ambil logs (paginated)

```
GET /api/deployments/:id/logs?limit=100
```

Response: array log entries (urutan ascending by time).

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

Real-time log stream via Server-Sent Events. Format event:

```
data: {"level":"info","message":"Downloading model..."}

event: status
data: {"status":"running"}
```

---

### Internal Endpoints

Header `X-Deploy-Secret: <DEPLOY_SECRET>` wajib ada.

#### Trigger orchestration

```
POST /api/deployments/internal/orchestrate
X-Deploy-Secret: <secret>

{ "deploymentId": "clx..." }
```

Flow yang dijalankan secara async:
1. Status → `provisioning`
2. Buat Cloudflare Tunnel
3. Buat DNS CNAME record
4. Generate startup script
5. Status → `starting`
6. Buat RunPod pod
7. Pod memanggil `/callback` saat siap → status → `running`

#### Pod callback (pod → backend)

```
POST /api/deployments/:id/callback
X-Worker-Secret: <secret>

{ "status": "running" }   // atau "failed"
```

#### Pod push log

```
POST /api/deployments/:id/logs
X-Worker-Secret: <secret>

{ "level": "info", "message": "..." }
```

---

## WebSocket

Connect ke `ws://localhost:3001/ws?token=<privy-jwt>`.

### Flow

1. Client connect dengan JWT di query string
2. Server verifikasi token, kirim konfirmasi:
   ```json
   { "type": "connected", "privyId": "did:privy:..." }
   ```
3. Client subscribe ke deployment:
   ```json
   { "type": "subscribe", "deploymentId": "clx..." }
   ```
4. Server kirim updates:
   ```json
   { "type": "log", "level": "info", "message": "..." }
   { "type": "status", "status": "running" }
   ```

### Close codes

| Code | Alasan |
|---|---|
| `4001` | Token tidak ada atau invalid |

---

## Database Schema

### `users`

| Column | Type | Keterangan |
|---|---|---|
| `id` | text PK | Privy user ID (`did:privy:...`) |
| `wallet_address` | text | EVM wallet address (dari linked accounts Privy) |
| `email` | text | Email address (nullable) |
| `display_name` | text | Nama tampil yang dapat diubah user |
| `avatar_url` | text | URL avatar (nullable) |
| `created_at` | timestamp | Waktu pertama kali login |
| `updated_at` | timestamp | Waktu terakhir update profil |

### `models`

| Column | Type | Keterangan |
|---|---|---|
| `id` | text PK | ID model (e.g. `qwen3-8b`) |
| `label` | text | Nama tampil |
| `size` | text | Ukuran model (e.g. `8B`) |
| `desc` | text | Deskripsi singkat |
| `recommended` | boolean | Ditampilkan sebagai rekomendasi |
| `image` | text | Docker image |
| `min_vram` | integer | Minimum VRAM dalam GB |
| `is_active` | boolean | Visible di frontend |

### `deployments`

| Column | Type | Keterangan |
|---|---|---|
| `id` | text PK | CUID2 |
| `user_id` | text FK | Referensi ke `users.id` |
| `mode` | enum | `dedicated`, `shared`, `external` |
| `model_id` | text FK | Referensi ke `models.id` |
| `model_label/size/image/min_vram` | text/int | Snapshot model saat deploy |
| `skills` | jsonb | Array skill yang diaktifkan |
| `memory` | jsonb | Konfigurasi memory agent |
| `agent_behavior` | jsonb | Konfigurasi behavior agent |
| `notifications` | jsonb | Konfigurasi notifikasi |
| `auto_sleep` | boolean | Auto sleep saat idle |
| `status` | enum | `pending → provisioning → starting → running → stopped / failed` |
| `tunnel_id` | text | Cloudflare Tunnel ID |
| `tunnel_token` | text | Token untuk cloudflared |
| `agent_domain` | text | Subdomain agent (e.g. `agent-abc12345.moltghost.io`) |
| `dns_record_id` | text | Cloudflare DNS record ID |
| `pod_id` | text | RunPod pod ID |

### `deployment_logs`

| Column | Type | Keterangan |
|---|---|---|
| `id` | text PK | CUID2 |
| `deployment_id` | text FK | Referensi ke `deployments.id` |
| `level` | text | `info`, `warn`, `error` |
| `message` | text | Isi log |
| `created_at` | timestamp | Waktu log masuk |

---

## Deployment Status Flow

```
POST /api/deployments
        │
        ▼
    [pending]
        │  (trigger orchestration)
        ▼
 [provisioning] ← CF Tunnel dibuat
        │
        ▼
  [starting] ← RunPod pod dibuat
        │
        ▼
  [running]  ← Pod callback konfirmasi siap
        │
        ▼  (DELETE /api/deployments/:id)
  [stopped]

  [failed]   ← Error di tahap mana pun
```

---

## Users API

> Semua endpoint memerlukan `Authorization: Bearer <privy-token>`.

#### Profile user (autentikasi saat ini)

```
GET /api/users/me
```

Response: user object. Record dibuat/diperbarui otomatis saat token diverifikasi.

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

#### Update profil

```
PATCH /api/users/me
Content-Type: application/json

{ "displayName": "Alice", "avatarUrl": "https://..." }
```

#### Semua deployment milik user (shortcut)

```
GET /api/users/me/deployments
```

Equivalent to `GET /api/deployments`.

---

## Integrasi Next.js

Tambahkan ke `.env.local` di project `moltghost-app-manager`:

```env
NEXT_PUBLIC_API_URL=http://localhost:3001
NEXT_PUBLIC_WS_URL=ws://localhost:3001/ws
```

---

## Scripts

| Script | Perintah |
|---|---|
| `pnpm dev` | Hot-reload development (tsx watch) |
| `pnpm build` | Compile TypeScript ke `dist/` |
| `pnpm start` | Jalankan `dist/index.js` |
| `pnpm db:generate` | Generate SQL migration dari schema |
| `pnpm db:migrate` | Jalankan migration |
| `pnpm db:seed` | Seed tabel models |
| `pnpm db:studio` | Buka Drizzle Studio (GUI) |
| `pnpm tunnel` | Jalankan cloudflared quick tunnel + auto-update `BACKEND_PUBLIC_URL` di `.env` |
