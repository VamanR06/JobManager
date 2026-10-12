import crypto from "crypto";

/**
 * Single-user password gate for running the dashboard somewhere other than
 * localhost. Turned on by setting JOBMANAGER_PASSWORD_HASH (make one with
 * `npm run auth:hash`); unset, the app stays local-only and needs no login.
 *
 * Hash format: scrypt:<N>:<r>:<p>:<salt>:<key>, salt/key base64url. No "$"
 * characters on purpose — Next's .env loader would try to expand them.
 *
 * Sessions are a signed cookie, not a DB row: "<expiresAtMs>.<hmac>". The HMAC
 * key is derived from the password hash, so changing the password signs out
 * every existing session.
 */

export const SESSION_COOKIE = "jm_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 32 };

export function passwordHash(): string | null {
  return process.env.JOBMANAGER_PASSWORD_HASH?.trim() || null;
}

export function authEnabled(): boolean {
  return passwordHash() !== null;
}

function scrypt(password: string, salt: Buffer, N: number, r: number, p: number, keylen: number): Buffer {
  // maxmem must cover 128 * N * r bytes, which the default (32MB) only just does.
  return crypto.scryptSync(password, salt, keylen, { N, r, p, maxmem: 256 * N * r });
}

export function hashPassword(password: string): string {
  const { N, r, p, keylen } = SCRYPT;
  const salt = crypto.randomBytes(16);
  const key = scrypt(password, salt, N, r, p, keylen);
  return ["scrypt", N, r, p, salt.toString("base64url"), key.toString("base64url")].join(":");
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(":");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (![N, r, p].every((n) => Number.isInteger(n) && n > 0)) return false;
  const salt = Buffer.from(parts[4], "base64url");
  const expected = Buffer.from(parts[5], "base64url");
  if (!salt.length || !expected.length) return false;
  let actual: Buffer;
  try {
    actual = scrypt(password, salt, N, r, p, expected.length);
  } catch {
    return false;
  }
  return crypto.timingSafeEqual(actual, expected);
}

function signingKey(hash: string): Buffer {
  return crypto.createHash("sha256").update(`jobmanager-session:${hash}`).digest();
}

function sign(payload: string, hash: string): string {
  return crypto.createHmac("sha256", signingKey(hash)).update(payload).digest("base64url");
}

export function createSessionToken(hash: string, now = Date.now()): string {
  const payload = String(now + SESSION_TTL_MS);
  return `${payload}.${sign(payload, hash)}`;
}

export function verifySessionToken(token: string | undefined, hash: string, now = Date.now()): boolean {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(payload, hash));
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return false;
  const expiresAt = Number(payload);
  return Number.isFinite(expiresAt) && expiresAt > now;
}

/** Only same-site paths, so ?next= can't bounce a login to another site. */
export function safeNextPath(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/";
  return next;
}
