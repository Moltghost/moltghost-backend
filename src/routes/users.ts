import { Router, Request, Response } from "express";
import { db } from "../db";
import { users, deployments } from "../db/schema";
import { eq, desc } from "drizzle-orm";
import { requireAuth } from "../middleware/auth";

const router: Router = Router();

// GET /api/users/me — profile user yang sedang login
router.get("/me", requireAuth, async (req: Request, res: Response) => {
  try {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, req.user!.privyId));

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    res.json(user);
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
        ...(displayName !== undefined && { displayName }),
        ...(avatarUrl !== undefined && { avatarUrl }),
        updatedAt: new Date(),
      })
      .where(eq(users.id, req.user!.privyId))
      .returning();

    res.json(updated);
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
        .where(eq(deployments.userId, req.user!.privyId))
        .orderBy(desc(deployments.createdAt));

      res.json(rows);
    } catch (err) {
      console.error("GET /api/users/me/deployments", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

export default router;
