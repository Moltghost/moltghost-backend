import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { db } from "../db";
import { users } from "../db/schema";
import logger from "../lib/logger";

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("JWT_SECRET must be set (min 32 chars)");
  }
  return secret;
}

/**
 * requireAuth — verifies self-issued JWT (wallet-based auth).
 * Upserts user record in DB, attaches req.user = { userId, walletAddress }.
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing Bearer token" });
    return;
  }

  const token = authHeader.slice(7);

  try {
    const payload = jwt.verify(token, getJwtSecret()) as {
      sub: string;
      wallet: string;
    };

    const walletAddress = payload.wallet;

    // Upsert user — create on first login, update timestamp if exists
    await db
      .insert(users)
      .values({
        id: walletAddress,
        walletAddress,
      })
      .onConflictDoUpdate({
        target: users.id,
        set: {
          walletAddress,
          updatedAt: new Date(),
        },
      });

    req.user = {
      userId: walletAddress,
      walletAddress,
    };
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

/**
 * requireDeploySecret — guards internal orchestration endpoints.
 * Header: X-Deploy-Secret: <DEPLOY_SECRET env var>
 */
export function requireDeploySecret(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const secret = req.headers["x-deploy-secret"];
  if (secret !== process.env.DEPLOY_SECRET) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  next();
}

/**
 * requireWorkerSecret — guards CF Worker callback endpoints.
 * Header: X-Worker-Secret: <WORKER_SECRET env var>
 */
export function requireWorkerSecret(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const secret = req.headers["x-worker-secret"];
  if (secret !== process.env.WORKER_SECRET) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  next();
}

/**
 * requireAdminAuth — verifies JWT AND checks if wallet is admin.
 * Requires: process.env.ADMIN_WALLET set to admin wallet address
 */
export async function requireAdminAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    logger.warn("Missing Bearer token in admin request");
    res.status(401).json({ error: "Missing Bearer token" });
    return;
  }

  const token = authHeader.slice(7);

  try {
    const payload = jwt.verify(token, getJwtSecret()) as {
      sub: string;
      wallet: string;
    };

    const walletAddress = payload.wallet;

    // Verify admin
    const adminWallet = process.env.ADMIN_WALLET;
    if (!adminWallet) {
      logger.error("Admin wallet not configured in environment");
      res.status(500).json({ error: "Admin wallet not configured" });
      return;
    }

    if (walletAddress !== adminWallet) {
      logger.warn("Unauthorized admin access attempt", {
        attemptedWallet: walletAddress?.slice(0, 10),
      });
      res.status(403).json({ error: "Unauthorized - admin access required" });
      return;
    }

    logger.info("Admin access granted", {
      wallet: walletAddress?.slice(0, 10),
    });
    req.user = {
      userId: walletAddress,
      walletAddress,
    };
    next();
  } catch (err) {
    logger.error("Token verification failed", { error: err });
    res.status(401).json({ error: "Invalid or expired token" });
  }
}
