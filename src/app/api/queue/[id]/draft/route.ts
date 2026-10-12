import { NextRequest, NextResponse } from "next/server";
import { defaultResumeEngine, listApplicationFields } from "@/lib/automation";
import { draftAnswers } from "@/lib/apply/draft";
import { getJob } from "@/lib/queries";
import { logEvent } from "@/lib/queue";

type Params = { params: Promise<{ id: string }> };

/** Drafting takes a minute or more; keep Next from cutting it short. */
export const maxDuration = 400;

/**
 * Drafts answers for written questions (narratives and other free-text
 * questions still waiting on you). Body: { field_keys?: string[], engine? }.
 * Returns drafts only; nothing is saved until the person saves answers.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const id = Number((await params).id);
  if (!getJob(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const engine = body.engine === "claude" || body.engine === "codex" ? body.engine : defaultResumeEngine();
  const wanted = Array.isArray(body.field_keys) ? new Set(body.field_keys.map(String)) : null;

  // Only free-text questions: facts, eligibility, demographics and attestations are never model-written.
  const questions = listApplicationFields(id)
    .filter((f) => f.status === "unknown" && (f.category === "narrative" || f.category === "other"))
    .filter((f) => f.kind === "text" || f.kind === "textarea")
    .filter((f) => !wanted || wanted.has(f.field_key))
    .map((f) => ({ field_key: f.field_key, label: f.label, max_length: f.max_length }));
  if (!questions.length) return NextResponse.json({ error: "No written questions to draft" }, { status: 400 });

  try {
    const result = await draftAnswers({ jobId: id, questions, engine, signal: req.signal });
    logEvent(id, "answers:drafted", `${result.drafts.length} draft${result.drafts.length === 1 ? "" : "s"} via ${engine} in ${result.seconds}s (run ${result.runId})`);
    return NextResponse.json({ ...result, engine });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Drafting failed" }, { status: 422 });
  }
}
