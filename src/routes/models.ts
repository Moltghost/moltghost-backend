import { Router } from "express";
import { db } from "../db";
import { models } from "../db/schema";
import { eq } from "drizzle-orm";

const router: Router = Router();

// GET /api/models
router.get("/", async (_req, res) => {
  try {
    const rows = await db
      .select()
      .from(models)
      .where(eq(models.isActive, true));
    res.json(rows);
  } catch (err) {
    console.error("GET /api/models", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
