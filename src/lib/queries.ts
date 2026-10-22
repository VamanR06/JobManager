import { getDb } from "./db";
import { postingIdentity } from "./duplicates";
import type {
  AppDocument, DocumentKind, DocumentWithUsage, Job, JobWithStatus,
  Posting, Recording, Status, StatusEvent,
} from "./types";

// ---------- jobs ----------

export function listJobs(): JobWithStatus[] {
  const db = getDb();
  const jobs = db.prepare("SELECT * FROM jobs ORDER BY created_at DESC, id DESC").all() as Job[];
  const latestStmt = db.prepare(
    "SELECT * FROM status_events WHERE job_id = ? ORDER BY occurred_at DESC, id DESC LIMIT 1"
  );
  return jobs.map((job) => {
    const latest = (latestStmt.get(job.id) as StatusEvent | undefined) ?? null;
    return { ...job, latest_event: latest, pending_after: pendingAfter(latest) };
  });
}

export function getJob(id: number): Job | null {
  return (getDb().prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Job | undefined) ?? null;
}

export function createJob(input: { company: string; title: string; url?: string | null; notes?: string }): Job {
  // The posting identity is stored with the job so later duplicate checks can find it (duplicates.ts).
  const id = postingIdentity(input.url);
  const res = getDb()
    .prepare("INSERT INTO jobs (company, title, url, notes, posting_key, ats, ats_tenant, posting_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(input.company, input.title, input.url ?? null, input.notes ?? "", id.posting_key, id.ats, id.ats_tenant, id.posting_id);
  return getJob(Number(res.lastInsertRowid))!;
}

export function updateJob(
  id: number,
  input: Partial<Pick<Job, "company" | "title" | "url" | "notes" | "resume_id" | "cover_letter_id">>
): Job | null {
  const job = getJob(id);
  if (!job) return null;
  getDb()
    .prepare(
      "UPDATE jobs SET company = ?, title = ?, url = ?, notes = ?, resume_id = ?, cover_letter_id = ? WHERE id = ?"
    )
    .run(
      input.company ?? job.company,
      input.title ?? job.title,
      input.url !== undefined ? input.url : job.url,
      input.notes ?? job.notes,
      input.resume_id !== undefined ? input.resume_id : job.resume_id,
      input.cover_letter_id !== undefined ? input.cover_letter_id : job.cover_letter_id,
      id
    );
  // A new link means a new posting identity (left alone otherwise).
  if (input.url !== undefined && (input.url ?? null) !== job.url) {
    const p = postingIdentity(input.url);
    getDb()
      .prepare("UPDATE jobs SET posting_key = ?, ats = ?, ats_tenant = ?, posting_id = ? WHERE id = ?")
      .run(p.posting_key, p.ats, p.ats_tenant, p.posting_id, id);
  }
  return getJob(id);
}

export function deleteJob(id: number): void {
  getDb().prepare("DELETE FROM jobs WHERE id = ?").run(id);
}

// ---------- status events ----------

export function listEvents(jobId: number): StatusEvent[] {
  return getDb()
    .prepare("SELECT * FROM status_events WHERE job_id = ? ORDER BY occurred_at DESC, id DESC")
    .all(jobId) as StatusEvent[];
}

export function getEvent(id: number): StatusEvent | null {
  return (getDb().prepare("SELECT * FROM status_events WHERE id = ?").get(id) as StatusEvent | undefined) ?? null;
}

/** For a pending event, the most recent prior non-pending event it is waiting on. */
export function pendingAfter(event: StatusEvent | null): StatusEvent | null {
  if (!event || event.status !== "pending") return null;
  return (
    (getDb()
      .prepare(
        `SELECT * FROM status_events
         WHERE job_id = ? AND status != 'pending' AND (occurred_at < ? OR (occurred_at = ? AND id < ?))
         ORDER BY occurred_at DESC, id DESC LIMIT 1`
      )
      .get(event.job_id, event.occurred_at, event.occurred_at, event.id) as StatusEvent | undefined) ?? null
  );
}

export function createEvent(input: {
  job_id: number;
  status: Status;
  interview_round?: number | null;
  oa_score?: string | null;
  oa_sent_at?: string | null;
  oa_submitted_at?: string | null;
  oa_deadline_at?: string | null;
  oa_link?: string | null;
  interview_offered_at?: string | null;
  interview_held_at?: string | null;
  interview_link?: string | null;
  pre_notes?: string;
  post_notes?: string;
  occurred_at?: string | null;
}): StatusEvent {
  const res = getDb()
    .prepare(
      `INSERT INTO status_events
         (job_id, status, interview_round, oa_score, oa_sent_at, oa_submitted_at, oa_deadline_at, oa_link,
          interview_offered_at, interview_held_at, interview_link, pre_notes, post_notes, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ','now')))`
    )
    .run(
      input.job_id, input.status, input.interview_round ?? null, input.oa_score ?? null,
      input.oa_sent_at ?? null, input.oa_submitted_at ?? null, input.oa_deadline_at ?? null, input.oa_link ?? null,
      input.interview_offered_at ?? null, input.interview_held_at ?? null, input.interview_link ?? null,
      input.pre_notes ?? "", input.post_notes ?? "", input.occurred_at ?? null
    );
  return getEvent(Number(res.lastInsertRowid))!;
}

const EVENT_UPDATE_FIELDS = [
  "status", "interview_round", "oa_score", "oa_sent_at", "oa_submitted_at", "oa_deadline_at", "oa_link",
  "interview_offered_at", "interview_held_at", "interview_link", "pre_notes", "post_notes", "occurred_at",
] as const;

export function updateEvent(
  id: number,
  input: Partial<Pick<StatusEvent, (typeof EVENT_UPDATE_FIELDS)[number]>>
): StatusEvent | null {
  const ev = getEvent(id);
  if (!ev) return null;
  // Only overwrite fields the caller explicitly provided; leave the rest untouched.
  const merged = { ...ev, ...Object.fromEntries(
    EVENT_UPDATE_FIELDS.filter((f) => input[f] !== undefined).map((f) => [f, input[f]])
  ) };
  getDb()
    .prepare(
      `UPDATE status_events SET status = ?, interview_round = ?, oa_score = ?, oa_sent_at = ?,
         oa_submitted_at = ?, oa_deadline_at = ?, oa_link = ?,
         interview_offered_at = ?, interview_held_at = ?, interview_link = ?,
         pre_notes = ?, post_notes = ?, occurred_at = ? WHERE id = ?`
    )
    .run(
      merged.status, merged.interview_round, merged.oa_score, merged.oa_sent_at,
      merged.oa_submitted_at, merged.oa_deadline_at, merged.oa_link,
      merged.interview_offered_at, merged.interview_held_at, merged.interview_link,
      merged.pre_notes, merged.post_notes, merged.occurred_at, id
    );
  return getEvent(id);
}

export function deleteEvent(id: number): void {
  getDb().prepare("DELETE FROM status_events WHERE id = ?").run(id);
}

// ---------- recordings ----------

export function listRecordings(eventId: number): Recording[] {
  return getDb()
    .prepare("SELECT * FROM recordings WHERE status_event_id = ? ORDER BY started_at DESC, id DESC")
    .all(eventId) as Recording[];
}

export function getRecording(id: number): Recording | null {
  return (getDb().prepare("SELECT * FROM recordings WHERE id = ?").get(id) as Recording | undefined) ?? null;
}

export function createRecording(eventId: number, filePath: string): Recording {
  const res = getDb()
    .prepare("INSERT INTO recordings (status_event_id, file_path) VALUES (?, ?)")
    .run(eventId, filePath);
  return getRecording(Number(res.lastInsertRowid))!;
}

export function finishRecording(id: number, state: "done" | "failed"): Recording | null {
  getDb()
    .prepare(
      `UPDATE recordings SET state = ?, ended_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       duration_sec = (julianday('now') - julianday(started_at)) * 86400 WHERE id = ?`
    )
    .run(state, id);
  return getRecording(id);
}

export function deleteRecording(id: number): void {
  getDb().prepare("DELETE FROM recordings WHERE id = ?").run(id);
}

// ---------- documents (resumes / cover letters) ----------

export function listDocuments(kind: DocumentKind): DocumentWithUsage[] {
  const db = getDb();
  const docs = db
    .prepare("SELECT * FROM documents WHERE kind = ? ORDER BY uploaded_at DESC, id DESC")
    .all(kind) as AppDocument[];
  const linkCol = kind === "resume" ? "resume_id" : "cover_letter_id";
  const usageStmt = db.prepare(
    `SELECT id, company, title FROM jobs WHERE ${linkCol} = ? ORDER BY created_at DESC`
  );
  return docs.map((doc) => ({
    ...doc,
    used_by: usageStmt.all(doc.id) as DocumentWithUsage["used_by"],
  }));
}

export function getDocument(id: number): AppDocument | null {
  return (getDb().prepare("SELECT * FROM documents WHERE id = ?").get(id) as AppDocument | undefined) ?? null;
}

/** Next version number for a document name (1 if the name is new). */
function nextDocumentVersion(kind: DocumentKind, name: string): number {
  const row = getDb()
    .prepare("SELECT COALESCE(MAX(version), 0) + 1 AS v FROM documents WHERE kind = ? AND name = ?")
    .get(kind, name) as { v: number };
  return row.v;
}

/** An existing version of this name with byte-identical content, if any. */
export function findDocumentByContent(kind: DocumentKind, name: string, sha256: string): AppDocument | null {
  return (
    (getDb()
      .prepare("SELECT * FROM documents WHERE kind = ? AND name = ? AND content_sha256 = ? ORDER BY version DESC LIMIT 1")
      .get(kind, name, sha256) as AppDocument | undefined) ?? null
  );
}

/** Insert a document; reusing an existing name makes this the next version of it. */
export function createDocument(
  kind: DocumentKind,
  name: string,
  filePath: string,
  /** Set when the resume generator produced this file rather than an upload. */
  origin?: { generated: boolean; source_job_id: number | null; thread_id?: string | null },
  contentSha256: string | null = null
): AppDocument {
  const db = getDb();
  const insert = db.transaction(() =>
    db
      .prepare(
        `INSERT INTO documents (kind, name, file_path, generated, source_job_id, thread_id, version, content_sha256)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        kind, name, filePath, origin?.generated ? 1 : 0,
        origin?.source_job_id ?? null, origin?.thread_id ?? null,
        nextDocumentVersion(kind, name), contentSha256
      )
  );
  return getDocument(Number(insert().lastInsertRowid))!;
}

/**
 * Point a generated document at a new conversation after a revision.
 * The file itself is overwritten in place, so the path and name don't change.
 */

/** Renaming into another name's history makes this its newest version. */
export function renameDocument(id: number, name: string): AppDocument | null {
  const db = getDb();
  db.transaction(() => {
    const doc = getDocument(id);
    if (!doc || doc.name === name) return;
    db.prepare("UPDATE documents SET name = ?, version = ? WHERE id = ?").run(name, nextDocumentVersion(doc.kind, name), id);
  })();
  return getDocument(id);
}

export function setDocumentArchived(id: number, archived: boolean): AppDocument | null {
  getDb().prepare("UPDATE documents SET archived = ? WHERE id = ?").run(archived ? 1 : 0, id);
  return getDocument(id);
}

/** Jobs linked to this document (either slot). */
export function documentUsage(id: number): { id: number; company: string; title: string }[] {
  return getDb()
    .prepare("SELECT id, company, title FROM jobs WHERE resume_id = ? OR cover_letter_id = ?")
    .all(id, id) as { id: number; company: string; title: string }[];
}

export function deleteDocument(id: number): void {
  getDb().prepare("DELETE FROM documents WHERE id = ?").run(id);
}

// ---------- postings ----------

export function getPosting(jobId: number): Posting | null {
  return (getDb().prepare("SELECT * FROM postings WHERE job_id = ?").get(jobId) as Posting | undefined) ?? null;
}

export function upsertPosting(input: {
  job_id: number;
  title?: string | null;
  company?: string | null;
  location?: string | null;
  description_md: string;
  source: "parsed" | "manual";
  fetch_status: "ok" | "failed";
}): Posting {
  getDb()
    .prepare(
      `INSERT INTO postings (job_id, title, company, location, description_md, source, fetch_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(job_id) DO UPDATE SET
         title = excluded.title, company = excluded.company, location = excluded.location,
         description_md = excluded.description_md, source = excluded.source,
         fetch_status = excluded.fetch_status, fetched_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
    )
    .run(
      input.job_id, input.title ?? null, input.company ?? null, input.location ?? null,
      input.description_md, input.source, input.fetch_status
    );
  return getPosting(input.job_id)!;
}

