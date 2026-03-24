// =============================================================================
// Server-Side AES-256-GCM Encryption
// =============================================================================
// Encrypts infra secrets (tunnel tokens) at rest in the database.
// Key is stored in DB_ENCRYPTION_KEY env var (64-char hex = 32 bytes).
//
// Format: "iv:tag:ciphertext" (all hex-encoded)
// =============================================================================

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;

function getKey(): Buffer {
  const hex = process.env.DB_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      "DB_ENCRYPTION_KEY must be set (64 hex chars = 32 bytes). " +
        "Generate one: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }
  return Buffer.from(hex, "hex");
}

export function serverEncrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function serverDecrypt(data: string): string {
  const key = getKey();
  const [ivHex, tagHex, encHex] = data.split(":");
  if (!ivHex || !tagHex || !encHex) {
    throw new Error(
      "Invalid encrypted data format (expected iv:tag:ciphertext)",
    );
  }
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return decipher.update(encHex, "hex", "utf8") + decipher.final("utf8");
}
