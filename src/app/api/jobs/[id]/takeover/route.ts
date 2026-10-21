import { NextRequest, NextResponse } from "next/server";
import { HarnessError, serverHarness, TAKE_OVER_KEYS, type TakeOverInput } from "@/lib/apply/harness";
import { getJob } from "@/lib/queries";

type Params = { params: Promise<{ id: string }> };

/**
 * Take over: the person drives the application's tab in the server's browser
 * from the job page (e.g. to solve a CAPTCHA). Behind the normal sign-in.
 *
 *   GET  → JPEG of what the tab shows; X-View-Width / X-View-Height give its
 *          size in the CSS pixels clicks use, X-Page-Url where it is.
 *   POST { kind: "click", x, y } | { kind: "type", text } | { kind: "key", key } | { kind: "scroll", dy, x?, y? }
 */
export async function GET(_req: NextRequest, { params }: Params) {
  const id = Number((await params).id);
  if (!getJob(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    const v = await serverHarness().view(id);
    return new NextResponse(new Uint8Array(v.jpeg), {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "no-store",
        "X-View-Width": String(v.width),
        "X-View-Height": String(v.height),
        "X-Page-Url": encodeURI(v.url),
      },
    });
  } catch (err) {
    return failure(id, "view", err);
  }
}

export async function POST(req: NextRequest, { params }: Params) {
  const id = Number((await params).id);
  if (!getJob(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const input = parseInput(await req.json().catch(() => null));
  if (!input) return NextResponse.json({ error: "Unknown input" }, { status: 400 });
  try {
    const out = await serverHarness().takeOver(id, input);
    // Typed text is the person's own input: logged by length only.
    console.log(`[browser] app ${id} take over ${input.kind}${input.kind === "type" ? ` (${input.text.length} chars)` : input.kind === "key" ? ` ${input.key}` : ""} → ${out.url}`);
    return NextResponse.json(out);
  } catch (err) {
    return failure(id, input.kind, err);
  }
}

function parseInput(b: unknown): TakeOverInput | null {
  if (!b || typeof b !== "object") return null;
  const o = b as Record<string, unknown>;
  const num = (v: unknown, max: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? v : null);
  switch (o.kind) {
    case "click": {
      const x = num(o.x, 10_000), y = num(o.y, 10_000);
      return x === null || y === null ? null : { kind: "click", x, y };
    }
    case "type":
      return typeof o.text === "string" && o.text.length > 0 && o.text.length <= 2_000 ? { kind: "type", text: o.text } : null;
    case "key":
      return TAKE_OVER_KEYS.includes(o.key as (typeof TAKE_OVER_KEYS)[number]) ? { kind: "key", key: o.key as (typeof TAKE_OVER_KEYS)[number] } : null;
    case "scroll": {
      const dy = typeof o.dy === "number" && Number.isFinite(o.dy) ? Math.max(-5_000, Math.min(5_000, o.dy)) : null;
      if (dy === null) return null;
      const x = o.x === undefined ? undefined : num(o.x, 10_000) ?? undefined;
      const y = o.y === undefined ? undefined : num(o.y, 10_000) ?? undefined;
      return { kind: "scroll", dy, x, y };
    }
  }
  return null;
}

function failure(id: number, what: string, err: unknown) {
  const message = err instanceof HarnessError ? err.message : `Browser error: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`;
  console.error(`[browser] app ${id} take over ${what} → ${message}`);
  return NextResponse.json({ error: message }, { status: 409 });
}
