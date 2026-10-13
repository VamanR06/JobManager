import crypto from "crypto";
import { getDb } from "./db";
import { createEvent, createJob, getJob, getPosting, updateJob, upsertPosting } from "./queries";
import { enqueue, logEvent } from "./queue";
import { analyzeUrl, splitPastedUrls } from "./urls";
import type { ExtractedPosting } from "./extract";
import { parsePostingUrl, type ParsedPosting } from "./parser";
import type { Job } from "./types";
import type {
  ApplicationField, CodexRun, JobSnapshot, ProfileFact, QueueRow, ResumeArtifact, ResumeEngineName, Task, WorkflowEvent,
} from "./workflow-types";

/** Placeholder title for an imported job until extraction fills in the real one. */
export const IMPORTING_TITLE = "(importing…)";

const sha256 = (s: string | Buffer) => crypto.createHash("sha256").update(s).digest("hex");

// ---------- import ----------

export type ImportPreviewItem =
  | { input: string; status: "new"; normalized: string; ats: string | null; key: string; warning: string | null }
  | { input: string; status: "duplicate"; normalized: string; ats: string | null; key: string; existing_job_id: number; existing_label: string; warning: null }
  | { input: string; status: "repeated"; normalized: string; key: string }
  | { input: string; status: "invalid" | "unsupported"; message: string };

function findByKey(key: string): Pick<Job, "id" | "company" | "title"> | null {
  return (
    (getDb().prepare("SELECT id, company, title FROM jobs WHERE posting_key = ? ORDER BY id LIMIT 1").get(key) as
      | Pick<Job, "id" | "company" | "title">
      | undefined) ?? null
  );
}

/** Classifies each pasted link without touching the network. */
export function previewImport(text: string): ImportPreviewItem[] {
  const seen = new Map<string, string>();
  return splitPastedUrls(text).map((input): ImportPreviewItem => {
    const info = analyzeUrl(input);
    if (!info.ok) return { input, status: info.reason, message: info.message };
    if (seen.has(info.key)) return { input, status: "repeated", normalized: info.normalized, key: info.key };
    seen.set(info.key, input);
    const existing = findByKey(info.key);
    if (existing) {
      return {
        input, status: "duplicate", normalized: info.normalized, ats: info.ats, key: info.key,
        existing_job_id: existing.id, existing_label: `${existing.company} — ${existing.title}`, warning: null,
      };
    }
    return { input, status: "new", normalized: info.normalized, ats: info.ats, key: info.key, warning: info.warning };
  });
}

function placeholderCompany(info: { tenant: string | null; normalized: string }): string {
  if (info.tenant) return info.tenant.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return new URL(info.normalized).hostname.replace(/^www\./, "");
}

export interface ImportResult {
  input: string;
  outcome: "created" | "duplicate" | "invalid" | "unsupported";
  job_id?: number;
  message?: string;
}

/**
 * Creates one application per new link (through the existing createJob service)
 * and queues extraction. The dedup check and insert share an IMMEDIATE
 * transaction, so concurrent imports of equivalent links can't both insert.
 */
export function importUrls(inputs: string[]): ImportResult[] {
  const db = getDb();
  return inputs.map((input): ImportResult => {
    const info = analyzeUrl(input);
    if (!info.ok) return { input, outcome: info.reason, message: info.message };
    return db.transaction((): ImportResult => {
      const existing = findByKey(info.key);
      if (existing) return { input, outcome: "duplicate", job_id: existing.id, message: `${existing.company} — ${existing.title}` };
      const job = createJob({ company: placeholderCompany(info), title: IMPORTING_TITLE, url: info.normalized });
      db.prepare("UPDATE jobs SET ats = ?, ats_tenant = ?, posting_id = ?, posting_key = ? WHERE id = ?").run(
        info.ats, info.tenant, info.postingId, info.key, job.id
      );
      logEvent(job.id, "imported", info.normalized === input.trim() ? input.trim() : `${input.trim()} → ${info.normalized}`);
      enqueue(job.id, "extract");
      return { input, outcome: "created", job_id: job.id };
    }).immediate();
  });
}

/** Title for a hand-added job whose posting page couldn't be read. */
export const UNKNOWN_TITLE = "(title unknown)";

/**
 * Adds links as hand-tracked applications, like the Add form: company, title and
 * description come from the posting page when it can be read, and no task is
 * queued (workflow_state stays NULL) — "automate" on the job starts the pipeline.
 * Each starts with a "to apply" status.
 */
export async function addUrlsManually(
  inputs: string[],
  parse: (url: string) => Promise<ParsedPosting> = parsePostingUrl
): Promise<ImportResult[]> {
  const db = getDb();
  const out: ImportResult[] = [];
  for (const input of inputs) {
    const info = analyzeUrl(input);
    if (!info.ok) {
      out.push({ input, outcome: info.reason, message: info.message });
      continue;
    }
    const dupe = findByKey(info.key);
    if (dupe) {
      out.push({ input, outcome: "duplicate", job_id: dupe.id, message: `${dupe.company} — ${dupe.title}` });
      continue;
    }
    let parsed: ParsedPosting | null = null;
    try {
      parsed = await parse(info.normalized);
    } catch {
      // Still added; the job page offers editing the description by hand.
    }
    // Dedup is re-checked inside the insert transaction: the fetch above awaited.
    out.push(db.transaction((): ImportResult => {
      const existing = findByKey(info.key);
      if (existing) return { input, outcome: "duplicate", job_id: existing.id, message: `${existing.company} — ${existing.title}` };
      const company = parsed?.company?.trim() || placeholderCompany(info);
      const title = parsed?.title?.trim() || UNKNOWN_TITLE;
      const job = createJob({ company, title, url: info.normalized });
      db.prepare("UPDATE jobs SET ats = ?, ats_tenant = ?, posting_id = ?, posting_key = ? WHERE id = ?").run(
        info.ats, info.tenant, info.postingId, info.key, job.id
      );
      upsertPosting(
        parsed
          ? { job_id: job.id, ...parsed, source: "parsed", fetch_status: "ok" }
          : { job_id: job.id, description_md: "", source: "parsed", fetch_status: "failed" }
      );
      createEvent({ job_id: job.id, status: "to_apply" });
      return { input, outcome: "created", job_id: job.id, message: `${company} — ${title}` };
    }).immediate());
  }
  return out;
}

// ---------- snapshots ----------

/**
 * Stores a dated snapshot and mirrors it into the existing `postings` row so the
 * job page shows it. Company/title only replace the import placeholders, never
 * values the user has edited.
 */
export function saveSnapshot(jobId: number, sourceUrl: string, p: ExtractedPosting | { method: "manual"; description_md: string }): JobSnapshot {
  const db = getDb();
  return db.transaction(() => {
    const full: Partial<Omit<ExtractedPosting, "method">> & { description_md: string; method: string } = p;
    const res = db
      .prepare(
        `INSERT INTO job_snapshots (job_id, source_url, final_url, canonical_url, application_url, title, company,
           location, employment_type, posting_id, description_md, content_sha256, method)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        jobId, sourceUrl, full.final_url ?? null, full.canonical_url ?? null, full.application_url ?? null,
        full.title ?? null, full.company ?? null, full.location ?? null, full.employment_type ?? null,
        full.posting_id ?? null, full.description_md, sha256(full.description_md), full.method
      );
    if (full.method !== "manual") {
      upsertPosting({
        job_id: jobId, title: full.title, company: full.company, location: full.location,
        description_md: full.description_md, source: "parsed", fetch_status: "ok",
      });
      const job = getJob(jobId)!;
      const placeholder = db.prepare("SELECT ats_tenant, url FROM jobs WHERE id = ?").get(jobId) as { ats_tenant: string | null; url: string };
      const info = analyzeUrl(placeholder.url);
      updateJob(jobId, {
        title: job.title === IMPORTING_TITLE && full.title ? full.title : undefined,
        company: info.ok && job.company === placeholderCompany(info) && full.company ? full.company : undefined,
      });
      if (full.application_url) db.prepare("UPDATE jobs SET application_url = ? WHERE id = ?").run(full.application_url, jobId);
      // A redirect to a recognised ATS: record its identity too (the original key stays for dedup).
      if (full.final_url) {
        const finalInfo = analyzeUrl(full.final_url);
        if (finalInfo.ok && finalInfo.ats) {
          db.prepare("UPDATE jobs SET ats = COALESCE(ats, ?), posting_id = COALESCE(posting_id, ?) WHERE id = ?").run(
            finalInfo.ats, finalInfo.postingId, jobId
          );
        }
      }
    }
    return db.prepare("SELECT * FROM job_snapshots WHERE id = ?").get(res.lastInsertRowid) as JobSnapshot;
  }).immediate();
}

export function latestSnapshot(jobId: number): JobSnapshot | null {
  return (getDb().prepare("SELECT * FROM job_snapshots WHERE job_id = ? ORDER BY id DESC LIMIT 1").get(jobId) as JobSnapshot | undefined) ?? null;
}

/** Turns a description the user saved by hand (job page → Edit manually) into a snapshot. */
export function snapshotFromManualPosting(jobId: number): JobSnapshot | null {
  const posting = getPosting(jobId);
  const job = getJob(jobId);
  if (!posting?.description_md.trim() || !job) return null;
  const latest = latestSnapshot(jobId);
  if (latest && latest.content_sha256 === sha256(posting.description_md)) return latest;
  return saveSnapshot(jobId, job.url ?? "manual", { method: "manual", description_md: posting.description_md });
}

// ---------- Codex runs ----------

export function createCodexRun(input: {
  job_id: number; task_id: number | null; attempt: number; purpose: string; work_dir: string; owner: string;
  plugin_ref: string | null; plugin_version: string | null; plugin_resource_hash: string | null;
  cli_version: string | null; model: string | null; engine?: string;
}): CodexRun {
  const res = getDb()
    .prepare(
      `INSERT INTO codex_runs (job_id, task_id, attempt, purpose, work_dir, owner, plugin_ref, plugin_version,
         plugin_resource_hash, cli_version, model, engine)
       VALUES (@job_id, @task_id, @attempt, @purpose, @work_dir, @owner, @plugin_ref, @plugin_version,
         @plugin_resource_hash, @cli_version, @model, @engine)`
    )
    .run({ ...input, engine: input.engine ?? "codex" });
  return getCodexRun(Number(res.lastInsertRowid))!;
}

export function getCodexRun(id: number): CodexRun | null {
  return (getDb().prepare("SELECT * FROM codex_runs WHERE id = ?").get(id) as CodexRun | undefined) ?? null;
}

const CODEX_RUN_FIELDS = [
  "pid", "proc_start", "session_id", "state", "outcome", "exit_code", "exit_signal", "blockers", "evidence",
  "usage", "event_count", "error", "finished_at",
] as const;

export function updateCodexRun(id: number, patch: Partial<Pick<CodexRun, (typeof CODEX_RUN_FIELDS)[number]>>): void {
  const keys = CODEX_RUN_FIELDS.filter((k) => patch[k] !== undefined);
  if (!keys.length) return;
  getDb()
    .prepare(`UPDATE codex_runs SET ${keys.map((k) => `${k} = @${k}`).join(", ")} WHERE id = @id`)
    .run({ ...Object.fromEntries(keys.map((k) => [k, patch[k]])), id });
}

/** Runs a worker may have left behind when it crashed. */
export function unfinishedCodexRuns(): CodexRun[] {
  return getDb().prepare("SELECT * FROM codex_runs WHERE state IN ('starting','running')").all() as CodexRun[];
}

// ---------- resume artifacts ----------

export function nextArtifactVersion(jobId: number): number {
  const row = getDb().prepare("SELECT COALESCE(MAX(version), 0) + 1 AS v FROM resume_artifacts WHERE job_id = ?").get(jobId) as { v: number };
  return row.v;
}

export function createArtifact(input: Omit<ResumeArtifact, "id" | "status" | "document_id" | "created_at">): ResumeArtifact {
  const db = getDb();
  const res = db
    .prepare(
      `INSERT INTO resume_artifacts (job_id, codex_run_id, snapshot_id, version, pdf_path, tex_path, report_path,
         pdf_sha256, tex_sha256, page_count, plugin_version, plugin_resource_hash, checks, summary, feedback, engine)
       VALUES (@job_id, @codex_run_id, @snapshot_id, @version, @pdf_path, @tex_path, @report_path,
         @pdf_sha256, @tex_sha256, @page_count, @plugin_version, @plugin_resource_hash, @checks, @summary, @feedback, @engine)`
    )
    .run(input);
  return getArtifact(Number(res.lastInsertRowid))!;
}

export function getArtifact(id: number): ResumeArtifact | null {
  return (getDb().prepare("SELECT * FROM resume_artifacts WHERE id = ?").get(id) as ResumeArtifact | undefined) ?? null;
}

export function listArtifacts(jobId: number): ResumeArtifact[] {
  return getDb().prepare("SELECT * FROM resume_artifacts WHERE job_id = ? ORDER BY version DESC").all(jobId) as ResumeArtifact[];
}

export function setArtifactStatus(id: number, status: ResumeArtifact["status"], documentId?: number | null): void {
  getDb()
    .prepare("UPDATE resume_artifacts SET status = ?, document_id = COALESCE(?, document_id) WHERE id = ?")
    .run(status, documentId ?? null, id);
}

// ---------- profile ----------

export function listProfile(): ProfileFact[] {
  return getDb().prepare("SELECT * FROM profile_facts ORDER BY key").all() as ProfileFact[];
}

export function getProfileMap(): Record<string, string> {
  return Object.fromEntries(listProfile().map((f) => [f.key, f.value]));
}

/** Saving through the editor is the user confirming the value. Blank deletes it. */
export function setProfileFacts(values: Record<string, string>): void {
  const db = getDb();
  db.transaction(() => {
    for (const [key, raw] of Object.entries(values)) {
      const value = raw.trim();
      if (!value) {
        db.prepare("DELETE FROM profile_facts WHERE key = ?").run(key);
        continue;
      }
      db.prepare(
        `INSERT INTO profile_facts (key, value, verified_at, updated_at)
         VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value, updated_at = excluded.updated_at,
           verified_at = CASE WHEN profile_facts.value = excluded.value THEN profile_facts.verified_at ELSE excluded.verified_at END`
      ).run(key, value);
    }
  })();
}

// ---------- queue views ----------

export function listQueue(): QueueRow[] {
  return getDb()
    .prepare(
      `SELECT j.id AS job_id, j.company, j.title, j.url, j.ats, j.workflow_state, j.workflow_detail, j.paused, j.created_at,
         t.id AS task_id, t.step AS task_step, t.state AS task_state, t.attempts, t.max_attempts, t.last_error, t.run_after,
         a.id AS latest_artifact_id, a.status AS latest_artifact_status, a.engine AS latest_artifact_engine,
         EXISTS (SELECT 1 FROM job_snapshots s WHERE s.job_id = j.id) AS has_snapshot
       FROM jobs j
       LEFT JOIN tasks t ON t.id = (SELECT MAX(id) FROM tasks WHERE job_id = j.id)
       LEFT JOIN resume_artifacts a ON a.id = (SELECT MAX(id) FROM resume_artifacts WHERE job_id = j.id)
       WHERE j.workflow_state IS NOT NULL
       ORDER BY j.created_at DESC, j.id DESC`
    )
    .all() as QueueRow[];
}

export interface JobAutomationDetail {
  events: WorkflowEvent[];
  tasks: Task[];
  snapshots: Pick<JobSnapshot, "id" | "method" | "final_url" | "application_url" | "captured_at" | "content_sha256">[];
  runs: CodexRun[];
  artifacts: ResumeArtifact[];
  fields: ApplicationField[];
  /** The saved posting text (what resumes and drafts are tailored from). */
  description: { markdown: string; captured_at: string | null; source: string | null } | null;
  /** Whether this job's ATS has a form adapter. */
  can_prepare: boolean;
}

export function jobAutomationDetail(jobId: number): JobAutomationDetail {
  const db = getDb();
  return {
    events: db.prepare("SELECT * FROM workflow_events WHERE job_id = ? ORDER BY id DESC LIMIT 100").all(jobId) as WorkflowEvent[],
    tasks: db.prepare("SELECT * FROM tasks WHERE job_id = ? ORDER BY id DESC").all(jobId) as Task[],
    snapshots: db
      .prepare("SELECT id, method, final_url, application_url, captured_at, content_sha256 FROM job_snapshots WHERE job_id = ? ORDER BY id DESC")
      .all(jobId) as JobAutomationDetail["snapshots"],
    runs: db.prepare("SELECT * FROM codex_runs WHERE job_id = ? ORDER BY id DESC LIMIT 20").all(jobId) as CodexRun[],
    artifacts: listArtifacts(jobId),
    fields: listApplicationFields(jobId),
    description: (() => {
      const snap = latestSnapshot(jobId);
      if (snap) return { markdown: snap.description_md, captured_at: snap.captured_at, source: snap.final_url ?? snap.source_url };
      const posting = getPosting(jobId);
      return posting?.description_md ? { markdown: posting.description_md, captured_at: posting.fetched_at, source: null } : null;
    })(),
    can_prepare: ["greenhouse", "lever", "ashby"].includes(
      ((db.prepare("SELECT ats FROM jobs WHERE id = ?").get(jobId) as { ats: string | null } | undefined)?.ats) ?? ""
    ),
  };
}

// ---------- settings ----------

export function getSetting(key: string): string | null {
  return (getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
    )
    .run(key, value);
}

/** Engine for new resume runs: the Queue page toggle, else RESUME_ENGINE, else Codex. */
export function defaultResumeEngine(): ResumeEngineName {
  const v = getSetting("resume_engine") ?? process.env.RESUME_ENGINE;
  return v === "claude" ? "claude" : "codex";
}

// ---------- application form fields ----------

export interface FieldRow {
  field_key: string;
  label: string;
  kind: string;
  required: boolean;
  options: string[];
  category: string;
  answer: string | null;
  answer_source: string | null;
  status: string;
  note: string | null;
  readback: string | null;
  max_length?: number | null;
}

/** Replaces the job's field list with the latest scan/fill report. */
export function saveApplicationFields(jobId: number, rows: FieldRow[]): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare("DELETE FROM application_fields WHERE job_id = ?").run(jobId);
    const ins = db.prepare(
      `INSERT OR REPLACE INTO application_fields
         (job_id, field_key, label, kind, required, options, category, answer, answer_source, status, note, readback, position, max_length)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    rows.forEach((r, i) =>
      ins.run(
        jobId, r.field_key, r.label, r.kind, r.required ? 1 : 0, JSON.stringify(r.options), r.category,
        // File answers are local paths; keep only the file name.
        r.kind === "file" && r.answer ? r.answer.split("/").pop()! : r.answer,
        r.answer_source, r.status, r.note, r.readback, i, r.max_length ?? null
      )
    );
  })();
}

export function listApplicationFields(jobId: number): ApplicationField[] {
  return getDb().prepare("SELECT * FROM application_fields WHERE job_id = ? ORDER BY position").all(jobId) as ApplicationField[];
}

/** The approved resume for a job (latest approval wins). */
export function approvedArtifact(jobId: number): ResumeArtifact | null {
  return (getDb()
    .prepare("SELECT * FROM resume_artifacts WHERE job_id = ? AND status = 'approved' ORDER BY id DESC LIMIT 1")
    .get(jobId) as ResumeArtifact | undefined) ?? null;
}

// ---------- submission ----------

/**
 * Records that the person submitted the application: workflow → submitted,
 * and an "applied" entry in the recruiting timeline (unless the latest one
 * already is). Idempotent, so a watcher and a button can't double-log.
 */
export function markSubmitted(jobId: number, evidence: { how: "confirmation_page" | "manual"; detail: string; receipt?: string | null }): boolean {
  const db = getDb();
  return db.transaction(() => {
    const row = db.prepare("SELECT workflow_state FROM jobs WHERE id = ?").get(jobId) as { workflow_state: string | null } | undefined;
    if (!row || row.workflow_state === "submitted") return false;
    const now = new Date().toISOString();
    db.prepare("UPDATE jobs SET workflow_state = 'submitted', submitted_at = ?, workflow_detail = ? WHERE id = ?").run(
      now,
      evidence.how === "manual" ? "Marked submitted by you" : `Submitted; the site confirmed it${evidence.receipt ? " (receipt screenshot saved)" : ""}`,
      jobId
    );
    const latest = db.prepare("SELECT status FROM status_events WHERE job_id = ? ORDER BY occurred_at DESC, id DESC LIMIT 1").get(jobId) as { status: string } | undefined;
    if (latest?.status !== "applied") createEvent({ job_id: jobId, status: "applied", occurred_at: now });
    db.prepare("INSERT INTO workflow_events (job_id, type, message) VALUES (?, ?, ?)").run(
      jobId, `submission:${evidence.how}`, [evidence.detail, evidence.receipt ? `receipt: ${evidence.receipt}` : ""].filter(Boolean).join(" | ").slice(0, 2000)
    );
    return true;
  }).immediate();
}
