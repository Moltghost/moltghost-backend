import { Router, Request, Response } from "express";
import { randomBytes } from "crypto";
import jwt from "jsonwebtoken";
import nacl from "tweetnacl";
import bs58 from "bs58";

const router: Router = Router();

// In-memory nonce store with 5-minute TTL
const nonceStore = new Map<string, { nonce: string; expires: number }>();

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("JWT_SECRET must be set (min 32 chars)");
  }
  return secret;
}

// Cleanup expired nonces every 60 seconds
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of nonceStore) {
    if (val.expires < now) nonceStore.delete(key);
  }
}, 60_000);

// GET /api/auth/nonce?wallet=<base58 pubkey>
router.get("/nonce", (req: Request, res: Response) => {
  const wallet = req.query.wallet as string;
  if (!wallet) {
    res.status(400).json({ error: "wallet query param required" });
    return;
  }

  const nonce = randomBytes(32).toString("hex");
  nonceStore.set(wallet, { nonce, expires: Date.now() + 5 * 60 * 1000 });

  res.json({ nonce });
});

// POST /api/auth/login { wallet, signature, nonce }
router.post("/login", (req: Request, res: Response) => {
  const { wallet, signature, nonce } = req.body as {
    wallet: string;
    signature: string;
    nonce: string;
  };

  if (!wallet || !signature || !nonce) {
    res.status(400).json({ error: "wallet, signature, nonce required" });
    return;
  }

  // Verify nonce exists and hasn't expired
  const stored = nonceStore.get(wallet);
  if (!stored || stored.nonce !== nonce) {
    res.status(401).json({ error: "Invalid or expired nonce" });
    return;
  }
  if (stored.expires < Date.now()) {
    nonceStore.delete(wallet);
    res.status(401).json({ error: "Nonce expired" });
    return;
  }

  // Consume nonce (one-time use)
  nonceStore.delete(wallet);

  // Reconstruct the message the client signed
  const message = `Sign in to MoltGhost\nWallet: ${wallet}\nNonce: ${nonce}`;
  const messageBytes = new TextEncoder().encode(message);

  // Verify ed25519 signature
  let pubKeyBytes: Uint8Array;
  let sigBytes: Uint8Array;
  try {
    pubKeyBytes = bs58.decode(wallet);
    sigBytes = bs58.decode(signature);
  } catch {
    res.status(400).json({ error: "Invalid base58 encoding" });
    return;
  }

  const valid = nacl.sign.detached.verify(messageBytes, sigBytes, pubKeyBytes);
  if (!valid) {
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  // Issue JWT
  const token = jwt.sign({ sub: wallet, wallet }, getJwtSecret(), {
    expiresIn: "24h",
  });

  res.json({ token, wallet });
});

export default router;
