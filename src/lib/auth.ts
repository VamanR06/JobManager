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

// ---------- share-sheet inbox ----------

/**
 * Token for /api/import/inbox, which an iOS Shortcut posts shared links to.
 * Turned on by setting JOBMANAGER_INBOX_TOKEN (make one with `npm run inbox:token`).
 * The Shortcut sends it as `Authorization: Bearer <token>`. It stands in for the
 * session cookie, Host and same-origin checks, so it's only accepted on that route.
 */
export const INBOX_PATH = "/api/import/inbox";

export function inboxToken(): string | null {
  return process.env.JOBMANAGER_INBOX_TOKEN?.trim() || null;
}

/** Constant-time check of an Authorization header against the configured token. */
export function inboxAuthorized(header: string | null, token = inboxToken()): boolean {
  if (!token || !header) return false;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return !!m && sameToken(m[1].trim(), token);
}

/** Constant-time compare; both sides are hashed so it's fixed-length whatever was sent. */
function sameToken(given: string, token: string): boolean {
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(token).digest();
  return crypto.timingSafeEqual(a, b);
}

export function generateInboxToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

// ---------- MCP endpoint (read-only; ChatGPT scheduled tasks etc.) ----------

/**
 * Token for the MCP endpoint, set with JOBMANAGER_MCP_TOKEN (`npm run mcp:token`).
 * ChatGPT custom connectors can't send a static Authorization header (only OAuth
 * or no auth), so the token rides in the URL path: /api/mcp/<token>. Clients that
 * can send headers may use POST /api/mcp with `Authorization: Bearer <token>`.
 * Like the inbox token, it stands in for the session, Host and same-origin checks,
 * and only on these paths.
 */
export const MCP_PATH = "/api/mcp";

export function mcpToken(): string | null {
  return process.env.JOBMANAGER_MCP_TOKEN?.trim() || null;
}

export function isMcpPath(pathname: string): boolean {
  return pathname === MCP_PATH || pathname.startsWith(`${MCP_PATH}/`);
}

export function mcpAuthorized(pathname: string, header: string | null, token = mcpToken()): boolean {
  if (!token) return false;
  if (pathname === MCP_PATH) return inboxAuthorized(header, token);
  const m = /^\/api\/mcp\/([^/]+)\/?$/.exec(pathname);
  if (!m) return false;
  let given: string;
  try {
    given = decodeURIComponent(m[1]);
  } catch {
    return false;
  }
  return sameToken(given, token);
}
