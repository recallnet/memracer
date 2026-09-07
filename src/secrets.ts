/**
 * Envelope encryption for org/project provider API keys.
 * AES-256-GCM with a key derived from MEMRACER_SECRETS_KEY or BETTER_AUTH_SECRET.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_BYTES = 12;

export interface EncryptedSecret {
  ciphertext: string;
  iv: string;
  tag: string;
  last4: string;
}

function masterKeyBytes(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.MEMRACER_SECRETS_KEY?.trim() || env.BETTER_AUTH_SECRET?.trim();
  if (!raw) {
    throw new Error(
      "MEMRACER_SECRETS_KEY or BETTER_AUTH_SECRET is required to encrypt provider keys",
    );
  }
  return createHash("sha256").update(raw).digest();
}

export function last4OfSecret(secret: string): string {
  const trimmed = secret.trim();
  if (trimmed.length === 0) return "****";
  return trimmed.slice(-4);
}

export function encryptSecret(
  plaintext: string,
  env: NodeJS.ProcessEnv = process.env,
): EncryptedSecret {
  const secret = plaintext.trim();
  if (!secret) throw new Error("secret must be non-empty");
  const key = masterKeyBytes(env);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    last4: last4OfSecret(secret),
  };
}

export function decryptSecret(
  payload: Pick<EncryptedSecret, "ciphertext" | "iv" | "tag">,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const key = masterKeyBytes(env);
  const decipher = createDecipheriv(ALGO, key, Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final(),
  ]);
  return plain.toString("utf8");
}
