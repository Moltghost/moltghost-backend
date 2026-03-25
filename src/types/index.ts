// CloudInitConfig — passed to generateStartupScript() in lib/runpod.ts
export interface CloudInitConfig {
  agentId: string;
  agentDomain: string; // e.g. "agent-abc123.moltghost.io"
  gatewayToken: string;
  callbackUrl: string; // backend URL the pod calls when ready
  callbackSecret: string;
  logUrl: string; // backend URL the pod streams logs to
  tunnelToken: string; // Cloudflare tunnel credential
  model?: string; // e.g. "qwen3:8b"
}

// Augment Express Request so middleware can attach the authed user
declare global {
  namespace Express {
    interface Request {
      user?: {
        userId: string;
        walletAddress?: string;
      };
    }
  }
}
