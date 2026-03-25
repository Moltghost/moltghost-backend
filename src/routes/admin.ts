import { Router, Request, Response } from "express";
import { db } from "../db";
import { users, deployments } from "../db/schema";
import { desc, count, eq, inArray, or } from "drizzle-orm";
import { requireAdminAuth } from "../middleware/auth";
import { decryptField, decryptJson } from "../lib/encryption";
import logger from "../lib/logger";

const router: Router = Router();

// ─── Decrypt helpers ──────────────────────────────────────────────────────────

function decryptUserRow<T extends Record<string, unknown>>(row: T): T {
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

// ─── Admin Users ──────────────────────────────────────────────────────────────

// GET /api/admin/users — fetch all users
router.get("/users", requireAdminAuth, async (req: Request, res: Response) => {
  try {
    logger.info("[ADMIN] Fetching all users");
    const allUsers = await db
      .select()
      .from(users)
      .orderBy(desc(users.createdAt));

    logger.info("[ADMIN] Found users", { count: allUsers.length });

    // Enrich with deployment count
    const userDeploymentCounts = await db
      .select({
        userId: deployments.userId,
        count: count(deployments.id),
      })
      .from(deployments)
      .groupBy(deployments.userId);

    const countMap = new Map(
      userDeploymentCounts.map((row) => [row.userId, row.count]),
    );

    const enrichedUsers = allUsers.map((user) => ({
      ...decryptUserRow(user),
      deploymentCount: countMap.get(user.id) ?? 0,
    }));

    logger.info("[ADMIN] Enriched users with deployment counts", {
      count: enrichedUsers.length,
    });
    res.json(enrichedUsers);
  } catch (err) {
    logger.error("[ADMIN] Error fetching users", { error: err });
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── Admin Deployments ────────────────────────────────────────────────────────

// GET /api/admin/deployments — fetch all deployments with user info
router.get(
  "/deployments",
  requireAdminAuth,
  async (req: Request, res: Response) => {
    try {
      logger.info("[ADMIN] Fetching all deployments");
      const allDeployments = await db
        .select()
        .from(deployments)
        .orderBy(desc(deployments.createdAt));

      logger.info("[ADMIN] Found deployments", {
        count: allDeployments.length,
      });

      // Fetch all user IDs referenced
      const userIds = [...new Set(allDeployments.map((d) => d.userId))];
      const userMap = new Map();

      if (userIds.length > 0) {
        const userList = await db
          .select()
          .from(users)
          .where(inArray(users.id, userIds));
        userList.forEach((u) => userMap.set(u.id, u));
        logger.debug("[ADMIN] Loaded user info", { users: userList.length });
      }

      // Enrich deployments with user info
      const enrichedDeployments = allDeployments.map((deployment) => {
        const user = userMap.get(deployment.userId);
        const decryptedUser = user ? decryptUserRow(user) : null;
        return {
          ...decryptDeploymentRow(deployment),
          userName: decryptedUser?.displayName ?? null,
          userEmail: decryptedUser?.email ?? null,
          userWallet: user?.walletAddress ?? null,
        };
      });

      logger.info("[ADMIN] Enriched deployments with user info", {
        count: enrichedDeployments.length,
      });
      res.json(enrichedDeployments);
    } catch (err) {
      logger.error("[ADMIN] Error fetching deployments", { error: err });
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// ─── Admin Stats ──────────────────────────────────────────────────────────────

// GET /api/admin/stats — fetch admin dashboard stats
router.get("/stats", requireAdminAuth, async (req: Request, res: Response) => {
  try {
    logger.info("[ADMIN] Fetching dashboard stats");

    // Get all users
    const allUsers = await db.select().from(users);
    logger.info("[ADMIN] All users fetched", { count: allUsers.length });
    const totalUsers = allUsers.length;

    // Get all deployments
    const allDeployments = await db.select().from(deployments);
    logger.info("[ADMIN] All deployments fetched", {
      count: allDeployments.length,
    });
    const totalDeployments = allDeployments.length;

    // Count active deployments
    const activeDeployments = allDeployments.filter((d) =>
      ["pending", "provisioning", "starting", "running"].includes(d.status),
    ).length;
    logger.info("[ADMIN] Active deployments counted", {
      count: activeDeployments,
    });

    // Count failed deployments
    const failedDeployments = allDeployments.filter(
      (d) => d.status === "failed",
    ).length;
    logger.info("[ADMIN] Failed deployments counted", {
      count: failedDeployments,
    });

    const stats = {
      totalUsers,
      totalDeployments,
      activeDeployments,
      failedDeployments,
    };

    logger.info("[ADMIN] Dashboard stats computed", stats);
    res.json(stats);
  } catch (err) {
    logger.error("[ADMIN] Error fetching stats - main catch", { error: err });
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
