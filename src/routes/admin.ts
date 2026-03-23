import { Router, Request, Response } from "express";
import { db } from "../db";
import { users, deployments } from "../db/schema";
import { desc, count, eq, inArray } from "drizzle-orm";
import { requireAdminAuth } from "../middleware/auth";

const router: Router = Router();

// ─── Admin Users ──────────────────────────────────────────────────────────────

// GET /api/admin/users — fetch all users
router.get("/users", requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const allUsers = await db
      .select()
      .from(users)
      .orderBy(desc(users.createdAt));

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
      ...user,
      deploymentCount: countMap.get(user.id) ?? 0,
    }));

    res.json(enrichedUsers);
  } catch (err) {
    console.error("GET /api/admin/users", err);
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
      const allDeployments = await db
        .select()
        .from(deployments)
        .orderBy(desc(deployments.createdAt));

      // Fetch all user IDs referenced
      const userIds = [...new Set(allDeployments.map((d) => d.userId))];
      const userMap = new Map();

      if (userIds.length > 0) {
        const userList = await db
          .select()
          .from(users)
          .where(inArray(users.id, userIds));
        userList.forEach((u) => userMap.set(u.id, u));
      }

      // Enrich deployments with user info
      const enrichedDeployments = allDeployments.map((deployment) => {
        const user = userMap.get(deployment.userId);
        return {
          ...deployment,
          userName: user?.displayName ?? null,
          userEmail: user?.email ?? null,
          userWallet: user?.walletAddress ?? null,
        };
      });

      res.json(enrichedDeployments);
    } catch (err) {
      console.error("GET /api/admin/deployments", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// ─── Admin Stats ──────────────────────────────────────────────────────────────

// GET /api/admin/stats — fetch admin dashboard stats
router.get("/stats", requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const [{ totalUsers }] = await db
      .select({ totalUsers: count() })
      .from(users);

    const [{ totalDeployments }] = await db
      .select({ totalDeployments: count() })
      .from(deployments);

    const [{ activeDeployments }] = await db
      .select({ activeDeployments: count() })
      .from(deployments)
      .where(
        inArray(deployments.status, [
          "pending",
          "provisioning",
          "starting",
          "running",
        ]),
      );

    const [{ failedDeployments }] = await db
      .select({ failedDeployments: count() })
      .from(deployments)
      .where(eq(deployments.status, "failed"));

    res.json({
      totalUsers: totalUsers ?? 0,
      totalDeployments: totalDeployments ?? 0,
      activeDeployments: activeDeployments ?? 0,
      failedDeployments: failedDeployments ?? 0,
    });
  } catch (err) {
    console.error("GET /api/admin/stats", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
