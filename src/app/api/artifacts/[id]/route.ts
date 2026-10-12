import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getArtifact, setArtifactStatus } from "@/lib/automation";
import { createDocument, getJob, updateJob } from "@/lib/queries";
import { logEvent, retryJob, setWorkflow } from "@/lib/queue";
import { artifactDownloadName } from "@/lib/steps";
import { SUPPORTED_ATS } from "@/lib/apply/fill";
import type { ArtifactCheck } from "@/lib/workflow-types";

type Params = { params: Promise<{ id: string }> };

/**
 * Review actions on a generated resume:
 *   approve — register it as a resume document and link it to the application
 *   reject  — mark it rejected
 *   revise  — run Resume Builder again with your feedback (and this version as context)
 */
export async function POST(req: NextRequest, { params }: Params) {
  const artifact = getArtifact(Number((await params).id));
  if (!artifact) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const job = getJob(artifact.job_id);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  const { action, feedback, accept_failed_checks, engine } = await req.json();

  if (action === "approve") {
    if (artifact.status === "approved") return NextResponse.json({ ok: true });
    const failed = (JSON.parse(artifact.checks) as ArtifactCheck[]).filter((c) => c.status === "fail");
    if (failed.length && accept_failed_checks !== true) {
      return NextResponse.json(
        { error: `This version failed ${failed.length} check(s); confirm to approve it anyway.`, failed },
        { status: 409 }
      );
    }
    const name = `${artifactDownloadName(job.company)}.pdf`;
    // The artifact file is immutable, so the document row points straight at it.
    const doc = getDb().transaction(() => {
      const d = createDocument("resume", name, artifact.pdf_path, { generated: true, source_job_id: job.id });
      updateJob(job.id, { resume_id: d.id });
      setArtifactStatus(artifact.id, "approved", d.id);
      // One current version per application: the rest become history (Show all versions).
      getDb()
        .prepare("UPDATE resume_artifacts SET status = 'superseded' WHERE job_id = ? AND id != ? AND status IN ('pending_review', 'approved')")
        .run(job.id, artifact.id);
      return d;
    })();
    logEvent(job.id, "resume:approved", `v${artifact.version} → document ${doc.id}${failed.length ? " (approved despite failed checks)" : ""}`);
    const ats = (getDb().prepare("SELECT ats FROM jobs WHERE id = ?").get(job.id) as { ats: string | null }).ats;
    if (ats && (SUPPORTED_ATS as string[]).includes(ats)) {
      retryJob(job.id, "prepare");
      logEvent(job.id, "prepare:queued", `Filling the ${ats} form with resume v${artifact.version}`);
    } else {
      setWorkflow(job.id, "needs_input", `Resume v${artifact.version} approved and linked. Form filling for ${ats ?? "this site"} isn't built yet, so apply manually.`);
    }
    return NextResponse.json({ ok: true, document: doc });
  }

  if (action === "reject") {
    setArtifactStatus(artifact.id, "rejected");
    logEvent(job.id, "resume:rejected", `v${artifact.version}`);
    return NextResponse.json({ ok: true });
  }

  if (action === "revise") {
    const text = typeof feedback === "string" ? feedback.trim() : "";
    if (!text) return NextResponse.json({ error: "Describe what to change" }, { status: 400 });
    try {
      retryJob(job.id, "resume", {
        feedback: text.slice(0, 5000), base_artifact_id: artifact.id,
        // Revise on the engine that made this version unless another is picked.
        engine: engine === "claude" || engine === "codex" ? engine : artifact.engine,
      });
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : "Could not queue revision" }, { status: 409 });
    }
    logEvent(job.id, "resume:revision_requested", `from v${artifact.version}`);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
