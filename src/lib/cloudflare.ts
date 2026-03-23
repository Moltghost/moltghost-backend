// =============================================================================
// Cloudflare Tunnel + DNS
// =============================================================================
// Creates a Cloudflare Tunnel for each agent pod, then points a DNS CNAME
// to the tunnel.  This gives each agent a subdomain like:
//
//   agent-{shortId}.moltghost.io  →  Cloudflare edge  →  tunnel  →  pod:3000
//
// No public IP needed.  SSL handled by Cloudflare.  Works inside RunPod NAT.
//
// Requires env:
//   CLOUDFLARE_API_TOKEN   — with Zone:DNS:Edit + Account:Cloudflare Tunnel:Edit
//   CLOUDFLARE_ZONE_ID     — zone ID for moltghost.io
//   CLOUDFLARE_ACCOUNT_ID  — account ID (get from CF dashboard → overview)
// =============================================================================

import { randomBytes } from "crypto";

const CF_API = "https://api.cloudflare.com/client/v4";

function getToken(): string {
  const t = process.env.CLOUDFLARE_API_TOKEN;
  if (!t) throw new Error("CLOUDFLARE_API_TOKEN not set");
  return t;
}

function getZoneId(): string {
  const z = process.env.CLOUDFLARE_ZONE_ID;
  if (!z) throw new Error("CLOUDFLARE_ZONE_ID not set");
  return z;
}

function getAccountId(): string {
  const a = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!a) throw new Error("CLOUDFLARE_ACCOUNT_ID not set");
  return a;
}

// ---------------------------------------------------------------------------
// Build subdomain name
// ---------------------------------------------------------------------------
export function buildAgentSubdomain(agentId: string): string {
  const shortId = agentId.slice(0, 8);
  return `agent-${shortId}.moltghost.io`;
}

// ---------------------------------------------------------------------------
// 1. Create Cloudflare Tunnel
// ---------------------------------------------------------------------------
export async function createTunnel(
  agentId: string,
): Promise<{ tunnelId: string; tunnelToken: string }> {
  const accountId = getAccountId();
  const token = getToken();
  const tunnelSecret = randomBytes(32).toString("base64");

  // Create tunnel
  const res = await fetch(`${CF_API}/accounts/${accountId}/cfd_tunnel`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: `moltghost-${agentId.slice(0, 8)}`,
      tunnel_secret: tunnelSecret,
      config_src: "cloudflare",
    }),
  });

  const data = (await res.json()) as any;
  if (!data.success) {
    const errors =
      data.errors?.map((e: { message: string }) => e.message).join(", ") ||
      "Unknown error";
    throw new Error(`Tunnel create failed: ${errors}`);
  }

  const tunnelId = data.result.id;

  // Configure ingress rules
  const subdomain = buildAgentSubdomain(agentId);
  await fetch(
    `${CF_API}/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        config: {
          ingress: [
            { hostname: subdomain, service: "http://localhost:3000" },
            { service: "http_status:404" },
          ],
        },
      }),
    },
  );

  // Get tunnel token
  const tokenRes = await fetch(
    `${CF_API}/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    },
  );

  const tokenData = (await tokenRes.json()) as any;
  if (!tokenData.success) {
    throw new Error("Failed to get tunnel token");
  }

  return { tunnelId, tunnelToken: tokenData.result as string };
}

// ---------------------------------------------------------------------------
// 2. Create DNS CNAME → tunnel
// ---------------------------------------------------------------------------
export async function createTunnelDns(
  subdomain: string,
  tunnelId: string,
): Promise<{ recordId: string; name: string }> {
  const zoneId = getZoneId();
  const token = getToken();

  const res = await fetch(`${CF_API}/zones/${zoneId}/dns_records`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "CNAME",
      name: subdomain,
      content: `${tunnelId}.cfargotunnel.com`,
      proxied: true,
      ttl: 1,
      comment: "MoltGhost agent tunnel — auto-created",
    }),
  });

  const data = (await res.json()) as any;
  if (!data.success) {
    const errors =
      data.errors?.map((e: { message: string }) => e.message).join(", ") ||
      "Unknown error";
    throw new Error(`DNS create failed: ${errors}`);
  }

  return { recordId: data.result.id, name: data.result.name };
}

// ---------------------------------------------------------------------------
// 3. Delete tunnel + DNS
// ---------------------------------------------------------------------------
export async function deleteTunnel(tunnelId: string): Promise<void> {
  const accountId = getAccountId();
  const token = getToken();

  // Clean up connections first
  await fetch(
    `${CF_API}/accounts/${accountId}/cfd_tunnel/${tunnelId}/connections`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    },
  );

  // Delete tunnel
  const res = await fetch(
    `${CF_API}/accounts/${accountId}/cfd_tunnel/${tunnelId}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    },
  );

  const data = (await res.json()) as any;
  if (!data.success) {
    const errors =
      data.errors?.map((e: { message: string }) => e.message).join(", ") || "";
    if (!errors.includes("not found")) {
      console.warn("Tunnel delete warning:", errors);
    }
  }
}

export async function deleteDnsRecord(recordId: string): Promise<void> {
  const zoneId = getZoneId();
  const token = getToken();

  const res = await fetch(`${CF_API}/zones/${zoneId}/dns_records/${recordId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });

  const data = (await res.json()) as any;
  if (!data.success) {
    const errors =
      data.errors?.map((e: { message: string }) => e.message).join(", ") || "";
    if (!errors.includes("not found")) {
      console.warn("DNS delete warning:", errors);
    }
  }
}
