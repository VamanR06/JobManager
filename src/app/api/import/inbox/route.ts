import { NextRequest, NextResponse } from "next/server";
import { inboxAuthorized, inboxToken } from "@/lib/auth";
import { importSharedText } from "@/lib/inbox";

/**
 * Share-sheet inbox: takes whatever an iOS Shortcut shares (a URL, or a caption
 * with links in it), adds the links to the applications list — no automation
 * is queued — and returns a one-line summary.
 * Body: JSON `{ "text": "..." }`, or the raw text itself.
 */
export async function POST(req: NextRequest) {
  // The proxy already checked this; checked again so the route is safe on its own.
  if (!inboxToken()) return NextResponse.json({ error: "Inbox is off (JOBMANAGER_INBOX_TOKEN not set)" }, { status: 404 });
  if (!inboxAuthorized(req.headers.get("authorization"))) {
    return NextResponse.json({ error: "Bad inbox token" }, { status: 401 });
  }

  const raw = await req.text();
  if (raw.length > 100_000) return NextResponse.json({ error: "Too much text" }, { status: 413 });
  let text = raw;
  if ((req.headers.get("content-type") ?? "").includes("application/json")) {
    try {
      const body = JSON.parse(raw);
      text = typeof body?.text === "string" ? body.text : typeof body?.url === "string" ? body.url : "";
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
  }

  const out = await importSharedText(text);
  const created = out.results.some((r) => r.outcome === "created");
  return NextResponse.json(out, { status: created ? 201 : 200 });
}
