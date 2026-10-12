import { NextRequest, NextResponse } from "next/server";
import {
  createSessionToken,
  passwordHash,
  safeNextPath,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  verifyPassword,
} from "@/lib/auth";

/** Failed attempts per client in the current window; resets on success. */
const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60 * 1000;
const failures = new Map<string, { count: number; since: number }>();

function clientKey(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0].trim() || req.headers.get("x-real-ip") || "local";
}

/**
 * 303 so the browser follows the form POST with a GET. The Location is relative
 * on purpose: behind a reverse proxy req.url can carry the internal address.
 */
function redirectTo(path: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { Location: path } });
}

/** Form POST from /login: password, next. Sets the session cookie on success. */
export async function POST(req: NextRequest) {
  const form = await req.formData();
  const password = String(form.get("password") ?? "");
  const next = safeNextPath(String(form.get("next") ?? ""));
  const back = (error: string) => redirectTo(`/login?error=${error}&next=${encodeURIComponent(next)}`);

  const hash = passwordHash();
  if (!hash) return redirectTo(next);

  const key = clientKey(req);
  const now = Date.now();
  const entry = failures.get(key);
  if (entry && now - entry.since > WINDOW_MS) failures.delete(key);
  const current = failures.get(key);
  if (current && current.count >= MAX_FAILURES) return back("locked");

  if (!password || !verifyPassword(password, hash)) {
    failures.set(key, { count: (current?.count ?? 0) + 1, since: current?.since ?? now });
    return back("invalid");
  }

  failures.delete(key);
  const res = redirectTo(next);
  const https = req.headers.get("x-forwarded-proto") === "https" || req.nextUrl.protocol === "https:";
  res.cookies.set(SESSION_COOKIE, createSessionToken(hash), {
    httpOnly: true,
    sameSite: "lax",
    secure: https,
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
  return res;
}
