import "./setup-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { getDb } from "../src/lib/db";
import { importUrls, listArtifacts, latestSnapshot } from "../src/lib/automation";
import { ExtractionError, type ExtractedPosting } from "../src/lib/extract";
import { getJob, getPosting } from "../src/lib/queries";
import { claimTask } from "../src/lib/queue";
import { runExtractStep, runResumeStep, type StepContext } from "../src/lib/steps";
import type { ResumeRunInput, ResumeRunResult } from "../src/lib/codex/resume";
import { fakePreflight } from "./helpers";

const db = getDb();
process.env.RESUME_REPAIR_LIMIT = "2";
const job = (id: number) => db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Record<string, unknown>;
const liveTask = (jobId: number) => db.prepare("SELECT * FROM tasks WHERE job_id = ? ORDER BY id DESC LIMIT 1").get(jobId) as Record<string, unknown>;

const description = "Build backend services. ".repeat(40);
const posting: ExtractedPosting = {
  title: "Backend Intern", company: "Real Co", location: "Remote", employment_type: "Intern", posting_id: "9",
  description_md: description, final_url: "https://boards.greenhouse.io/realco/jobs/9", canonical_url: null,
  application_url: "https://boards.greenhouse.io/realco/jobs/9#app", method: "greenhouse_api",
};

function ctx(overrides: Partial<StepContext> = {}): StepContext {
  return { owner: "w", signal: new AbortController().signal, stopRequested: () => false, preflight: async () => fakePreflight(), ...overrides };
}

function claimFor(jobId: number) {
  const t = claimTask("w", 60_000)!;
  assert.equal(t.job_id, jobId);
  return t;
}

test("extraction saves a dated snapshot, fills placeholders, and queues the resume", async () => {
  const [r] = importUrls(["https://boards.greenhouse.io/realco/jobs/9"]);
  assert.equal(getJob(r.job_id!)!.title, "(importing…)");
  await runExtractStep(claimFor(r.job_id!), ctx({ extract: async () => posting }));
  const j = getJob(r.job_id!)!;
  assert.equal(j.title, "Backend Intern");
  assert.equal(j.company, "Real Co");
  assert.equal(getPosting(j.id)!.description_md, description, "existing posting view is updated");
  assert.equal(latestSnapshot(j.id)!.content_sha256.length, 64);
  assert.equal(job(j.id).application_url, posting.application_url);
  assert.equal(liveTask(j.id).step, "resume");
  db.exec("UPDATE tasks SET state = 'done' WHERE state = 'queued'");
});

test("closed postings fail without retry; incomplete ones ask for a manual description", async () => {
  const [closed] = importUrls(["https://example.com/jobs/closed"]);
  await runExtractStep(claimFor(closed.job_id!), ctx({ extract: async () => { throw new ExtractionError("closed", "gone"); } }));
  assert.equal(job(closed.job_id!).workflow_state, "failed");
  assert.equal(liveTask(closed.job_id!).state, "failed");

  const [thin] = importUrls(["https://example.com/jobs/thin"]);
  await runExtractStep(claimFor(thin.job_id!), ctx({ extract: async () => { throw new ExtractionError("incomplete", "Only 80 characters."); } }));
  assert.equal(job(thin.job_id!).workflow_state, "needs_input");
  assert.equal(getPosting(thin.job_id!)!.fetch_status, "failed", "job page offers manual entry");
  db.exec("UPDATE tasks SET state = 'done' WHERE state IN ('queued','blocked')");
});

/** Stub runner that fabricates real files so the artifact store can hash them. */
function stubRuns(outcomes: ResumeRunResult["outcome"][]) {
  const calls: ResumeRunInput[] = [];
  const runResume = async (input: ResumeRunInput): Promise<ResumeRunResult> => {
    calls.push(input);
    const outcome = outcomes[calls.length - 1];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jm-stub-"));
    const pdf = path.join(dir, "resume.pdf");
    const tex = path.join(dir, "resume.tex");
    fs.writeFileSync(pdf, `%PDF-1.5 v${calls.length}`);
    fs.writeFileSync(tex, `\\documentclass{article} v${calls.length}`);
    const failures = outcome === "verification_failed" ? ["The PDF is 2 pages; it must be exactly one page."] : [];
    const runId = Number(db.prepare("INSERT INTO codex_runs (job_id, purpose, work_dir, plugin_version) VALUES (?, 'resume', ?, '0.0.1')").run(input.jobId, dir).lastInsertRowid);
    return {
      outcome, runId, workDir: dir, message: failures.join(" ") || outcome, process: {} as ResumeRunResult["process"],
      result: { status: "completed", pdf_path: "output/resume.pdf", tex_path: "output/resume.tex", validation_report_path: null, validation_summary: "fine", plugin: { skill_name: "x", version: null, skill_file: null }, resources_loaded: [], revision_count: 0, unresolved_failures: [], coverage_gaps: [], blockers: [] },
      verification: { passed: outcome === "verified", checks: [{ name: "one_page", status: failures.length ? "fail" : "pass", detail: "" }], failures, pdfAbs: pdf, texAbs: tex, reportAbs: null, pageCount: 1 },
    };
  };
  return { calls, runResume };
}

async function resumeJob(url: string) {
  const [r] = importUrls([url]);
  await runExtractStep(claimFor(r.job_id!), ctx({ extract: async () => posting }));
  return r.job_id!;
}

test("failed checks are repaired through the plugin runner, then stored immutably", async () => {
  const jobId = await resumeJob("https://example.com/jobs/repair");
  const stub = stubRuns(["verification_failed", "verified"]);
  await runResumeStep(claimFor(jobId), ctx({ runResume: stub.runResume }));
  assert.equal(stub.calls.length, 2, "repair is another plugin run, not a local rewrite");
  assert.equal(stub.calls[0].revisionFeedback, null);
  assert.match(stub.calls[1].revisionFeedback!, /exactly one page/);
  assert.ok(stub.calls[1].previousTexAbs, "previous .tex is staged for context");
  const [artifact] = listArtifacts(jobId);
  assert.equal(artifact.version, 1);
  assert.equal(artifact.status, "pending_review");
  assert.equal(artifact.pdf_sha256.length, 64);
  const abs = path.join(process.env.JOBMANAGER_DATA_DIR!, artifact.pdf_path);
  assert.equal(fs.statSync(abs).mode & 0o222, 0, "stored artifacts are read-only");
  assert.equal(job(jobId).workflow_state, "needs_input");
  assert.equal(liveTask(jobId).state, "done");
});

test("hitting the repair limit asks the user instead of claiming success", async () => {
  const jobId = await resumeJob("https://example.com/jobs/limit");
  const stub = stubRuns(["verification_failed", "verification_failed", "verification_failed"]);
  await runResumeStep(claimFor(jobId), ctx({ runResume: stub.runResume }));
  assert.equal(stub.calls.length, 3, "first run + 2 repairs");
  assert.equal(listArtifacts(jobId).length, 0);
  assert.equal(liveTask(jobId).state, "blocked");
  assert.match(String(job(jobId).workflow_detail), /after 2 repair runs/);
});

test("setup problems block with the specific reason and never run Codex", async () => {
  const jobId = await resumeJob("https://example.com/jobs/setup");
  const stub = stubRuns(["verified"]);
  await runResumeStep(claimFor(jobId), ctx({
    runResume: stub.runResume,
    preflight: async () => ({ ...fakePreflight(), ok: false, plugin: null, blockers: [{ code: "codex_login", message: "Codex is not logged in." }] }),
  }));
  assert.equal(stub.calls.length, 0);
  assert.match(String(job(jobId).workflow_detail), /not logged in/);
});

test("login expiry and quota become blockers; a timeout is retried", async () => {
  for (const [outcome, state] of [["blocked", "needs_input"], ["timeout", "retry_wait"]] as const) {
    const jobId = await resumeJob(`https://example.com/jobs/${outcome}`);
    const stub = stubRuns([outcome]);
    await runResumeStep(claimFor(jobId), ctx({ runResume: stub.runResume }));
    assert.equal(job(jobId).workflow_state, state);
    db.exec("UPDATE tasks SET state = 'done' WHERE state IN ('queued','blocked')");
  }
});
