import { Router } from "express";
import { requireAuth } from "../middleware/auth";

const router: Router = Router();

// 5-minute in-memory cache for GPU types
let gpuCache: { data: unknown; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

// GET /api/runpod/gpu-types
router.get("/gpu-types", requireAuth, async (_req, res) => {
  try {
    if (gpuCache && Date.now() - gpuCache.fetchedAt < CACHE_TTL_MS) {
      res.json(gpuCache.data);
      return;
    }

    const response = await fetch("https://api.runpod.io/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.RUNPOD_API_KEY}`,
      },
      body: JSON.stringify({
        query: `{
          gpuTypes {
            id
            displayName
            memoryInGb
            securePrice
            communityPrice
            lowestPrice {
              minimumBidPrice
              uninterruptablePrice
            }
          }
        }`,
      }),
    });

    const json = (await response.json()) as { data?: { gpuTypes?: unknown[] } };
    const gpuTypes = json.data?.gpuTypes ?? [];

    // Filter to only allowed GPU IDs if env var is set
    const allowed = process.env.RUNPOD_ALLOWED_GPU_IDS
      ? process.env.RUNPOD_ALLOWED_GPU_IDS.split(",").map((s) => s.trim())
      : null;

    const filtered = allowed
      ? (gpuTypes as Array<{ displayName: string }>).filter((g) =>
          allowed.includes(g.displayName),
        )
      : gpuTypes;

    gpuCache = { data: filtered, fetchedAt: Date.now() };
    res.json(filtered);
  } catch (err) {
    console.error("GET /api/runpod/gpu-types", err);
    res.status(500).json({ error: "Failed to fetch GPU types" });
  }
});

export default router;
