import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "@/server/env";

/**
 * Encryption for credentials stored in the database (payment-provider API
 * keys saved in the admin panel). AES-256-GCM with a random IV per value and
 * an authentication tag, keyed by SETTINGS_ENCRYPTION_KEY (never stored in
 * the database). Stored form: "v1:<iv>:<tag>:<ciphertext>" (base64url).
 * Plain values never leave the server: callers use them for outgoing API
 * requests only, and the admin UI only ever receives a masked hint.
 */

const PREFIX = "v1";

export class SecretKeyMissingError extends Error {
  constructor() {
    super("SETTINGS_ENCRYPTION_KEY is not set");
    this.name = "SecretKeyMissingError";
  }
}

function key(): Buffer {
  const raw = env().SETTINGS_ENCRYPTION_KEY?.trim();
  if (!raw) throw new SecretKeyMissingError();
  const k = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (k.length !== 32) throw new Error("SETTINGS_ENCRYPTION_KEY must decode to 32 bytes (openssl rand -base64 32)");
  return k;
}

export const canEncryptSecrets = (): boolean => {
  try {
    key();
    return true;
  } catch {
    return false;
  }
};

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const b = (x: Buffer) => x.toString("base64url");
  return `${PREFIX}:${b(iv)}:${b(cipher.getAuthTag())}:${b(data)}`;
}

/** The plain value, or null when it can't be decrypted (wrong/missing key, tampered value). */
export function decryptSecret(stored: string): string | null {
  const [v, iv, tag, data] = stored.split(":");
  if (v !== PREFIX || !iv || !tag || !data) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** "****************abcd": enough to recognise which key is saved, never enough to use it. */
export function maskSecret(plain: string | null | undefined): string | null {
  if (!plain) return null;
  return `${"*".repeat(16)}${plain.length > 8 ? plain.slice(-4) : ""}`;
}
