import { getDb } from "./db";
import type {
  AppDocument, DocumentKind, DocumentWithUsage, Job, JobWithStatus, Posting, Recording, Status, StatusEvent,
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
  const res = getDb()
    .prepare("INSERT INTO jobs (company, title, url, notes) VALUES (?, ?, ?, ?)")
    .run(input.company, input.title, input.url ?? null, input.notes ?? "");
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
  pre_notes?: string;
  post_notes?: string;
  occurred_at?: string | null;
}): StatusEvent {
  const res = getDb()
    .prepare(
      `INSERT INTO status_events (job_id, status, interview_round, oa_score, pre_notes, post_notes, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ','now')))`
    )
    .run(
      input.job_id, input.status, input.interview_round ?? null, input.oa_score ?? null,
      input.pre_notes ?? "", input.post_notes ?? "", input.occurred_at ?? null
    );
  return getEvent(Number(res.lastInsertRowid))!;
}

export function updateEvent(
  id: number,
  input: Partial<Pick<StatusEvent, "status" | "interview_round" | "oa_score" | "pre_notes" | "post_notes" | "occurred_at">>
): StatusEvent | null {
  const ev = getEvent(id);
  if (!ev) return null;
  getDb()
    .prepare(
      `UPDATE status_events SET status = ?, interview_round = ?, oa_score = ?, pre_notes = ?, post_notes = ?, occurred_at = ?
       WHERE id = ?`
    )
    .run(
      input.status ?? ev.status,
      input.interview_round !== undefined ? input.interview_round : ev.interview_round,
      input.oa_score !== undefined ? input.oa_score : ev.oa_score,
      input.pre_notes ?? ev.pre_notes,
      input.post_notes ?? ev.post_notes,
      input.occurred_at ?? ev.occurred_at,
      id
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

export function createDocument(kind: DocumentKind, name: string, filePath: string): AppDocument {
  const res = getDb()
    .prepare("INSERT INTO documents (kind, name, file_path) VALUES (?, ?, ?)")
    .run(kind, name, filePath);
  return getDocument(Number(res.lastInsertRowid))!;
}

export function renameDocument(id: number, name: string): AppDocument | null {
  getDb().prepare("UPDATE documents SET name = ? WHERE id = ?").run(name, id);
  return getDocument(id);
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
