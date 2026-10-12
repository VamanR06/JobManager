import fs from "fs";
import path from "path";
import { ARTIFACTS_DIR, DATA_DIR, WORK_DIR } from "./db";
import {
  approvedArtifact, createArtifact, defaultResumeEngine, getArtifact, getProfileMap, latestSnapshot, markSubmitted,
  nextArtifactVersion, saveApplicationFields, saveSnapshot, snapshotFromManualPosting,
} from "./automation";
import { ExtractionError, extractPosting } from "./extract";
import { applicationTarget, prepareApplication, SUPPORTED_ATS, type Ats, type PrepareOutcome } from "./apply/fill";
import type { BrowserOwner } from "./apply/browser";
import { getDb } from "./db";
import { getDocument, getJob, getPosting, upsertPosting } from "./queries";
import { blockTask, completeTask, failTask, logEvent, setWorkflow } from "./queue";
import { codexConfig } from "./codex/config";
import { cachedPreflight, type PreflightResult, type ResumeEngine } from "./codex/preflight";
import { runResumeBuilder, type ResumeRunResult } from "./codex/resume";
import { sha256File } from "./codex/verify";
import { ENGINE_LABELS, type ResumeEngineName, type Task } from "./workflow-types";

/**
 * Step bodies run by the worker. Each ends the task through the queue API
 * (complete / fail / block). A step returns "interrupted" when it stopped because
 * of cancel, shutdown or a lost lease — the worker decides what that means.
 */

export interface StepContext {
  /** The worker's single browser; created on first use. */
  browser?: () => BrowserOwner;
  owner: string;
  signal: AbortSignal;
  /** True once cancel/pause/shutdown was requested; check before any external action. */
  stopRequested: () => boolean;
  preflight?: (engine: ResumeEngine) => Promise<PreflightResult>;
  extract?: typeof extractPosting;
  runResume?: typeof runResumeBuilder;
}

export type StepResult = "done" | "interrupted";

// ---------- extract ----------

export async function runExtractStep(task: Task, ctx: StepContext): Promise<StepResult> {
  const job = getJob(task.job_id);
  if (!job?.url) {
    failTask(task.id, ctx.owner, "This application has no job link to extract from", false);
    return "done";
  }
  if (ctx.stopRequested()) return "interrupted";
  try {
    const posting = await (ctx.extract ?? extractPosting)(job.url);
    if (ctx.stopRequested()) return "interrupted";
    const snap = saveSnapshot(job.id, job.url, posting);
    logEvent(job.id, "extracted", `${posting.method}: ${snap.description_md.length} chars, sha256 ${snap.content_sha256.slice(0, 12)}`, task.id);
    completeTask(task.id, ctx.owner, { step: "resume" });
  } catch (err) {
    if (err instanceof ExtractionError) {
      if (err.kind === "closed") {
        failTask(task.id, ctx.owner, `Posting is closed: ${err.message}`, false);
      } else if (err.kind === "failed") {
        failTask(task.id, ctx.owner, err.message, true);
      } else {
        // Let the job page offer "Edit manually" for the description.
        if (!getPosting(job.id)?.description_md) {
          upsertPosting({ job_id: job.id, description_md: "", source: "parsed", fetch_status: "failed" });
        }
        blockTask(task.id, ctx.owner, `${err.message} Then press Continue on the queue.`);
      }
    } else if (err instanceof Error && err.name === "BlockedUrlError") {
      failTask(task.id, ctx.owner, err.message, false);
    } else {
      failTask(task.id, ctx.owner, `Extraction error: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  }
  return "done";
}

// ---------- resume ----------

interface ResumePayload {
  /** User-requested changes for a revision. */
  feedback?: string;
  /** Artifact being revised; its .tex is staged for context. */
  base_artifact_id?: number;
  /** Chosen engine for this run; otherwise the current default. */
  engine?: ResumeEngineName;
}

const OWNER_NAME = (process.env.RESUME_NAME ?? "Resume").replace(/[^\w.\-() ]+/g, "_").replace(/\s+/g, "_");

/** Copies verified files into immutable per-version storage and records hashes. */
function storeArtifact(task: Task, run: ResumeRunResult, snapshotId: number, feedback: string | null, engine: ResumeEngineName) {
  const v = run.verification!;
  const version = nextArtifactVersion(task.job_id);
  const dir = path.join(ARTIFACTS_DIR, `job-${task.job_id}`, `v${version}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const place = (src: string | null, name: string) => {
    if (!src) return null;
    const dest = path.join(dir, name);
    fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(dest, 0o400);
    return dest;
  };
  const pdf = place(v.pdfAbs, "resume.pdf")!;
  const tex = place(v.texAbs, "resume.tex")!;
  const report = place(v.reportAbs, "validation.md");
  fs.writeFileSync(path.join(dir, "checks.json"), JSON.stringify(v.checks, null, 2), { mode: 0o400 });
  const rel = (abs: string | null) => (abs ? path.relative(DATA_DIR, abs) : null);
  const artifact = createArtifact({
    job_id: task.job_id, codex_run_id: run.runId, snapshot_id: snapshotId, version,
    pdf_path: rel(pdf)!, tex_path: rel(tex)!, report_path: rel(report),
    pdf_sha256: sha256File(pdf), tex_sha256: sha256File(tex), page_count: v.pageCount,
    plugin_version: null, plugin_resource_hash: null,
    checks: JSON.stringify(v.checks), summary: run.result?.validation_summary ?? "", feedback, engine,
  });
  // Older unreviewed versions from the same engine are superseded (the other
  // engine's stays up for side-by-side comparison); approved ones stay as history.
  getDb()
    .prepare("UPDATE resume_artifacts SET status = 'superseded' WHERE job_id = ? AND engine = ? AND status = 'pending_review' AND id != ?")
    .run(task.job_id, engine, artifact.id);
  getDb()
    .prepare("UPDATE resume_artifacts SET plugin_version = (SELECT plugin_version FROM codex_runs WHERE id = ?), plugin_resource_hash = (SELECT plugin_resource_hash FROM codex_runs WHERE id = ?) WHERE id = ?")
    .run(run.runId, run.runId, artifact.id);
  return artifact;
}

export function artifactDownloadName(company: string): string {
  return `${OWNER_NAME}_Resume_${company.replace(/[^\w.\-() ]+/g, "_").replace(/\s+/g, "_")}`;
}

export async function runResumeStep(task: Task, ctx: StepContext): Promise<StepResult> {
  // A description pasted on the job page counts once there's no extracted one.
  const snapshot = latestSnapshot(task.job_id) ?? snapshotFromManualPosting(task.job_id);
  if (!snapshot) {
    blockTask(task.id, ctx.owner, "No saved job description yet. Add it on the job page (Edit manually), then press Continue.");
    return "done";
  }
  const payload = JSON.parse(task.payload || "{}") as ResumePayload;
  const engine: ResumeEngineName = payload.engine === "claude" || payload.engine === "codex" ? payload.engine : defaultResumeEngine();
  const pf = await (ctx.preflight ?? cachedPreflight)(engine);
  if (!pf.ok || !pf.plugin) {
    blockTask(task.id, ctx.owner, `Resume Builder setup needed (${ENGINE_LABELS[engine]}): ${pf.blockers.map((b) => b.message).join(" ")}`);
    return "done";
  }

  const cfg = codexConfig();
  const userFeedback = payload.feedback?.trim() || null;
  const base = payload.base_artifact_id ? getArtifact(payload.base_artifact_id) : null;
  let feedback = userFeedback ? `## Requested changes from the candidate\n\n${userFeedback}\n` : null;
  let previousTex = base ? path.join(DATA_DIR, base.tex_path) : null;
  const profile = getProfileMap();
  let last: ResumeRunResult | null = null;

  for (let pass = 0; pass <= cfg.repairLimit; pass++) {
    if (ctx.stopRequested()) return "interrupted";
    setWorkflow(
      task.job_id, "generating_resume",
      pass === 0 ? `${ENGINE_LABELS[engine]} is running the Resume Builder plugin` : `Repair run ${pass} of ${cfg.repairLimit} (${ENGINE_LABELS[engine]})`,
      task.id
    );
    last = await (ctx.runResume ?? runResumeBuilder)({
      jobId: task.job_id, taskId: task.id, attempt: task.attempts, owner: ctx.owner, snapshot, profile,
      preflight: pf, revisionFeedback: feedback, previousTexAbs: previousTex, signal: ctx.signal, config: cfg, engine,
    });
    logEvent(task.job_id, `codex:${last.outcome}`, `run ${last.runId}: ${last.message}`.slice(0, 1000), task.id);

    switch (last.outcome) {
      case "verified": {
        setWorkflow(task.job_id, "validating_resume", "Storing verified artifacts", task.id);
        const artifact = storeArtifact(task, last, snapshot.id, userFeedback, engine);
        completeTask(task.id, ctx.owner, undefined, {
          state: "needs_input",
          detail: `Resume v${artifact.version} (${ENGINE_LABELS[engine]}) passed checks and is ready for your review.`,
        });
        return "done";
      }
      case "verification_failed":
        if (pass < cfg.repairLimit) {
          // Repairs still go through the plugin, with the concrete failures attached.
          feedback = [
            userFeedback ? `## Requested changes from the candidate\n\n${userFeedback}\n` : "",
            "## Automated checks failed on the previous version\n",
            ...(last.verification?.failures ?? [last.message]).map((f) => `- ${f}`),
          ].join("\n");
          previousTex = last.verification?.texAbs ?? previousTex;
          continue;
        }
        blockTask(
          task.id, ctx.owner,
          `Resume still failed checks after ${cfg.repairLimit} repair runs: ${last.message}`.slice(0, 1500)
        );
        return "done";
      case "needs_input":
        blockTask(task.id, ctx.owner, `Resume Builder needs input: ${last.message}`);
        return "done";
      case "blocked":
        blockTask(task.id, ctx.owner, last.message);
        return "done";
      case "cancelled":
        return "interrupted";
      case "timeout":
      case "failed":
        failTask(task.id, ctx.owner, last.message, true);
        return "done";
    }
  }
  return "done";
}

// ---------- prepare (fill the application form; never submits) ----------

export async function runPrepareStep(task: Task, ctx: StepContext): Promise<StepResult> {
  const job = getJob(task.job_id);
  const meta = getDb().prepare("SELECT ats, ats_tenant, posting_id, application_url FROM jobs WHERE id = ?").get(task.job_id) as {
    ats: string | null; ats_tenant: string | null; posting_id: string | null; application_url: string | null;
  };
  if (!job || !meta.ats || !SUPPORTED_ATS.includes(meta.ats as Ats) || !meta.posting_id) {
    failTask(task.id, ctx.owner, `Automatic form filling isn't available for ${meta?.ats ?? "this site"} yet; apply manually`, false);
    return "done";
  }
  const target = applicationTarget(meta.ats as Ats, meta.ats_tenant, meta.posting_id, meta.application_url);
  if (!target) {
    failTask(task.id, ctx.owner, "Couldn't work out the application page for this posting; apply manually", false);
    return "done";
  }
  const approved = approvedArtifact(task.job_id);
  if (!approved) {
    blockTask(task.id, ctx.owner, "Approve a resume version first, then press Prepare application.");
    return "done";
  }
  if (!ctx.browser) {
    failTask(task.id, ctx.owner, "No browser available in this worker", false);
    return "done";
  }

  // The employer sees the uploaded file's name, so give it a proper one.
  const uploadDir = path.join(WORK_DIR, "uploads", `job-${task.job_id}`);
  fs.mkdirSync(uploadDir, { recursive: true, mode: 0o700 });
  const resumeName = `${artifactDownloadName(job.company)}.pdf`;
  const resumePath = path.join(uploadDir, resumeName);
  // Artifacts are read-only (0400) and macOS copies keep the mode, so a copy left
  // by an earlier attempt can't be overwritten: replace it, then make it ours.
  fs.rmSync(resumePath, { force: true });
  fs.copyFileSync(path.join(DATA_DIR, approved.pdf_path), resumePath);
  fs.chmodSync(resumePath, 0o600);
  const cover = job.cover_letter_id ? getDocument(job.cover_letter_id) : null;
  const coverPath = cover && cover.file_path.toLowerCase().endsWith(".pdf") ? path.join(DATA_DIR, cover.file_path) : null;

  if (ctx.stopRequested()) return "interrupted";
  setWorkflow(task.job_id, "filling", `Opening the ${meta.ats} application in the JobManager browser`, task.id);
  let outcome: PrepareOutcome;
  try {
    const page = await ctx.browser().pageFor(task.job_id, target.url, target.hosts);
    outcome = await prepareApplication({
      page, resumeFileName: resumeName, stopRequested: ctx.stopRequested, url: target.url,
      adoptPage: (p) => ctx.browser!().adopt(task.job_id, p, target.hosts),
      ctx: { profile: getProfileMap(), company: job.company, jobId: job.id, resumePath, coverLetterPath: coverPath },
    });
  } catch (err) {
    failTask(task.id, ctx.owner, `Browser error: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`, true);
    return "done";
  }

  if (outcome.kind === "already_submitted") {
    markSubmitted(task.job_id, { how: "confirmation_page", detail: `Found on reopening the tab: ${outcome.message}` });
    completeTask(task.id, ctx.owner);
    return "done";
  }
  // A run that found no form keeps the previous field list (and your answers view).
  if (outcome.reports.length) saveApplicationFields(task.job_id, outcome.reports.map((r) => ({
    field_key: r.field.key, label: r.field.label, kind: r.field.kind, required: r.field.required,
    options: r.field.options.map((o) => o.label), category: r.resolution.category,
    answer: r.resolution.answer, answer_source: r.resolution.source, status: r.status, note: r.note, readback: r.readback,
    max_length: r.field.maxLength ?? null,
  })));
  const counts = outcome.reports.reduce<Record<string, number>>((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {});
  logEvent(task.job_id, `prepare:${outcome.kind}`, `${outcome.message} (${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")})`, task.id);

  if (outcome.kind === "needs_input") {
    blockTask(task.id, ctx.owner, `${outcome.message}. Answer them on the queue (or directly in the browser tab), then the rest is filled.`);
  } else if (outcome.kind === "blocked") {
    blockTask(task.id, ctx.owner, `${outcome.message}. The tab is open in the JobManager browser for you to take over.`);
  } else {
    if (outcome.overwrites.length) logEvent(task.job_id, "prepare:parser_overwrite", `Re-entered after the site changed them: ${outcome.overwrites.join(", ")}`, task.id);
    completeTask(task.id, ctx.owner, undefined, {
      state: "ready_to_submit",
      detail: "Filled and checked in the JobManager browser window. Review it there and click Submit yourself (automatic submission isn't built yet).",
    });
  }
  return "done";
}
