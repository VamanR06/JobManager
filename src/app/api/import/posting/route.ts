import { NextRequest, NextResponse } from "next/server";
import { BrowserImportError, importFromBrowser, type BrowserPosting } from "@/lib/browser-import";

/**
 * Saves a posting the person's browser read (the /save page, opened by the
 * "Save to JobManager" bookmarklet). Behind the normal sign-in and same-origin
 * check. Body: { posting, job_id?, allow_duplicate? }.
 *   201 { outcome: "created", job_id } · 200 { outcome: "updated", job_id }
 *   409 { outcome: "duplicate", same_posting, similar } · 400 { error }
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { posting?: BrowserPosting; job_id?: unknown; allow_duplicate?: unknown } | null;
  if (!body?.posting || typeof body.posting !== "object") return NextResponse.json({ error: "posting is required" }, { status: 400 });
  const jobId = body.job_id === undefined || body.job_id === null ? undefined : Number(body.job_id);
  if (jobId !== undefined && !Number.isInteger(jobId)) return NextResponse.json({ error: "job_id must be an application id" }, { status: 400 });
  try {
    const out = importFromBrowser(body.posting, { jobId, allowDuplicate: body.allow_duplicate === true });
    return NextResponse.json(out, { status: out.outcome === "created" ? 201 : out.outcome === "duplicate" ? 409 : 200 });
  } catch (err) {
    if (err instanceof BrowserImportError) return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }
}
