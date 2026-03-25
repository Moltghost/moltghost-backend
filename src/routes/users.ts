import { Router, Request, Response } from "express";
import { db } from "../db";
import { users, deployments } from "../db/schema";
import { eq, desc } from "drizzle-orm";
import { requireAuth } from "../middleware/auth";
import { encryptField, decryptField, decryptJson } from "../lib/encryption";

const router: Router = Router();

function decryptUser<T extends Record<string, unknown>>(row: T): T {
  return {
    ...row,
    email: decryptField(row.email as string | null),
    displayName: decryptField(row.displayName as string | null),
    avatarUrl: decryptField(row.avatarUrl as string | null),
  };
}

function decryptDeploymentRow<T extends Record<string, unknown>>(row: T): T {
  return {
    ...row,
    skills: decryptJson(row.skills as string | null, []),
    memory: decryptJson(row.memory as string | null, {
      enablePrivateMemory: false,
      persistentMemory: false,
      encryption: false,
    }),
    agentBehavior: decryptJson(row.agentBehavior as string | null, {
      autonomousMode: false,
      taskTimeout: 30,
      maxConcurrentTasks: 3,
    }),
    notifications: decryptJson(row.notifications as string | null, {
      webhookNotifications: false,
      emailAlerts: false,
      taskReports: false,
    }),
    autoSleep: decryptJson(row.autoSleep as string | null, {
      enableAutoSleep: false,
      idleTimeout: 15,
    }),
    podId: decryptField(row.podId as string | null),
    tunnelId: decryptField(row.tunnelId as string | null),
    tunnelToken: null,
    dnsRecordId: decryptField(row.dnsRecordId as string | null),
  };
}

// GET /api/users/me — profile user yang sedang login
router.get("/me", requireAuth, async (req: Request, res: Response) => {
  try {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, req.user!.userId));

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    res.json(decryptUser(user));
  } catch (err) {
    console.error("GET /api/users/me", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /api/users/me — update displayName / avatarUrl
router.patch("/me", requireAuth, async (req: Request, res: Response) => {
  try {
    const { displayName, avatarUrl } = req.body as {
      displayName?: string;
      avatarUrl?: string;
    };

    const [updated] = await db
      .update(users)
      .set({
        ...(displayName !== undefined && {
          displayName: encryptField(displayName),
        }),
        ...(avatarUrl !== undefined && { avatarUrl: encryptField(avatarUrl) }),
        updatedAt: new Date(),
      })
      .where(eq(users.id, req.user!.userId))
      .returning();

    res.json(decryptUser(updated));
  } catch (err) {
    console.error("PATCH /api/users/me", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/users/me/deployments — semua deployment milik user (shortcut)
router.get(
  "/me/deployments",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const rows = await db
        .select()
        .from(deployments)
        .where(eq(deployments.userId, req.user!.userId))
        .orderBy(desc(deployments.createdAt));

      res.json(rows.map(decryptDeploymentRow));
    } catch (err) {
      console.error("GET /api/users/me/deployments", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

export default router;
