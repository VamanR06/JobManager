import { getDb } from "./db";
import { findDuplicates, type JobRef } from "./duplicates";
import { htmlToMarkdown } from "./parser";
import { createEvent, createJob, getJob, updateJob, upsertPosting } from "./queries";
import { analyzeUrl } from "./urls";

/**
 * Saving a posting that the person's own browser read (the "Save to JobManager"
 * bookmarklet → /save). For sites that refuse the server's network (Workday
 * does): the browser reads the page it already has open, on the person's
 * network, and hands the posting over. Nothing here fetches anything.
 */

export interface BrowserPosting {
  url: string;
  title?: string | null;
  company?: string | null;
  location?: string | null;
  /** The description as the page has it (HTML), or plain text. */
  description_html?: string | null;
  description_text?: string | null;
}

export type BrowserImportResult =
  | { outcome: "created" | "updated"; job_id: number }
  | { outcome: "duplicate"; same_posting: JobRef | null; similar: JobRef[] };

export class BrowserImportError extends Error {}

const clean = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

export function descriptionMarkdown(p: BrowserPosting): string {
  const html = clean(p.description_html, 400_000);
  const text = clean(p.description_text, 200_000);
  return (html ? htmlToMarkdown(html) : text ?? "").trim();
}

/**
 * Adds the posting as a new 'to apply' application, or (with jobId) fills in
 * an existing application's description. A new one goes through the same
 * duplicate checks as the Add form unless allowDuplicate.
 */
export function importFromBrowser(p: BrowserPosting, opts: { jobId?: number; allowDuplicate?: boolean } = {}): BrowserImportResult {
  const info = typeof p.url === "string" ? analyzeUrl(p.url) : null;
  if (!info?.ok) throw new BrowserImportError(info ? info.message : "The posting's link is missing");
  const description_md = descriptionMarkdown(p);
  if (description_md.length < 50) throw new BrowserImportError("The page didn't have a job description to save");
  const title = clean(p.title, 300);
  const company = clean(p.company, 200);
  const location = clean(p.location, 300);

  if (opts.jobId !== undefined) {
    const job = getJob(opts.jobId);
    if (!job) throw new BrowserImportError(`No application ${opts.jobId}`);
    upsertPosting({ job_id: job.id, title, company, location, description_md, source: "parsed", fetch_status: "ok" });
    if (!job.url) updateJob(job.id, { url: info.normalized });
    return { outcome: "updated", job_id: job.id };
  }

  if (!opts.allowDuplicate) {
    const d = findDuplicates({ url: info.normalized, company, title });
    if (d.same_posting || d.similar.length) return { outcome: "duplicate", ...d };
  }
  if (!company || !title) throw new BrowserImportError("The page didn't say the company and title; add them on the save page");
  return getDb().transaction((): BrowserImportResult => {
    const job = createJob({ company, title, url: info.normalized });
    upsertPosting({ job_id: job.id, title, company, location, description_md, source: "parsed", fetch_status: "ok" });
    createEvent({ job_id: job.id, status: "to_apply" });
    return { outcome: "created", job_id: job.id };
  }).immediate();
}
