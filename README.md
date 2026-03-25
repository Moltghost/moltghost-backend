# MoltGhost Backend

Standalone Express.js + TypeScript backend for the MoltGhost platform. Manages AI agent deployment, infrastructure provisioning (Cloudflare Tunnel + RunPod GPU), wallet-based authentication (Solana ed25519), field-level encryption (AES-256-GCM), and real-time updates via WebSocket.

---

## 📊 Privacy Scorecard

| Layer | Name | Status | Score |
|---|---|---|---|
| 1 | Inference | ✅ Implemented | 100% |
| 2 | Runtime | 🟡 Partial | 70% |
| 3 | Memory | ✅ Implemented | 95% |
| 4 | Filesystem | 🟡 Partial | 50% |
| 5 | Execution | 🟡 Partial | 40% |
| 6 | Network (Pod) | 🔴 Not Implemented | 20% |
| 7 | Browser Tool | 🟡 Partial | 50% |
| 8 | Secrets | ✅ Implemented | 90% |
| 9 | Tools | 🔴 Not Implemented | 10% |
| 10 | Skills | 🟡 Partial | 50% |
| 11 | Prompt Input | 🟡 Partial | 80% |
| 12 | Decision Layer | 🔴 Not Implemented | 0% |
| 13 | Agent Isolation | ✅ Implemented | 100% |
| 14 | Lifecycle | ✅ Implemented | 95% |
| 15 | Logging | 🟡 Partial | 60% |
| 16 | Network (Backend) | ✅ Implemented | 85% |
| 17 | Container Security | 🔴 Not Implemented | 10% |
| 18 | Memory Integrity | 🟡 Partial | 70% |
| 19 | Model Security | ✅ Implemented | 100% |
| 20 | Security Layer | 🟡 Partial | 75% |
| | **Overall** | | **~63%** |

---

## 🔒 Privacy Architecture Audit — 20 Layers

Audited against the **Fully Private OpenClaw** technical checklist. Each layer is rated:
- ✅ **Implemented** — production-ready
- 🟡 **Partial** — functional but has gaps
- 🔴 **Not Implemented** — missing, needs work

---

### Layer 1: Inference — Local Model Execution

**Status: ✅ Implemented**

| Aspect | Detail |
|---|---|
| Engine | Ollama runs locally on the RunPod GPU pod at `localhost:11434` |
| Model privacy | Model weights loaded into local VRAM — no external API calls |
| Config | `openclaw.json → models.providers.ollama.baseUrl = "http://localhost:11434"` |
| API key | Dummy value `"ollama-local"` (no real auth needed for localhost) |
| Warm-up | Post-callback VRAM warm-up loads model into GPU memory for fast inference |

Prompts, completions, and model weights never leave the pod. Zero data sent to OpenAI/Anthropic/etc.

---

### Layer 2: Runtime — Isolated Execution Environment

**Status: 🟡 Partial**

| Aspect | Detail |
|---|---|
| Compute | Dedicated RunPod GPU pod per user (no multi-tenant sharing) |
| Container | Docker-based pod with single-tenant isolation |
| Root | ⚠️ All processes run as `root` — no rootless container or unprivileged user |
| Sandbox | ⚠️ No seccomp profile, no AppArmor, no gVisor |
| Process isolation | Single pod = single user, but no intra-pod sandboxing between services |

**Gap:** Processes run as root with full kernel access. Should add `--user 1000:1000` and a seccomp profile to `dockerArgs`.

---

### Layer 3: Memory — Agent Memory Encryption

**Status: ✅ Implemented**

| Aspect | Detail |
|---|---|
| Storage | `memory` column encrypted with AES-256-GCM server-side before DB write |
| Encryption | `encryptJson()` on write → `decryptJson()` on read |
| Key | `DB_ENCRYPTION_KEY` env var (32 bytes / 64 hex) |
| Format | `iv:tag:ciphertext` (hex-encoded, unique IV per row) |

At-rest memory configuration is fully encrypted. Database admin (or attacker with DB access) sees only ciphertext.

> **Note:** On-pod runtime memory (OpenClaw agent's working memory at `/root/.openclaw/agents/main/agent/`) is stored in plaintext on the pod filesystem. This is acceptable since the pod is single-tenant and ephemeral.

---

### Layer 4: Filesystem — Workspace Data Protection

**Status: 🟡 Partial**

| Aspect | Detail |
|---|---|
| Layout | `/root/.openclaw/workspace/` for agent working files |
| Config | `/root/.openclaw/openclaw.json` contains gateway config + token |
| Encryption at rest | ⚠️ Pod filesystem is not encrypted (standard RunPod disk) |
| Cleanup | Pod deletion destroys the pod and its storage |
| Persistence | RunPod Network Volume (`RUNPOD_NETWORK_VOLUME_ID`) persists across pod restarts |

**Gap:** Filesystem is unencrypted at rest. Consider LUKS/dm-crypt for the workspace volume, or ensure Network Volume is deleted on deployment teardown.

---

### Layer 5: Execution — Code Execution Isolation

**Status: 🟡 Partial**

| Aspect | Detail |
|---|---|
| Runtime | OpenClaw gateway executes agent tasks via Node.js |
| Isolation | ⚠️ No sandbox (no Firecracker, no nsjail, no docker-in-docker) |
| Scope | Agent code runs in the same PID namespace as Ollama + cloudflared |
| Tool execution | OpenClaw may shell out for tool use — unconfined |

**Gap:** Agent-generated code runs unsandboxed. A malicious prompt could access Ollama, cloudflared, or the gateway process. Needs a code sandbox (e.g., nsjail, Firecracker microVM, or at minimum a restricted shell).

---

### Layer 6: Network — Pod Network Security

**Status: 🔴 Not Implemented**

| Aspect | Detail |
|---|---|
| Firewall | ⚠️ No `iptables` rules in startup script |
| Egress | Pod has unrestricted outbound internet access |
| Ingress | Only Cloudflare Tunnel (no direct port exposure) — this is good |
| Internal | Ollama (11434) + Gateway (3000) listen on all interfaces (`0.0.0.0`) |

**Gap:** No network egress filtering. The agent could exfiltrate data to arbitrary hosts. Should add iptables rules to restrict outbound traffic to only:
- `localhost` (Ollama ↔ Gateway)
- Cloudflare Tunnel IPs (for tunnel connectivity)
- MoltGhost backend (for callbacks/logs)

---

### Layer 7: Browser Tool — Web Access Control

**Status: 🟡 Partial**

| Aspect | Detail |
|---|---|
| Browser tool | Depends on OpenClaw's built-in browser agent capabilities |
| URL whitelist | ⚠️ No URL whitelist configured in `openclaw.json` |
| Content filtering | Delegated to OpenClaw (no MoltGhost-level override) |

**Gap:** No URL whitelist or domain filtering for browser-based tools. If OpenClaw supports `browserTool.allowedDomains`, it should be configured.

---

### Layer 8: Secrets — Credential Management

**Status: ✅ Implemented**

| Aspect | Detail |
|---|---|
| `tunnelToken` | AES-256-GCM encrypted in DB (server-side, `serverEncrypt`) |
| `tunnelId` | AES-256-GCM encrypted in DB (`encryptField`) |
| `dnsRecordId` | AES-256-GCM encrypted in DB (`encryptField`) |
| `podId` | AES-256-GCM encrypted in DB (`encryptField`) |
| Gateway token | Generated per deployment, passed via startup script env var |
| `DEPLOY_SECRET` | Header-based guard for internal endpoints |
| `WORKER_SECRET` | Header-based guard for pod → backend callbacks |
| In-transit | Cloudflare Tunnel = TLS; backend behind HTTPS in production |

All infrastructure credentials are encrypted at rest. Gateway token is ephemeral (per-pod lifetime).

> **Note:** Secrets are passed as plaintext environment variables inside the startup script (`export GATEWAY_TOKEN="..."`, `export TUNNEL_TOKEN="..."`). This is standard for cloud-init but could be improved with a secrets manager.

---

### Layer 9: Tools — Agent Tool Restrictions

**Status: 🔴 Not Implemented**

| Aspect | Detail |
|---|---|
| Tool whitelist | ⚠️ No `tools.allowed` or `tools.blocked` in `openclaw.json` |
| Tool audit | No logging of which tools the agent invokes |
| Tool permissions | Delegated entirely to OpenClaw defaults |

**Gap:** Agent has access to all OpenClaw tools by default. Should add a tool whitelist in `openclaw.json` to restrict to user-selected skills only (matching the `skills` field in deployment config).

---

### Layer 10: Skills — Agent Capability Boundaries

**Status: 🟡 Partial**

| Aspect | Detail |
|---|---|
| Skill selection | User selects skills (e.g., `["search", "code"]`) during deployment |
| Storage | Skills array encrypted in DB (`encryptJson`) |
| Enforcement | ⚠️ Skills are stored but NOT enforced at the OpenClaw config level |

**Gap:** The `skills` field is saved and encrypted, but `openclaw.json` does not map skills to tool permissions. The agent can use any tool regardless of selected skills.

---

### Layer 11: Prompt Input — Input Sanitization

**Status: 🟡 Partial**

| Aspect | Detail |
|---|---|
| Input handling | Prompts go directly from frontend → Cloudflare Tunnel → OpenClaw gateway |
| Prompt injection | Delegated to OpenClaw's built-in handling |
| Server-side validation | MoltGhost backend does NOT see prompts (they go direct to the agent) |
| ZKE fields | `agentName` and `agentDescription` are client-side encrypted — server never sees plaintext |

**Gap:** No MoltGhost-level prompt sanitization, but this is by design — prompts are private (they go directly to the user's own pod, never through MoltGhost backend).

---

### Layer 12: Decision Layer — Human-in-the-Loop

**Status: 🔴 Not Implemented**

| Aspect | Detail |
|---|---|
| HITL | ⚠️ No human-in-the-loop confirmation for destructive actions |
| Approval flow | Not configured in `openclaw.json` |
| Auto-approve | All agent actions are auto-approved |

**Gap:** Agent can execute any action without user confirmation. Should configure OpenClaw's HITL mode for destructive operations (file deletion, shell commands, etc.).

---

### Layer 13: Agent Isolation — Multi-Agent Boundaries

**Status: ✅ Implemented**

| Aspect | Detail |
|---|---|
| Per-user pod | Each deployment gets its own RunPod GPU pod |
| No cross-user access | Pods are network-isolated from each other |
| Auth | Gateway token is unique per deployment |
| Ownership | All API endpoints verify `deployment.userId === req.user` |
| Admin isolation | Admin endpoints require separate `ADMIN_WALLET` check |

Complete tenant isolation — one user cannot access another user's agent, pod, or data.

---

### Layer 14: Lifecycle — Deployment State Management

**Status: ✅ Implemented**

| Aspect | Detail |
|---|---|
| Status flow | `pending → provisioning → starting → running → stopped / failed` |
| Cleanup | `DELETE /api/deployments/:id` stops RunPod pod + deletes Cloudflare Tunnel + DNS |
| Error handling | Bootstrap script has `trap 'on_error $LINENO' ERR` for crash reporting |
| Watchdog | Background process monitors cloudflared + OpenClaw, restarts if crashed |
| Callback | Pod reports status back to backend via authenticated callback endpoint |

Full lifecycle management with cleanup, error recovery, and process watchdog.

---

### Layer 15: Logging — Log Privacy & Security

**Status: 🟡 Partial**

| Aspect | Detail |
|---|---|
| Server logs | Winston logger → local `logs/` directory (not shipped externally) |
| Pod logs | Sent to backend via `X-Worker-Secret` authenticated endpoint |
| DB logs | `deployment_logs.message` stored in plaintext |
| Sensitive data | Log messages may contain infra details (GPU name, disk usage, IPs) |

**Gap:** `deployment_logs.message` is NOT encrypted in the database. Consider encrypting with `encryptField()` for consistency with other fields.

---

### Layer 16: Network Access — Backend Network Security

**Status: ✅ Implemented**

| Aspect | Detail |
|---|---|
| CORS | Restricted to `FRONTEND_URL` origin |
| Auth | All user endpoints require JWT Bearer token |
| Internal | `X-Deploy-Secret` / `X-Worker-Secret` header guards |
| Admin | `requireAdminAuth` checks JWT + `ADMIN_WALLET` env var |
| WebSocket | JWT verification on connection handshake |
| Rate limiting | ⚠️ No rate limiting middleware (Express-level) |

**Gap:** No rate limiting. Should add `express-rate-limit` for auth endpoints (`/api/auth/login`, `/api/auth/nonce`).

---

### Layer 17: Container Security — Pod Hardening

**Status: 🔴 Not Implemented**

| Aspect | Detail |
|---|---|
| User | ⚠️ All processes run as `root` |
| Seccomp | ⚠️ No seccomp profile |
| Capabilities | ⚠️ No capability dropping (`--cap-drop ALL`) |
| Read-only rootfs | ⚠️ Filesystem is fully writable |
| Image signing | ⚠️ No image signature verification |

**Gap:** Pod has full root privileges with no kernel-level restrictions. This is the biggest security gap. Recommended hardening:
```bash
# In RunPod dockerArgs:
--user 1000:1000
--cap-drop ALL --cap-add NET_BIND_SERVICE
--security-opt seccomp=moltghost-seccomp.json
--read-only --tmpfs /tmp:rw,noexec,nosuid
```

---

### Layer 18: Memory Integrity — Runtime Memory Protection

**Status: 🟡 Partial**

| Aspect | Detail |
|---|---|
| DB encryption | All config fields encrypted at rest (14 fields AES-256-GCM) |
| In-memory | Application decrypts to plaintext in Node.js heap during request |
| Pod memory | Agent working memory lives in plaintext on pod (acceptable — single-tenant) |
| Key rotation | ⚠️ No key rotation mechanism for `DB_ENCRYPTION_KEY` |

**Gap:** No automated key rotation. If `DB_ENCRYPTION_KEY` is compromised, all historical data is exposed. Should implement versioned encryption keys.

---

### Layer 19: Model Security — Model Integrity & Privacy

**Status: ✅ Implemented**

| Aspect | Detail |
|---|---|
| Source | Models pulled from Ollama registry (pre-baked or on-demand) |
| Local inference | 100% local — no external API calls for inference |
| Model isolation | One model per pod, loaded into VRAM exclusively |
| Image | Pre-baked Docker image includes Ollama + model weights |
| Config | Model ID + metadata stored in DB (denormalized snapshot at deploy time) |

Model weights, inference input, and output never leave the GPU pod.

---

### Layer 20: Security Layer — Platform-Wide Security

**Status: 🟡 Partial**

| Aspect | Detail |
|---|---|
| Auth | Solana ed25519 wallet signature + self-issued JWT (no SaaS auth) |
| Nonce | One-time, 5-minute TTL, consumed on use |
| Encryption | AES-256-GCM server-side (14 fields) + client-side ZKE (2 fields) |
| Database | Self-hostable PostgreSQL via `pg` driver (no SaaS DB) |
| Dependencies | ⚠️ RunPod (GPU compute) and Cloudflare (DNS/Tunnel) remain SaaS dependencies |
| HTTPS | Enforced via Cloudflare Tunnel (TLS termination at edge) |
| Input validation | Basic Express JSON parsing, no schema validation (e.g., Zod) |

**Gap:** Two external SaaS dependencies remain:
- **RunPod** — could be replaced with bare-metal GPU servers + Kubernetes
- **Cloudflare Tunnel** — could be replaced with WireGuard/Tailscale self-hosted mesh

---

## 🔐 Encryption Field Map

### Server-Side AES-256-GCM (12 fields)

| Table | Column | Encryption |
|---|---|---|
| `users` | `email` | `encryptField()` |
| `users` | `display_name` | `encryptField()` |
| `users` | `avatar_url` | `encryptField()` |
| `deployments` | `skills` | `encryptJson()` |
| `deployments` | `memory` | `encryptJson()` |
| `deployments` | `agent_behavior` | `encryptJson()` |
| `deployments` | `notifications` | `encryptJson()` |
| `deployments` | `auto_sleep` | `encryptJson()` |
| `deployments` | `tunnel_id` | `encryptField()` |
| `deployments` | `tunnel_token` | `serverEncrypt()` |
| `deployments` | `dns_record_id` | `encryptField()` |
| `deployments` | `pod_id` | `encryptField()` |

### Client-Side Zero-Knowledge Encryption (2 fields)

| Table | Column | Encryption |
|---|---|---|
| `deployments` | `agent_name` | Web Crypto AES-256-GCM (wallet-derived key) |
| `deployments` | `agent_description` | Web Crypto AES-256-GCM (wallet-derived key) |

### Plaintext by Design

| Table | Column | Reason |
|---|---|---|
| `users` | `id` / `wallet_address` | Primary key / lookup index |
| `deployments` | `mode`, `status` | Enum values needed for queries/filtering |
| `deployments` | `model_*` | Public model metadata |
| `deployments` | `agent_domain` | Needed for DNS resolution |
| `deployments` | `created_at`, `updated_at` | Timestamps for ordering |
| `deployment_logs` | `message` | ⚠️ Should be encrypted (see Layer 15) |
| `models` | all columns | Public catalog data |

---

## Tech Stack

| Layer | Library |
|---|---|
| Runtime | Node.js 24 |
| Framework | Express.js 4 |
| Language | TypeScript 5 (strict mode) |
| Database | PostgreSQL + `pg` 8 + Drizzle ORM 0.41 |
| Auth | Self-issued JWT + Solana ed25519 wallet signature (`tweetnacl` + `bs58`) |
| Encryption | AES-256-GCM server-side (Node.js `crypto`) + client-side ZKE (Web Crypto API) |
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
│   │   ├── index.ts              # PostgreSQL client (pg Pool + Drizzle)
│   │   ├── schema.ts             # Table definitions + enums
│   │   └── seed.ts               # Seed data (models)
│   ├── lib/
│   │   ├── encryption.ts         # AES-256-GCM server-side encryption helpers
│   │   ├── cloudflare.ts         # Cloudflare Tunnel + DNS helpers
│   │   ├── logger.ts             # Winston logger (local file + console)
│   │   └── runpod.ts             # RunPod GraphQL + pod management
│   ├── middleware/
│   │   └── auth.ts               # requireAuth, requireAdminAuth, requireDeploySecret, requireWorkerSecret
│   ├── ws/
│   │   └── wsServer.ts           # WebSocket server + deployment event emitter
│   └── routes/
│       ├── auth.ts               # Wallet nonce + ed25519 login (JWT issuance)
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
| `JWT_SECRET` | Secret for signing JWTs (min 32 chars) |
| `DB_ENCRYPTION_KEY` | AES-256-GCM key (64 hex chars = 32 bytes). Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `ADMIN_WALLET` | Solana wallet address with admin privileges |
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

> All endpoints require `Authorization: Bearer <jwt-token>`.

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

> All endpoints (except internal) require `Authorization: Bearer <jwt-token>`.

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

Connect to `ws://localhost:3001/ws?token=<jwt-token>`.

### Flow

1. Client connects with JWT in the query string
2. Server verifies the token and sends confirmation:
   ```json
   { "type": "connected", "privyId": "<solana-wallet-address>" }
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
| `id` | text PK | Solana wallet address (public key) |
| `wallet_address` | text | Solana wallet address (mirror) |
| `email` | text | **Encrypted** (AES-256-GCM, nullable) |
| `display_name` | text | **Encrypted** (AES-256-GCM, nullable) |
| `avatar_url` | text | **Encrypted** (AES-256-GCM, nullable) |
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
| `agent_name` | text | **Client-side ZKE** (AES-256-GCM, wallet-derived key) |
| `agent_description` | text | **Client-side ZKE** (AES-256-GCM, wallet-derived key) |
| `mode` | enum | `dedicated`, `shared`, `external` |
| `model_id` | text FK | References `models.id` |
| `model_label/size/image/min_vram` | text/int | Snapshot of model at deploy time |
| `skills` | text | **Encrypted** (AES-256-GCM JSON blob) |
| `memory` | text | **Encrypted** (AES-256-GCM JSON blob) |
| `agent_behavior` | text | **Encrypted** (AES-256-GCM JSON blob) |
| `notifications` | text | **Encrypted** (AES-256-GCM JSON blob) |
| `auto_sleep` | text | **Encrypted** (AES-256-GCM JSON blob) |
| `status` | enum | `pending → provisioning → starting → running → stopped / failed` |
| `tunnel_id` | text | **Encrypted** (AES-256-GCM) — Cloudflare Tunnel ID |
| `tunnel_token` | text | **Encrypted** (AES-256-GCM) — Token for cloudflared |
| `agent_domain` | text | Agent subdomain (e.g. `agent-abc12345.moltghost.io`) |
| `dns_record_id` | text | **Encrypted** (AES-256-GCM) — Cloudflare DNS record ID |
| `pod_id` | text | **Encrypted** (AES-256-GCM) — RunPod pod ID |
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

> All endpoints require `Authorization: Bearer <jwt-token>`.

#### Get authenticated user profile

```
GET /api/users/me
```

Response: user object. The record is automatically created/updated when the token is verified.

```json
{
  "id": "<solana-wallet-address>",
  "walletAddress": "<solana-wallet-address>",
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
