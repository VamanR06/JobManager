import { NextResponse, type NextRequest } from "next/server";
import { INBOX_PATH, inboxAuthorized, passwordHash, SESSION_COOKIE, verifySessionToken } from "@/lib/auth";

/**
 * Request guard for the whole app.
 *
 * With JOBMANAGER_PASSWORD_HASH set (deployed), every page and API route needs
 * a valid session cookie from /login. Pages redirect there; API calls get 401.
 *
 * Without it (local use), there is no login, so instead:
 *  - the Host header must be a loopback name (blocks DNS-rebinding pages that
 *    point their own hostname at 127.0.0.1 to read or change data). Extra
 *    hostnames (e.g. a LAN name) can be allowed with JOBMANAGER_ALLOWED_HOSTS.
 *
 * Either way, state-changing requests must come from this same origin (blocks
 * other websites open in the browser from POSTing here).
 *
 * The one exception is the share-sheet inbox (INBOX_PATH): it's called by an iOS
 * Shortcut, not a browser, so a bearer token (JOBMANAGER_INBOX_TOKEN) replaces
 * all three checks there, and it's refused without one.
 */

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const EXTRA = new Set(
  (process.env.JOBMANAGER_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean)
);

/** Reachable without a session. */
const PUBLIC_PATHS = new Set(["/login", "/api/auth/login"]);

function hostAllowed(hostHeader: string | null): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.toLowerCase().replace(/:\d+$/, "");
  return LOOPBACK.has(host) || EXTRA.has(host);
}

function crossSiteWrite(req: NextRequest): NextResponse | null {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return null;
  if (req.headers.get("sec-fetch-site") === "cross-site") {
    return NextResponse.json({ error: "Cross-site request blocked" }, { status: 403 });
  }
  const origin = req.headers.get("origin");
  if (origin === "null") {
    return NextResponse.json({ error: "Opaque origin blocked" }, { status: 403 });
  }
  if (origin) {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return NextResponse.json({ error: "Bad origin" }, { status: 403 });
    }
    // Behind a reverse proxy the Host header may be rewritten; trust the
    // forwarded host it reports instead.
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    if (originHost !== host) {
      return NextResponse.json({ error: "Cross-origin request blocked" }, { status: 403 });
    }
  }
  return null;
}

/**
 * Keeps search engines from indexing anything, including the login page and the
 * proxy's own 401/403/redirect responses. Deliberately no robots.txt "Disallow":
 * a crawler that's blocked from fetching a page never sees its noindex, and Google
 * can still list a blocked URL it finds linked elsewhere.
 */
const NOINDEX = "noindex, nofollow, noarchive, nosnippet";

export function proxy(req: NextRequest) {
  const res = guard(req);
  res.headers.set("X-Robots-Tag", NOINDEX);
  return res;
}

function guard(req: NextRequest): NextResponse {
  const hash = passwordHash();
  const { pathname, search } = req.nextUrl;

  if (pathname === INBOX_PATH) {
    return inboxAuthorized(req.headers.get("authorization"))
      ? NextResponse.next()
      : NextResponse.json({ error: "Bad inbox token" }, { status: 401 });
  }

  if (!hash && !hostAllowed(req.headers.get("host"))) {
    return NextResponse.json({ error: "Host not allowed" }, { status: 403 });
  }

  const blocked = crossSiteWrite(req);
  if (blocked) return blocked;

  if (hash && !PUBLIC_PATHS.has(pathname) && !verifySessionToken(req.cookies.get(SESSION_COOKIE)?.value, hash)) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }
    // Proxy redirects must be absolute (Next parses Location with no base URL);
    // Next rewrites same-host ones back to relative, so the internal address
    // behind a reverse proxy doesn't leak into the Location header.
    const login = req.nextUrl.clone();
    login.pathname = "/login";
    login.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(login);
  }

  return NextResponse.next();
}

export const config = {
  // Everything except Next's own static assets.
  matcher: "/((?!_next/static|_next/image|favicon.ico).*)",
};
