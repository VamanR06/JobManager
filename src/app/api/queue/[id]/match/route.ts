import { NextRequest, NextResponse } from "next/server";
import { approvedArtifact, defaultResumeEngine } from "@/lib/automation";
import { aiMatch } from "@/lib/apply/match";
import { getJob } from "@/lib/queries";
import { logEvent, retryJob } from "@/lib/queue";

type Params = { params: Promise<{ id: string }> };

export const maxDuration = 300;

/**
 * Matches leftover form questions to the person's own facts with the chosen
 * engine, saves accepted matches for this application, and refills the form.
 * Body: { engine? }.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const id = Number((await params).id);
  if (!getJob(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const engine = body.engine === "claude" || body.engine === "codex" ? body.engine : defaultResumeEngine();
  try {
    const r = await aiMatch({ jobId: id, engine, signal: req.signal });
    logEvent(id, "answers:ai_matched", `${r.matched.length} matched, ${r.suggested.length} suggested, ${r.rejected.length} rejected, ${r.unmatched.length} left, via ${engine} in ${r.seconds}s: ${r.matched.map((m) => `${m.label.slice(0, 40)} → ${m.value.slice(0, 40)} (${m.fact_id})`).join("; ")}`);
    let refilling = false;
    if (r.matched.length && approvedArtifact(id)) {
      try {
        retryJob(id, "prepare");
        refilling = true;
      } catch {
        // e.g. already submitted; the matches are still saved
      }
    }
    return NextResponse.json({ ...r, engine, refilling });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Matching failed" }, { status: 422 });
  }
}
