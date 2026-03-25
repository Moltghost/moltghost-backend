// =============================================================================
// RunPod GPU Cloud API Client
// =============================================================================
// Provisions GPU pods (NVIDIA L4 / RTX 4090 / A40) for MoltGhost agents.
// Auth: API key via RUNPOD_API_KEY env var.
//
// Features:
//  - No quota requests needed
//  - GPU drivers pre-installed (CUDA runtime)
//  - Built-in HTTPS proxy (no Caddy needed)
//  - Simple GraphQL API
//  - ~$0.44/hr for L4 24GB
// =============================================================================

import type { CloudInitConfig } from "../types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunPodResult {
  podId: string;
  podName: string;
}

interface RunPodPort {
  ip: string;
  isIpPublic: boolean;
  privatePort: number;
  publicPort: number;
  type: string;
}

export interface RunPodInfo {
  id: string;
  name: string;
  desiredStatus: string;
  // runtime is null when pod is not yet running
  runtime: {
    uptimeInSeconds: number;
    ports: RunPodPort[];
    gpus: { id: string; gpuUtilPercent: number; memoryUtilPercent: number }[];
  } | null;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const RUNPOD_API = "https://api.runpod.io/graphql";

function getApiKey(): string {
  const key = process.env.RUNPOD_API_KEY;
  if (!key) throw new Error("RUNPOD_API_KEY is not set");
  return key;
}

function getGpuType(): string {
  return process.env.RUNPOD_GPU_TYPE || "NVIDIA L4";
}

function getCloudType(): string {
  // SECURE = data center only, COMMUNITY = cheaper p2p, ALL = both
  return process.env.RUNPOD_CLOUD_TYPE || "ALL";
}

function getVolumeSizeGb(): number {
  return parseInt(process.env.RUNPOD_VOLUME_GB || "75");
}

function getDiskSizeGb(): number {
  return parseInt(process.env.RUNPOD_DISK_GB || "20");
}

function getImageName(): string {
  return process.env.RUNPOD_IMAGE || "moltghost/moltghost-agent:latest";
}

// ---------------------------------------------------------------------------
// GraphQL helper
// ---------------------------------------------------------------------------

async function runpodQuery<T = Record<string, unknown>>(
  query: string,
  variables?: Record<string, unknown>,
  apiKey?: string,
): Promise<T> {
  const key = apiKey || getApiKey();
  const res = await fetch(RUNPOD_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`RunPod API HTTP ${res.status}: ${text}`);
  }

  const data = (await res.json()) as any;

  if (data.errors && data.errors.length > 0) {
    throw new Error(
      `RunPod API error: ${data.errors.map((e: { message: string }) => e.message).join(", ")}`,
    );
  }

  return data.data as T;
}

// ---------------------------------------------------------------------------
// Check GPU Availability
// ---------------------------------------------------------------------------

export interface GpuAvailability {
  id: string;
  displayName: string;
  available: boolean;
}

export async function checkGpuAvailability(
  gpuTypeIds: string[],
  apiKey?: string,
): Promise<GpuAvailability[]> {
  const query = `
    query GpuTypes {
      gpuTypes {
        id
        displayName
        communityCloud
        secureCloud
      }
    }
  `;

  const data = await runpodQuery<{
    gpuTypes: {
      id: string;
      displayName: string;
      communityCloud: boolean;
      secureCloud: boolean;
    }[];
  }>(query, undefined, apiKey);

  const gpuTypes = data.gpuTypes || [];

  return gpuTypeIds.map((requestedId) => {
    const gpu = gpuTypes.find((g) => g.id === requestedId);
    // A GPU is available if it exists and is offered in community or secure cloud
    const available = gpu
      ? gpu.communityCloud === true || gpu.secureCloud === true
      : false;
    return {
      id: requestedId,
      displayName: gpu?.displayName || requestedId,
      available,
    };
  });
}

// ---------------------------------------------------------------------------
// Create Pod (GPU instance)
// ---------------------------------------------------------------------------

export async function createPod(
  name: string,
  startupScript: string,
  gpuType?: string,
  imageName?: string,
  apiKey?: string,
): Promise<RunPodResult> {
  const selectedGpu = gpuType || getGpuType();
  const selectedImage = imageName || getImageName();
  const cloudType = getCloudType();
  const volumeSize = getVolumeSizeGb();
  const diskSize = getDiskSizeGb();

  // Encode startup script as base64 to pass safely via env var
  const scriptB64 = Buffer.from(startupScript).toString("base64");

  // Use GraphQL variables to avoid string escaping issues
  const query = `
    mutation CreatePod($input: PodFindAndDeployOnDemandInput!) {
      podFindAndDeployOnDemand(input: $input) {
        id
        imageName
        desiredStatus
        machineId
      }
    }
  `;

  const variables = {
    input: {
      name,
      imageName: selectedImage,
      gpuTypeId: selectedGpu,
      cloudType: cloudType,
      gpuCount: 1,
      ...(volumeSize > 0 ? { volumeInGb: volumeSize } : {}),
      containerDiskInGb: diskSize,
      ports: "3000/http,11434/http,22/tcp",
      startSsh: true,
      dockerArgs: `bash -c "echo $STARTUP_B64 | base64 -d > /tmp/startup.sh && chmod +x /tmp/startup.sh && nohup /tmp/startup.sh &> /var/log/startup.log & sleep 2 && tail -f /dev/null"`,
      env: [{ key: "STARTUP_B64", value: scriptB64 }],
    },
  };

  const data = await runpodQuery<{
    podFindAndDeployOnDemand: { id: string; desiredStatus: string };
  }>(query, variables, apiKey);

  const pod = data.podFindAndDeployOnDemand;
  if (!pod?.id) {
    throw new Error("RunPod did not return a pod ID");
  }

  return {
    podId: pod.id,
    podName: name,
  };
}

// ---------------------------------------------------------------------------
// Get Pod Info
// ---------------------------------------------------------------------------

export async function getPodInfo(podId: string): Promise<{
  status: string;
  proxyUrl: string | null;
  ip: string | null;
}> {
  const query = `
    query {
      pod(input: { podId: "${podId}" }) {
        id
        name
        desiredStatus
        lastStatusChange
        runtime {
          uptimeInSeconds
          ports {
            ip
            isIpPublic
            privatePort
            publicPort
            type
          }
          gpus {
            id
            gpuUtilPercent
            memoryUtilPercent
          }
        }
      }
    }
  `;

  const data = await runpodQuery<{ pod: RunPodInfo | null }>(query);

  if (!data.pod) {
    return { status: "not_found", proxyUrl: null, ip: null };
  }

  const pod = data.pod;

  // RunPod proxy URL for HTTP ports: https://{podId}-{port}.proxy.runpod.net
  const proxyUrl = `${podId}-3000.proxy.runpod.net`;

  // Get public IP if available from runtime ports
  let ip: string | null = null;
  if (pod.runtime?.ports) {
    const publicPort = pod.runtime.ports.find(
      (p) => p.isIpPublic && p.privatePort === 3000,
    );
    if (publicPort) {
      ip = publicPort.ip;
    }
  }

  // Map RunPod status to our status naming
  // RunPod desiredStatus: CREATED, RUNNING, EXITED, STOPPED, TERMINATED
  // runtime presence = actually running
  let status = pod.desiredStatus;

  if (pod.desiredStatus === "RUNNING" && pod.runtime) {
    status = "RUNNING";
  } else if (pod.desiredStatus === "RUNNING" && !pod.runtime) {
    status = "STARTING"; // desired running but no runtime yet
  } else if (
    pod.desiredStatus === "EXITED" ||
    pod.desiredStatus === "STOPPED"
  ) {
    status = "STOPPED";
  } else if (pod.desiredStatus === "TERMINATED") {
    status = "TERMINATED";
  }

  return { status, proxyUrl, ip };
}

// ---------------------------------------------------------------------------
// Stop Pod (preserves data, pauses billing)
// ---------------------------------------------------------------------------

export async function stopPod(podId: string): Promise<void> {
  const query = `
    mutation {
      podStop(input: { podId: "${podId}" }) {
        id
        desiredStatus
      }
    }
  `;

  await runpodQuery(query);
}

// ---------------------------------------------------------------------------
// Resume/Start Pod
// ---------------------------------------------------------------------------

export async function startPod(podId: string): Promise<void> {
  const gpuCount = 1;

  const query = `
    mutation {
      podResume(input: { podId: "${podId}", gpuCount: ${gpuCount} }) {
        id
        desiredStatus
      }
    }
  `;

  await runpodQuery(query);
}

// ---------------------------------------------------------------------------
// Delete/Terminate Pod (permanent)
// ---------------------------------------------------------------------------

export async function deletePod(podId: string, apiKey?: string): Promise<void> {
  const query = `
    mutation {
      podTerminate(input: { podId: "${podId}" }) 
    }
  `;

  try {
    await runpodQuery(query, undefined, apiKey);
  } catch (err) {
    // If pod already gone, that's fine — let the caller proceed
    const msg = String(err).toLowerCase();
    if (
      msg.includes("not found") ||
      msg.includes("already terminated") ||
      msg.includes("does not exist") ||
      msg.includes("no pod") ||
      msg.includes("pod_not_found")
    ) {
      return;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Build RunPod proxy URL
// ---------------------------------------------------------------------------

export function buildProxyUrl(podId: string, port: number = 3000): string {
  return `${podId}-${port}.proxy.runpod.net`;
}

// ---------------------------------------------------------------------------
// Get SSH connection info from RunPod runtime ports
// ---------------------------------------------------------------------------

export async function getSSHConnectionInfo(
  podId: string,
): Promise<{ host: string; port: number; username: string } | null> {
  const query = `
    query {
      pod(input: { podId: "${podId}" }) {
        id
        machine {
          podHostId
        }
        runtime {
          uptimeInSeconds
        }
      }
    }
  `;

  const data = await runpodQuery<{
    pod: {
      machine: { podHostId: string } | null;
      runtime: { uptimeInSeconds: number } | null;
    } | null;
  }>(query);

  if (!data.pod?.machine?.podHostId) return null;
  if (!data.pod.runtime) return null; // pod not yet running

  // Use RunPod SSH proxy — TCP direct ports are unreliable
  return {
    host: "ssh.runpod.io",
    port: 22,
    username: data.pod.machine.podHostId,
  };
}

// ---------------------------------------------------------------------------
// Startup Script Generator
// ---------------------------------------------------------------------------
// With the pre-baked Docker image (moltghost/moltghost-agent), Ollama,
// LLM model, OpenClaw, Node.js, and cloudflared are already installed.
// This script only needs to: start services, write config, and callback.
// ---------------------------------------------------------------------------

export function generateStartupScript(config: CloudInitConfig): string {
  const {
    agentId,
    agentDomain,
    gatewayToken,
    callbackUrl,
    callbackSecret,
    logUrl,
    tunnelToken,
    model,
  } = config;

  const ollamaModel = model || "qwen3:8b";

  // Model display name mapping
  const modelDisplayNames: Record<string, string> = {
    "qwen3:8b": "Qwen 3 8B",
    "phi4-mini": "Phi-4 Mini 3.8B",
  };
  const modelDisplayName = modelDisplayNames[ollamaModel] || ollamaModel;

  return `#!/bin/bash
set -eo pipefail

# =============================================================================
# MoltGhost Agent Bootstrap — Pre-baked Image (fast boot)
# =============================================================================
# Ollama + ${ollamaModel} + cloudflared + OpenClaw are pre-installed in the image.
# =============================================================================

export AGENT_ID="${agentId}"
export GATEWAY_TOKEN="${gatewayToken}"
export CALLBACK_URL="${callbackUrl}"
export CALLBACK_SECRET="${callbackSecret}"
export LOG_URL="${logUrl}"
export TUNNEL_TOKEN="${tunnelToken}"
export OLLAMA_MODEL="${ollamaModel}"
export PATH="/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:\$PATH"
export AGENT_DOMAIN="${agentDomain}"

LOG_FILE="/var/log/moltghost-bootstrap.log"

# ---------------------------------------------------------------------------
# log_step — logs locally AND sends to MoltGhost server in real-time
# ---------------------------------------------------------------------------
log_step() {
  local msg="\$1"
  local level="\${2:-info}"
  local phase="\${3:-deploy}"
  echo "[\$(date '+%H:%M:%S')] [\$level] \$msg" >> "\$LOG_FILE"
  echo "[\$(date '+%H:%M:%S')] [\$level] \$msg"
  # Sanitize for JSON: collapse newlines/tabs to spaces, escape backslashes + quotes, strip remaining control chars
  local safe
  safe=\$(printf '%s' "\$msg" | tr '\\n\\r\\t' '   ' | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g' | tr -d '\\000-\\037')
  local json
  json=\$(printf '{"message":"%s","level":"%s","phase":"%s"}' "\$safe" "\$level" "\$phase")
  curl -sSL -m 10 -X POST "\$LOG_URL" \\
    -H "Content-Type: application/json" \\
    -H "X-Worker-Secret: \$CALLBACK_SECRET" \
    -d "\$json" >> /var/log/moltghost-logpost.log 2>&1
}

on_error() {
  local line="\$1"
  log_step "Bootstrap FAILED at line \$line" error deploy
  sleep 3
  curl -sfL -m 15 -X POST "\$CALLBACK_URL" \\
    -H "Content-Type: application/json" \\
    -H "X-Worker-Secret: \$CALLBACK_SECRET" \
    -d "{\\"agentId\\":\\"\$AGENT_ID\\",\\"status\\":\\"error\\",\\"ip\\":\\"\$AGENT_DOMAIN\\",\\"domain\\":\\"\$AGENT_DOMAIN\\"}" || true
}
trap 'on_error \$LINENO' ERR

BOOT_START=\$(date +%s)
log_step "Bootstrap starting (pre-baked image) — pod \${RUNPOD_POD_ID:-unknown}" info deploy

# ------------------------------------------------------------------
# Connectivity test — debug why curl to server might fail
# ------------------------------------------------------------------
echo "[\$(date '+%H:%M:%S')] Testing connectivity to \$LOG_URL ..." >> "\$LOG_FILE"
CONN_HTTP=\$(curl -sSL -o /dev/null -w "%{http_code}" -m 10 -X POST "\$LOG_URL" \\
  -H "Content-Type: application/json" \\
  -H "X-Worker-Secret: \$CALLBACK_SECRET" \\
  -d '{"message":"_connectivity_test","level":"info","phase":"deploy"}' 2>&1) || CONN_HTTP="FAILED: \$?"
echo "[\$(date '+%H:%M:%S')] Connectivity result: \$CONN_HTTP" >> "\$LOG_FILE"
if [ "\$CONN_HTTP" != "200" ]; then
  echo "[\$(date '+%H:%M:%S')] [warn] Server unreachable (HTTP \$CONN_HTTP) — logs will only be available via SSH pull" >> "\$LOG_FILE"
  # Try DNS debug
  echo "[\$(date '+%H:%M:%S')] DNS test:" >> "\$LOG_FILE"
  nslookup moltghost.io >> "\$LOG_FILE" 2>&1 || echo "nslookup failed" >> "\$LOG_FILE"
  curl -v -m 5 "https://moltghost.io" >> "\$LOG_FILE" 2>&1 || true
fi

# ------------------------------------------------------------------
# GPU verification + SSH keys (instant)
# ------------------------------------------------------------------
if command -v nvidia-smi &>/dev/null; then
  GPU_NAME=\$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1 || echo "unknown")
  GPU_MEM=\$(nvidia-smi --query-gpu=memory.total --format=csv,noheader 2>/dev/null | head -1 || echo "unknown")
  log_step "GPU: \$GPU_NAME (\$GPU_MEM)" success deploy
else
  log_step "nvidia-smi not found — no GPU?" warn deploy
fi

mkdir -p /root/.ssh && chmod 700 /root/.ssh
echo "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFFmFfp9sWv3IF27u9Q6XfNYnouLcNNnDs3Fg9IZEpUF moltghost-platform" >> /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
log_step "SSH key injected" success deploy

# ==================================================================
# PARALLEL PHASE: Start Ollama + Clone/Build OpenClaw simultaneously
# ==================================================================
PARALLEL_START=\$(date +%s)

# ------------------------------------------------------------------
# [BACKGROUND] Start Ollama server
# ------------------------------------------------------------------
log_step "Starting Ollama..." info deploy
export OLLAMA_HOST=0.0.0.0:11434
export OLLAMA_KEEP_ALIVE=-1
nohup ollama serve > /var/log/ollama.log 2>&1 &
OLLAMA_PID=\$!

# ------------------------------------------------------------------
# [FOREGROUND WHILE OLLAMA STARTS] OpenClaw — skip build if baked
# ------------------------------------------------------------------
OPENCLAW_PHASE_START=\$(date +%s)
if [ -f /opt/openclaw-src/dist/index.js ]; then
  log_step "OpenClaw pre-built in image — ready" success deploy
  cd /opt/openclaw-src
else
  log_step "Cloning OpenClaw (latest)..." info deploy
  if [ -d /opt/openclaw-src/.git ]; then
    cd /opt/openclaw-src && git pull --ff-only 2>/dev/null || true
    log_step "OpenClaw updated" info deploy
  else
    git clone --depth 1 https://github.com/openclaw/openclaw.git /opt/openclaw-src
    log_step "OpenClaw cloned" success deploy
  fi

  cd /opt/openclaw-src

  log_step "Installing OpenClaw dependencies..." info deploy
  npm install --prefer-offline > /var/log/openclaw-npm.log 2>&1 || {
    log_step "npm install failed — check /var/log/openclaw-npm.log" error deploy
    tail -10 /var/log/openclaw-npm.log 2>/dev/null || true
    exit 1
  }
  log_step "npm install done" info deploy

  log_step "Building OpenClaw..." info deploy
  npm run build > /var/log/openclaw-build.log 2>&1 || {
    log_step "npm run build failed — check /var/log/openclaw-build.log" error deploy
    tail -10 /var/log/openclaw-build.log 2>/dev/null || true
    exit 1
  }

  if [ ! -f /opt/openclaw-src/dist/index.js ]; then
    log_step "OpenClaw build failed — dist/index.js missing" error deploy
    exit 1
  fi

  # Build Control UI assets (blocking — must finish before gateway starts)
  log_step "Building Control UI..." info deploy
  npm run ui:install > /var/log/openclaw-ui-install.log 2>&1 || {
    log_step "ui:install not available, trying npx..." info deploy
    npx --yes openclaw ui:install > /var/log/openclaw-ui-install.log 2>&1 || true
  }
  npm run ui:build > /var/log/openclaw-ui-build.log 2>&1 || {
    log_step "Control UI build failed — dashboard may show error" warn deploy
    tail -10 /var/log/openclaw-ui-build.log 2>/dev/null || true
  }
  if [ -d /opt/openclaw-src/ui/dist ] || [ -d /opt/openclaw-src/packages/gateway/ui ]; then
    log_step "Control UI built" success deploy
  else
    log_step "Control UI assets not found — checking alternative paths..." warn deploy
    # List available npm scripts for debugging
    SCRIPTS=\$(npm run 2>/dev/null | head -20 || echo "no scripts")
    log_step "Available scripts: \$SCRIPTS" info deploy
  fi
fi

OPENCLAW_PHASE_END=\$(date +%s)
OPENCLAW_TOTAL=\$((OPENCLAW_PHASE_END - OPENCLAW_PHASE_START))
log_step "OpenClaw built successfully [\${OPENCLAW_TOTAL}s]" success deploy

# Log OpenClaw version for display in dashboard
OPENCLAW_VERSION=\$(node -e "console.log(require('/opt/openclaw-src/package.json').version)" 2>/dev/null || echo "unknown")
OPENCLAW_COMMIT=\$(git -C /opt/openclaw-src rev-parse --short HEAD 2>/dev/null || echo "")
log_step "openclaw_version: v\${OPENCLAW_VERSION}\${OPENCLAW_COMMIT:+ (\$OPENCLAW_COMMIT)}" info deploy

# ------------------------------------------------------------------
# Wait for Ollama to be ready (should already be up by now)
# ------------------------------------------------------------------
OLLAMA_READY=false
for i in \$(seq 1 15); do
  if curl -sf http://localhost:11434/api/tags > /dev/null 2>&1; then
    OLLAMA_READY=true
    break
  fi
  sleep 2
done

if [ "\$OLLAMA_READY" = "true" ]; then
  log_step "Ollama running (PID \$OLLAMA_PID)" success deploy
else
  log_step "Ollama failed to start" error deploy
  tail -10 /var/log/ollama.log 2>/dev/null || true
  exit 1
fi

# Verify model is present (baked into image)
MODEL_LIST=\$(ollama list 2>/dev/null || echo "")
MODEL_CHECK=\$(echo "\$MODEL_LIST" | grep -c "\$OLLAMA_MODEL" || echo "0")
if [ "\$MODEL_CHECK" = "0" ]; then
  log_step "Model \$OLLAMA_MODEL NOT found — pulling..." warn deploy
  # Use Ollama HTTP API for streaming progress (CLI suppresses progress when piped)
  LAST_LOGGED_PCT=-1
  PULL_OK="false"
  curl -sN http://localhost:11434/api/pull -d "{\\\"name\\\":\\\"\\$OLLAMA_MODEL\\\"}" | while IFS= read -r line; do
    # Each line is JSON: {"status":"pulling ...","completed":N,"total":N} or {"status":"success"}
    if echo "\$line" | grep -q '"status":"success"'; then
      PULL_OK="true"
      echo "PULL_SUCCESS" > /tmp/ollama_pull_result
    fi
    COMPLETED=\$(echo "\$line" | grep -oE '"completed":[0-9]+' | head -1 | cut -d: -f2)
    TOTAL=\$(echo "\$line" | grep -oE '"total":[0-9]+' | head -1 | cut -d: -f2)
    if [ -n "\$COMPLETED" ] && [ -n "\$TOTAL" ] && [ "\$TOTAL" -gt 0 ]; then
      PCT=\$((COMPLETED * 100 / TOTAL))
      MILESTONE=\$((PCT / 10 * 10))
      if [ "\$MILESTONE" -gt "\$LAST_LOGGED_PCT" ] && [ "\$MILESTONE" -ge 10 ]; then
        LAST_LOGGED_PCT=\$MILESTONE
        # Convert bytes to human-readable
        if [ "\$TOTAL" -gt 1073741824 ]; then
          DONE_GB=\$(awk "BEGIN{printf \\"%.1f\\", \$COMPLETED/1073741824}")
          TOTAL_GB=\$(awk "BEGIN{printf \\"%.1f\\", \$TOTAL/1073741824}")
          log_step "Pulling \$OLLAMA_MODEL... \${MILESTONE}% (\${DONE_GB}GB/\${TOTAL_GB}GB)" info deploy
        else
          DONE_MB=\$((COMPLETED / 1048576))
          TOTAL_MB=\$((TOTAL / 1048576))
          log_step "Pulling \$OLLAMA_MODEL... \${MILESTONE}% (\${DONE_MB}MB/\${TOTAL_MB}MB)" info deploy
        fi
      fi
    fi
  done
  # Check pull result (subshell can't set parent vars, use temp file)
  if [ ! -f /tmp/ollama_pull_result ]; then
    ollama list 2>/dev/null | grep -q "\$OLLAMA_MODEL" || { log_step "Model pull failed" error deploy; exit 1; }
  fi
  rm -f /tmp/ollama_pull_result
fi
MODEL_SIZE=\$(du -sh /root/.ollama/models/ 2>/dev/null | awk '{print \$1}' || echo "?")
log_step "Model \$OLLAMA_MODEL ready (\$MODEL_SIZE)" success deploy

PARALLEL_END=\$(date +%s)
log_step "Ollama + OpenClaw ready (parallel) [\$((PARALLEL_END - PARALLEL_START))s]" success deploy

# ------------------------------------------------------------------
# OpenClaw Gateway config + start
# ------------------------------------------------------------------
PHASE_START=\$(date +%s)
log_step "Configuring OpenClaw Gateway..." info deploy
mkdir -p /root/.openclaw/workspace /root/.openclaw/agents/main/agent

cat > /root/.openclaw/openclaw.json <<JSONEOF
{
  "gateway": {
    "mode": "local",
    "bind": "lan",
    "port": 3000,
    "auth": {
      "mode": "token",
      "token": "\$GATEWAY_TOKEN"
    },
    "trustedProxies": ["172.16.0.0/12", "127.0.0.0/8", "10.0.0.0/8", "0.0.0.0/0"],
    "controlUi": {
      "allowedOrigins": ["https://\$AGENT_DOMAIN", "https://moltghost.io"],
      "dangerouslyDisableDeviceAuth": true
    }
  },
  "models": {
    "mode": "merge",
    "providers": {
      "ollama": {
        "apiKey": "ollama-local",
        "baseUrl": "http://localhost:11434",
        "api": "ollama",
        "models": [
          {
            "id": "\$OLLAMA_MODEL",
            "name": "${modelDisplayName}",
            "reasoning": false,
            "input": ["text"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 32768,
            "maxTokens": 8192
          }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "model": "ollama/\$OLLAMA_MODEL"
    }
  }
}
JSONEOF
log_step "OpenClaw config written" success deploy

# ==================================================================
# Start Gateway + Tunnel simultaneously
# ==================================================================
PHASE_START=\$(date +%s)

log_step "Starting OpenClaw Gateway..." info deploy
cd /opt/openclaw-src
export OPENCLAW_GATEWAY_TOKEN="\$GATEWAY_TOKEN"
export OPENCLAW_GATEWAY_BIND="lan"
export OPENCLAW_GATEWAY_PORT="3000"
export HOME=/root
nohup node dist/index.js gateway --bind lan --port 3000 > /var/log/openclaw.log 2>&1 &
OPENCLAW_PID=\$!

# Start tunnel RIGHT AWAY (don't wait for gateway — it'll connect as soon as gateway is up)
log_step "Starting Cloudflare Tunnel..." info deploy
nohup cloudflared tunnel --no-autoupdate run --token "\$TUNNEL_TOKEN" > /var/log/cloudflared.log 2>&1 &
CF_PID=\$!

# Wait for gateway to be ready (tunnel needs this)
OPENCLAW_READY=false
for i in \$(seq 1 15); do
  if curl -sf http://localhost:3000 > /dev/null 2>&1; then
    OPENCLAW_READY=true
    break
  fi
  sleep 2
done

if [ "\$OPENCLAW_READY" = "true" ]; then
  log_step "OpenClaw Gateway running (PID \$OPENCLAW_PID)" success deploy
else
  log_step "OpenClaw may still be starting..." warn deploy
fi

# Now verify tunnel is working (cloudflared has been running in parallel)
TUNNEL_READY=false
TUNNEL_ATTEMPTS=0
MAX_TUNNEL_ATTEMPTS=30  # 30 × 3s = ~90s total

while [ "\$TUNNEL_ATTEMPTS" -lt "\$MAX_TUNNEL_ATTEMPTS" ]; do
  TUNNEL_ATTEMPTS=\$((TUNNEL_ATTEMPTS + 1))

  # Check if cloudflared process is still alive — restart if crashed
  if ! kill -0 \$CF_PID 2>/dev/null; then
    CF_LOG=\$(tail -10 /var/log/cloudflared.log 2>/dev/null || echo "no log")
    log_step "cloudflared crashed (attempt \$TUNNEL_ATTEMPTS) — restarting. Log: \$CF_LOG" warn deploy
    nohup cloudflared tunnel --no-autoupdate run --token "\$TUNNEL_TOKEN" > /var/log/cloudflared.log 2>&1 &
    CF_PID=\$!
    sleep 3
    continue
  fi

  # Verify tunnel via domain (goes through Cloudflare edge → tunnel → localhost:3000)
  if curl -sf --max-time 5 "https://\$AGENT_DOMAIN" > /dev/null 2>&1; then
    TUNNEL_READY=true
    break
  fi

  # Also try 401 (gateway auth required = alive)
  HTTP_CODE=\$(curl -sf --max-time 5 -o /dev/null -w '%{http_code}' "https://\$AGENT_DOMAIN" 2>/dev/null || echo "000")
  if [ "\$HTTP_CODE" = "401" ] || [ "\$HTTP_CODE" = "200" ]; then
    TUNNEL_READY=true
    break
  fi

  # Log progress every 10 attempts
  if [ \$((TUNNEL_ATTEMPTS % 10)) -eq 0 ]; then
    CF_LOG=\$(tail -3 /var/log/cloudflared.log 2>/dev/null || echo "no log")
    log_step "Tunnel attempt \$TUNNEL_ATTEMPTS/\$MAX_TUNNEL_ATTEMPTS — HTTP \$HTTP_CODE. CF: \$CF_LOG" info deploy
  fi

  sleep 3
done

PHASE_END=\$(date +%s)
if [ "\$TUNNEL_READY" = "true" ]; then
  log_step "Tunnel active — https://\$AGENT_DOMAIN [\$((PHASE_END - PHASE_START))s]" success deploy
else
  CF_LOG=\$(tail -10 /var/log/cloudflared.log 2>/dev/null || echo "no log")
  log_step "Tunnel failed after \$MAX_TUNNEL_ATTEMPTS attempts. cloudflared log: \$CF_LOG" error deploy
  # Try one last restart
  kill \$CF_PID 2>/dev/null; wait \$CF_PID 2>/dev/null || true
  nohup cloudflared tunnel --no-autoupdate run --token "\$TUNNEL_TOKEN" > /var/log/cloudflared.log 2>&1 &
  CF_PID=\$!
  log_step "cloudflared restarted — tunnel may connect shortly" warn deploy
fi

# ------------------------------------------------------------------
# Callback — mark agent as running
# ------------------------------------------------------------------
DISK_USAGE=\$(df -h / 2>/dev/null | tail -1 | awk '{print \$3 "/" \$2 " (" \$5 ")"}' || echo "unknown")
MEM_USAGE=\$(free -h 2>/dev/null | awk '/^Mem:/{print \$3 "/" \$2}' || echo "unknown")
log_step "Disk: \$DISK_USAGE | RAM: \$MEM_USAGE" info deploy

log_step "Sending callback..." info deploy

CALLBACK_OK=false
for ATTEMPT in 1 2 3; do
  CALLBACK_RESULT=\$(curl -sfL -m 20 -X POST "\$CALLBACK_URL" \\
    -H "Content-Type: application/json" \\
    -H "X-Worker-Secret: \$CALLBACK_SECRET" \\
    -d "{\\"agentId\\":\\"\$AGENT_ID\\",\\"status\\":\\"running\\",\\"ip\\":\\"\$AGENT_DOMAIN\\",\\"domain\\":\\"\$AGENT_DOMAIN\\"}" 2>&1) || true

  if echo "\$CALLBACK_RESULT" | grep -q "success"; then
    CALLBACK_OK=true
    log_step "Agent live at https://\$AGENT_DOMAIN" success deploy
    break
  fi

  if [ "\$ATTEMPT" -lt 3 ]; then
    DELAY=\$((ATTEMPT * 5))
    log_step "Callback attempt \$ATTEMPT failed, retrying in \${DELAY}s..." warn deploy
    sleep \$DELAY
  fi
done

if [ "\$CALLBACK_OK" = "false" ]; then
  log_step "Callback failed after 3 attempts: \$CALLBACK_RESULT" error deploy
  log_step "Agent may still be reachable at https://\$AGENT_DOMAIN (health check will recover)" warn deploy
fi

BOOT_END=\$(date +%s)
BOOT_TOTAL=\$((BOOT_END - BOOT_START))
BOOT_MIN=\$((BOOT_TOTAL / 60))
BOOT_SEC=\$((BOOT_TOTAL % 60))
log_step "=== Bootstrap complete === Total: \${BOOT_MIN}m \${BOOT_SEC}s (\${BOOT_TOTAL}s)" success deploy

# ------------------------------------------------------------------
# POST-CALLBACK: VRAM warmup (background — user can already use agent)
# ------------------------------------------------------------------
log_step "Loading model into VRAM (background — agent is usable)..." info deploy
(
  WARMUP_RESULT=\$(curl -sf -m 180 http://localhost:11434/api/generate \\
    -d "{\\"model\\":\\"\$OLLAMA_MODEL\\",\\"prompt\\":\\"hi\\",\\"stream\\":false,\\"options\\":{\\"num_predict\\":1,\\"num_ctx\\":32768}}" 2>&1) || true
  if echo "\$WARMUP_RESULT" | grep -q "response"; then
    log_step "Model loaded into VRAM — ready for fast inference" success deploy
  else
    sleep 3
    curl -sf -m 180 http://localhost:11434/api/generate \\
      -d "{\\"model\\":\\"\$OLLAMA_MODEL\\",\\"prompt\\":\\"test\\",\\"stream\\":false,\\"options\\":{\\"num_predict\\":1}}" > /dev/null 2>&1 || true
    log_step "VRAM warmup retry done" info deploy
  fi
) &

# ------------------------------------------------------------------
# POST-CALLBACK: Watchdog — keep cloudflared + OpenClaw alive
# ------------------------------------------------------------------
(
  sleep 30  # Wait for things to settle
  while true; do
    # Check cloudflared
    if ! pgrep -x cloudflared > /dev/null 2>&1; then
      log_step "WATCHDOG: cloudflared died — restarting" warn runtime
      nohup cloudflared tunnel --no-autoupdate run --token "\$TUNNEL_TOKEN" > /var/log/cloudflared.log 2>&1 &
      sleep 10
    fi
    # Check OpenClaw gateway — verify by port (more reliable than process name)
    if ! curl -sf --max-time 3 http://localhost:3000 > /dev/null 2>&1 && \\
       ! curl -sf --max-time 3 -o /dev/null -w '%{http_code}' http://localhost:3000 2>/dev/null | grep -qE "200|401"; then
      # Double-check: is the process actually gone?
      if ! pgrep -f "dist/index.js" > /dev/null 2>&1; then
        log_step "WATCHDOG: OpenClaw gateway died — restarting" warn runtime
        cd /opt/openclaw-src
        export OPENCLAW_GATEWAY_TOKEN="\$GATEWAY_TOKEN"
        export OPENCLAW_GATEWAY_BIND="lan"
        export OPENCLAW_GATEWAY_PORT="3000"
        export HOME=/root
        nohup node dist/index.js gateway --bind lan --port 3000 > /var/log/openclaw.log 2>&1 &
        sleep 10
      fi
    fi
    # Check Ollama
    if ! pgrep -x ollama > /dev/null 2>&1; then
      log_step "WATCHDOG: Ollama died — restarting" warn runtime
      nohup ollama serve > /var/log/ollama.log 2>&1 &
      sleep 5
    fi
    sleep 30
  done
) &
WATCHDOG_PID=\$!
log_step "Watchdog started (PID \$WATCHDOG_PID) — monitoring cloudflared, OpenClaw, Ollama" info deploy
`;
}
