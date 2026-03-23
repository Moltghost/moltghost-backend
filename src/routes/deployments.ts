import { Router, Request, Response } from "express";
import { db } from "../db";
import { deployments, deploymentLogs } from "../db/schema";
import { eq, desc, and } from "drizzle-orm";
import {
  requireAuth,
  requireDeploySecret,
  requireWorkerSecret,
} from "../middleware/auth";
import { deploymentEmitter } from "../ws/wsServer";
import {
  createTunnel,
  createTunnelDns,
  deleteTunnel,
  deleteDnsRecord,
} from "../lib/cloudflare";
import {
  createPod,
  stopPod,
  deletePod,
  generateStartupScript,
} from "../lib/runpod";
import crypto from "crypto";

const router: Router = Router();

// ─── User CRUD ────────────────────────────────────────────────────────────────

// GET /api/deployments
router.get("/", requireAuth, async (req: Request, res: Response) => {
  try {
    const rows = await db
      .select()
      .from(deployments)
      .where(eq(deployments.userId, req.user!.privyId))
      .orderBy(desc(deployments.createdAt));
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/deployments/:id
router.get("/:id", requireAuth, async (req: Request, res: Response) => {
  try {
    const [row] = await db
      .select()
      .from(deployments)
      .where(
        and(
          eq(deployments.id, req.params.id),
          eq(deployments.userId, req.user!.privyId),
        ),
      );
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(row);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/deployments — create new deployment (triggers CF Worker)
router.post("/", requireAuth, async (req: Request, res: Response) => {
  try {
    const body = req.body;

    const [deployment] = await db
      .insert(deployments)
      .values({
        userId: req.user!.privyId,
        mode: body.mode,
        modelId: body.modelId,
        modelLabel: body.modelLabel,
        modelSize: body.modelSize,
        modelImage: body.modelImage,
        modelMinVram: body.modelMinVram,
        skills: body.skills ?? [],
        memory: body.memory,
        agentBehavior: body.agentBehavior,
        notifications: body.notifications,
        autoSleep: body.autoSleep,
        status: "pending",
      })
      .returning();

    // Fire-and-forget to Cloudflare Worker (background orchestration)
    const workerUrl = process.env.WORKER_URL;
    if (workerUrl) {
      fetch(workerUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Worker-Secret": process.env.WORKER_SECRET!,
        },
        body: JSON.stringify({ deploymentId: deployment.id }),
      }).catch((e) => console.error("Worker trigger failed:", e));
    } else {
      // Dev fallback: call internal orchestrate directly
      fetch(
        `http://localhost:${process.env.PORT ?? 3001}/api/deployments/internal/orchestrate`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Deploy-Secret": process.env.DEPLOY_SECRET!,
          },
          body: JSON.stringify({ deploymentId: deployment.id }),
        },
      ).catch((e) => console.error("Dev orchestrate failed:", e));
    }

    res.status(201).json(deployment);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /api/deployments/:id — stop pod and cleanup
router.delete("/:id", requireAuth, async (req: Request, res: Response) => {
  try {
    const [deployment] = await db
      .select()
      .from(deployments)
      .where(
        and(
          eq(deployments.id, req.params.id),
          eq(deployments.userId, req.user!.privyId),
        ),
      );

    if (!deployment) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    // Cleanup RunPod + Cloudflare resources asynchronously
    if (deployment.podId) {
      stopPod(deployment.podId).catch(console.error);
      deletePod(deployment.podId).catch(console.error);
    }
    if (deployment.tunnelId) {
      deleteTunnel(deployment.tunnelId).catch(console.error);
    }
    if (deployment.dnsRecordId) {
      deleteDnsRecord(deployment.dnsRecordId).catch(console.error);
    }

    await db
      .update(deployments)
      .set({ status: "stopped", updatedAt: new Date() })
      .where(eq(deployments.id, req.params.id));

    deploymentEmitter.emit("status", req.params.id, "stopped");

    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── Logs ─────────────────────────────────────────────────────────────────────

// POST /api/deployments/:id/logs — pod pushes log entries
router.post(
  "/:id/logs",
  requireWorkerSecret,
  async (req: Request, res: Response) => {
    try {
      const { level = "info", message } = req.body as {
        level?: string;
        message: string;
      };

      await db.insert(deploymentLogs).values({
        deploymentId: req.params.id,
        level,
        message,
      });

      deploymentEmitter.emit("log", req.params.id, level, message);
      res.status(204).send();
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// GET /api/deployments/:id/logs — fetch stored logs (paginated)
router.get("/:id/logs", requireAuth, async (req: Request, res: Response) => {
  try {
    // Verify ownership first
    const [deployment] = await db
      .select({ id: deployments.id })
      .from(deployments)
      .where(
        and(
          eq(deployments.id, req.params.id),
          eq(deployments.userId, req.user!.privyId),
        ),
      );
    if (!deployment) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const limit = Math.min(parseInt((req.query.limit as string) ?? "100"), 500);
    const logs = await db
      .select()
      .from(deploymentLogs)
      .where(eq(deploymentLogs.deploymentId, req.params.id))
      .orderBy(desc(deploymentLogs.createdAt))
      .limit(limit);

    res.json(logs.reverse());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/deployments/:id/logs/stream — SSE real-time log stream
router.get(
  "/:id/logs/stream",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const [deployment] = await db
        .select({ id: deployments.id })
        .from(deployments)
        .where(
          and(
            eq(deployments.id, req.params.id),
            eq(deployments.userId, req.user!.privyId),
          ),
        );
      if (!deployment) {
        res.status(404).json({ error: "Not found" });
        return;
      }

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();

      const sendLog = (depId: string, level: string, message: string) => {
        if (depId !== req.params.id) return;
        res.write(`data: ${JSON.stringify({ level, message })}\n\n`);
      };

      const sendStatus = (depId: string, status: string) => {
        if (depId !== req.params.id) return;
        res.write(`event: status\ndata: ${JSON.stringify({ status })}\n\n`);
      };

      deploymentEmitter.on("log", sendLog);
      deploymentEmitter.on("status", sendStatus);

      req.on("close", () => {
        deploymentEmitter.off("log", sendLog);
        deploymentEmitter.off("status", sendStatus);
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// ─── Pod callback (pod → backend when ready) ──────────────────────────────────

// POST /api/deployments/:id/callback
router.post(
  "/:id/callback",
  requireWorkerSecret,
  async (req: Request, res: Response) => {
    try {
      const { status } = req.body as { status: "running" | "failed" };

      await db
        .update(deployments)
        .set({ status, updatedAt: new Date() })
        .where(eq(deployments.id, req.params.id));

      deploymentEmitter.emit("status", req.params.id, status);
      res.status(204).send();
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// ─── Internal orchestration ───────────────────────────────────────────────────

// POST /api/deployments/internal/orchestrate
// Called by CF Worker (or dev fallback). Creates tunnel + pod.
router.post(
  "/internal/orchestrate",
  requireDeploySecret,
  async (req: Request, res: Response) => {
    const { deploymentId } = req.body as { deploymentId: string };

    if (!deploymentId) {
      res.status(400).json({ error: "deploymentId required" });
      return;
    }

    res.status(202).json({ message: "Orchestration started" });

    // Run async — errors are logged but not returned to caller
    (async () => {
      try {
        const [deployment] = await db
          .select()
          .from(deployments)
          .where(eq(deployments.id, deploymentId));

        if (!deployment)
          throw new Error(`Deployment ${deploymentId} not found`);

        // 1. Mark provisioning
        await db
          .update(deployments)
          .set({ status: "provisioning", updatedAt: new Date() })
          .where(eq(deployments.id, deploymentId));
        deploymentEmitter.emit("status", deploymentId, "provisioning");

        // 2. Create Cloudflare tunnel
        const shortId = deploymentId.slice(0, 8);
        const subdomain = `agent-${shortId}`;
        const { tunnelId, tunnelToken } = await createTunnel(
          `moltghost-${shortId}`,
        );
        const { recordId: dnsRecordId } = await createTunnelDns(
          subdomain,
          tunnelId,
        );

        await db
          .update(deployments)
          .set({
            tunnelId,
            tunnelToken,
            agentDomain: `${subdomain}.${process.env.CLOUDFLARE_TUNNEL_DOMAIN}`,
            dnsRecordId,
            updatedAt: new Date(),
          })
          .where(eq(deployments.id, deploymentId));

        // 3. Generate startup script
        const callbackSecret = crypto.randomBytes(16).toString("hex");
        const backendBase =
          process.env.BACKEND_PUBLIC_URL ??
          `http://localhost:${process.env.PORT ?? 3001}`;

        const startupScript = generateStartupScript({
          agentId: deploymentId,
          agentDomain: `${subdomain}.${process.env.CLOUDFLARE_TUNNEL_DOMAIN}`,
          gatewayToken: callbackSecret,
          callbackUrl: `${backendBase}/api/deployments/${deploymentId}/callback`,
          callbackSecret: process.env.WORKER_SECRET!,
          logUrl: `${backendBase}/api/deployments/${deploymentId}/logs`,
          tunnelToken,
          model: deployment.modelId,
        });

        // 4. Mark starting + create pod
        await db
          .update(deployments)
          .set({ status: "starting", updatedAt: new Date() })
          .where(eq(deployments.id, deploymentId));
        deploymentEmitter.emit("status", deploymentId, "starting");

        const pod = await createPod(
          `moltghost-${shortId}`,
          startupScript,
          "NVIDIA GeForce RTX 4090", // TODO: make configurable
          deployment.modelImage,
        );

        await db
          .update(deployments)
          .set({ podId: pod.podId, updatedAt: new Date() })
          .where(eq(deployments.id, deploymentId));

        // Pod will call /callback when ready — status updated there
      } catch (err) {
        console.error("Orchestration failed", err);
        await db
          .update(deployments)
          .set({ status: "failed", updatedAt: new Date() })
          .where(eq(deployments.id, deploymentId));
        deploymentEmitter.emit("status", deploymentId, "failed");
      }
    })();
  },
);

// GET /api/deployments/internal/pending-deployments
// CF Worker cron polls this to re-queue stuck pending deployments
router.get(
  "/internal/pending-deployments",
  requireDeploySecret,
  async (_req: Request, res: Response) => {
    try {
      const rows = await db
        .select({ id: deployments.id })
        .from(deployments)
        .where(eq(deployments.status, "pending"));
      res.json(rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

export default router;
