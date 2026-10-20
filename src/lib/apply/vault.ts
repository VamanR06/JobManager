import crypto from "crypto";
import { getDb } from "../db";

/**
 * Passwords for job-portal accounts the ChatGPT browser tools create. Encrypted
 * (AES-256-GCM) with JOBMANAGER_VAULT_KEY, which lives in the environment, not
 * the database, so a copy of app.db or a backup alone doesn't reveal them.
 * Without the key, account creation is refused: never plaintext.
 *
 * Passwords never leave this module except into the browser's password fields:
 * not to the model, logs, or tool results.
 */

export class VaultError extends Error {}

function key(): Buffer {
  const raw = process.env.JOBMANAGER_VAULT_KEY?.trim();
  if (!raw) throw new VaultError("Saving portal passwords is off: set JOBMANAGER_VAULT_KEY (npm run vault:key) on the server.");
  const k = Buffer.from(raw, "base64");
  if (k.length !== 32) throw new VaultError("JOBMANAGER_VAULT_KEY must be 32 bytes, base64 (npm run vault:key prints one).");
  return k;
}

export function generateVaultKey(): string {
  return crypto.randomBytes(32).toString("base64");
}

const aad = (host: string, email: string) => Buffer.from(`${host}\n${email}`);

function encrypt(secret: string, host: string, email: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  c.setAAD(aad(host, email));
  const ct = Buffer.concat([c.update(secret, "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
}

function decrypt(blob: string, host: string, email: string): string {
  const [v, iv, tag, ct] = blob.split(":");
  if (v !== "v1") throw new VaultError("Unknown password format");
  const d = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  d.setAAD(aad(host, email));
  d.setAuthTag(Buffer.from(tag, "base64"));
  try {
    return Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8");
  } catch {
    throw new VaultError("Couldn't decrypt the saved password (was JOBMANAGER_VAULT_KEY changed?)");
  }
}

/** A strong password most portals accept: 20 chars with upper, lower, digit and symbol. */
export function generatePassword(length = 20): string {
  const sets = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!#%+=?@^_-"];
  const all = sets.join("");
  const chars = sets.map((s) => s[crypto.randomInt(s.length)]);
  while (chars.length < length) chars.push(all[crypto.randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

export interface PortalAccount {
  id: number;
  host: string;
  email: string;
  job_id: number | null;
  created_at: string;
}

const norm = (s: string) => s.trim().toLowerCase();

export function findAccount(host: string, email: string): PortalAccount | null {
  return (getDb()
    .prepare("SELECT id, host, email, job_id, created_at FROM portal_accounts WHERE host = ? AND email = ?")
    .get(norm(host), norm(email)) as PortalAccount | undefined) ?? null;
}

/**
 * Creates and stores a password for a new account. Throws if one is already
 * saved, unless `replace` (the site never actually created that account).
 */
export function createAccount(host: string, email: string, jobId: number | null, replace = false): { account: PortalAccount; password: string } {
  const h = norm(host), e = norm(email);
  if (findAccount(h, e) && !replace) throw new VaultError(`A password is already saved for ${e} on ${h}; sign in instead.`);
  const password = generatePassword();
  getDb()
    .prepare(`INSERT INTO portal_accounts (host, email, secret_enc, job_id) VALUES (?, ?, ?, ?)
              ON CONFLICT (host, email) DO UPDATE SET secret_enc = excluded.secret_enc, job_id = excluded.job_id,
                created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
    .run(h, e, encrypt(password, h, e), jobId);
  return { account: findAccount(h, e)!, password };
}

export function accountPassword(host: string, email: string): string | null {
  const row = getDb().prepare("SELECT secret_enc FROM portal_accounts WHERE host = ? AND email = ?").get(norm(host), norm(email)) as
    | { secret_enc: string }
    | undefined;
  return row ? decrypt(row.secret_enc, norm(host), norm(email)) : null;
}
