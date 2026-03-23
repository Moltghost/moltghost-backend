import { Request, Response, NextFunction } from "express";
import { PrivyClient } from "@privy-io/node";
import { db } from "../db";
import { users } from "../db/schema";
import logger from "../lib/logger";

let _privy: PrivyClient | null = null;
function getPrivy() {
  if (!_privy) {
    _privy = new PrivyClient({
      appId: process.env.PRIVY_APP_ID!,
      appSecret: process.env.PRIVY_APP_SECRET!,
    });
  }
  return _privy;
}

/**
 * requireAuth — verifies Bearer JWT from Privy.
 * Upserts user record in DB, attaches req.user = { privyId, walletAddress }.
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
    const claims = await getPrivy().utils().auth().verifyAuthToken(token);
    const privyUser = await getPrivy().users()._get(claims.user_id);

    const walletAccount = (
      privyUser.linked_accounts as Array<{
        type: string;
        address?: string;
        chain_type?: string;
      }>
    ).find((a) => a.type === "wallet" && a.chain_type === "solana");

    const emailAccount = (
      privyUser.linked_accounts as Array<{ type: string; address?: string }>
    ).find((a) => a.type === "email");

    const walletAddress = walletAccount?.address ?? null;
    const email = emailAccount?.address ?? null;
    const displayName =
      (privyUser as any).name || (privyUser as any).display_name || null;
    const avatarUrl = (privyUser as any).profilePictureUrl || null;

    // Upsert user — create on first login, update wallet/email/displayName if changed
    await db
      .insert(users)
      .values({
        id: claims.user_id,
        walletAddress,
        email,
        displayName,
        avatarUrl,
      })
      .onConflictDoUpdate({
        target: users.id,
        set: {
          walletAddress,
          email,
          displayName,
          avatarUrl,
          updatedAt: new Date(),
        },
      });

    req.user = {
      privyId: claims.user_id,
      walletAddress: walletAddress ?? undefined,
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
 * requireAdminAuth — verifies Bearer JWT from Privy AND checks if wallet is admin.
 * Requires: process.env.ADMIN_WALLET set to admin wallet address
 * Attaches req.user = { privyId, walletAddress }.
 */
export async function requireAdminAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;
  logger.info("Admin request received", {
    hasAuthHeader: !!authHeader,
    path: req.path,
  });

  if (!authHeader?.startsWith("Bearer ")) {
    logger.warn("Missing Bearer token in admin request");
    res.status(401).json({ error: "Missing Bearer token" });
    return;
  }

  const token = authHeader.slice(7);

  try {
    const claims = await getPrivy().utils().auth().verifyAuthToken(token);
    const privyUser = await getPrivy().users()._get(claims.user_id);

    const walletAccount = (
      privyUser.linked_accounts as Array<{
        type: string;
        address?: string;
        chain_type?: string;
      }>
    ).find((a) => a.type === "wallet" && a.chain_type === "solana");

    const walletAddress = walletAccount?.address ?? null;
    logger.info("Token verified", {
      userWallet: walletAddress?.slice(0, 10),
    });

    // Verify admin
    const adminWallet = process.env.ADMIN_WALLET;
    logger.debug("Admin wallet verification", {
      userWallet: walletAddress?.slice(0, 10),
      adminWallet: adminWallet?.slice(0, 10),
    });

    if (!adminWallet) {
      logger.error("Admin wallet not configured in environment");
      res.status(500).json({ error: "Admin wallet not configured" });
      return;
    }

    if (
      !walletAddress ||
      walletAddress.toLowerCase() !== adminWallet.toLowerCase()
    ) {
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
      privyId: claims.user_id,
      walletAddress: walletAddress ?? undefined,
    };
    next();
  } catch (err) {
    logger.error("Token verification failed", { error: err });
    res.status(401).json({ error: "Invalid or expired token" });
  }
}
