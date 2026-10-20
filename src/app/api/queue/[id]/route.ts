import { NextRequest, NextResponse } from "next/server";
import {
  approvedArtifact, jobAutomationDetail, latestSnapshot, listApplicationFields, markSubmitted, snapshotFromManualPosting,
} from "@/lib/automation";
import { saveAnswer } from "@/lib/apply/answers";
import { getJob, getPosting } from "@/lib/queries";
import { getDb } from "@/lib/db";
import { cancelJob, logEvent, pauseJob, retryJob, setWorkflow } from "@/lib/queue";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const id = Number((await params).id);
  if (!getJob(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(jobAutomationDetail(id));
}

/**
 * Queue controls for one application:
 *   pause | resume | cancel | retry — as named
 *   continue — use the description saved on the job page, then generate the resume
 *   automate — bring an application added by hand into the pipeline
 *   regenerate {engine?} — new resume run, on "codex" or "claude" if given
 *   mark_submitted — you submitted it (the watcher didn't see it, or a submission was unknown)
 *   not_submitted — after "submission unknown": you checked, and it didn't go through
 */
export async function POST(req: NextRequest, { params }: Params) {
  const id = Number((await params).id);
  const job = getJob(id);
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const body = await req.json();
  const { action, engine } = body;
  const chosen = engine === "claude" || engine === "codex" ? engine : undefined;

  try {
    switch (action) {
      case "pause":
        pauseJob(id, true);
        break;
      case "resume":
        pauseJob(id, false);
        break;
      case "cancel":
        cancelJob(id);
        break;
      case "retry":
        retryJob(id);
        break;
      case "mark_submitted":
        // For submissions the watcher couldn't see (tab closed, applied elsewhere).
        if (!markSubmitted(id, { how: "manual", detail: "Marked submitted from the queue" })) {
          return NextResponse.json({ error: "Already marked submitted" }, { status: 409 });
        }
        break;
      case "not_submitted": {
        const row = getDb().prepare("SELECT workflow_state FROM jobs WHERE id = ?").get(id) as { workflow_state: string | null };
        if (row.workflow_state !== "submission_unknown") {
          return NextResponse.json({ error: "Only for a submission whose outcome is unknown" }, { status: 409 });
        }
        setWorkflow(id, "ready_to_submit", "You checked: the submission didn't go through. It can be submitted again.");
        break;
      }
      case "prepare":
        if (!approvedArtifact(id)) return NextResponse.json({ error: "Approve a resume first" }, { status: 400 });
        retryJob(id, "prepare");
        break;
      case "answers": {
        // [{ field_key, answer, scope }] → answer bank, then fill again.
        const fields = new Map(listApplicationFields(id).map((f) => [f.field_key, f]));
        const list = Array.isArray(body.answers) ? body.answers : [];
        let saved = 0;
        for (const a of list) {
          const f = fields.get(String(a?.field_key));
          const text = typeof a?.answer === "string" ? a.answer.trim() : "";
          if (!f || !text) continue;
          // Attestations and narratives are never reused beyond this job unless chosen explicitly;
          // attestations are forced to job scope.
          const scope = f.category === "attestation" ? "job" : a.scope === "global" || a.scope === "company" ? a.scope : "job";
          saveAnswer({ label: f.label, options: JSON.parse(f.options), answer: text.slice(0, 5000), scope, company: job.company, jobId: id });
          saved++;
        }
        if (!saved) return NextResponse.json({ error: "No answers to save" }, { status: 400 });
        logEvent(id, "answers:saved", `${saved} answer${saved === 1 ? "" : "s"}`);
        if (approvedArtifact(id)) retryJob(id, "prepare");
        break;
      }
      case "regenerate": {
        // A fresh resume from the saved description, optionally on a specific engine.
        if (!latestSnapshot(id) && !snapshotFromManualPosting(id)) {
          return NextResponse.json({ error: "No saved description to generate from" }, { status: 400 });
        }
        retryJob(id, "resume", chosen ? { engine: chosen } : undefined);
        logEvent(id, "resume:regenerate", chosen ?? "default engine");
        break;
      }
      case "continue": {
        const snap = snapshotFromManualPosting(id) ?? latestSnapshot(id);
        if (!snap) {
          return NextResponse.json(
            { error: "No description saved yet. Open the job page, use Edit manually on the description, then Continue." },
            { status: 400 }
          );
        }
        logEvent(id, "manual_description", `Using ${snap.method} snapshot ${snap.id}`);
        retryJob(id, "resume");
        break;
      }
      case "automate": {
        const hasDescription = !!getPosting(id)?.description_md.trim();
        if (hasDescription) snapshotFromManualPosting(id);
        if (!hasDescription && !job.url) {
          return NextResponse.json({ error: "Add a job link or a description first" }, { status: 400 });
        }
        retryJob(id, hasDescription ? "resume" : "extract");
        break;
      }
      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Action failed" }, { status: 409 });
  }
  return NextResponse.json({ ok: true });
}
