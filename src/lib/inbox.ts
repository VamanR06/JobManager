import { getDb } from "./db";
import { parsePostingUrl, type ParsedPosting } from "./parser";
import { createEvent, createJob, upsertPosting } from "./queries";
import type { Job } from "./types";
import { analyzeUrl, splitPastedUrls } from "./urls";

/**
 * Inbox for links shared from a phone (an iOS Shortcut in the share sheet).
 * Links are added to the applications list, like the Add form.
 * The token check lives in auth.ts so the proxy can use it without loading the DB.
 */

function findByKey(key: string): Pick<Job, "id" | "company" | "title"> | null {
  return (
    (getDb().prepare("SELECT id, company, title FROM jobs WHERE posting_key = ? ORDER BY id LIMIT 1").get(key) as
      | Pick<Job, "id" | "company" | "title">
      | undefined) ?? null
  );
}

export function placeholderCompany(info: { tenant: string | null; normalized: string }): string {
  if (info.tenant) return info.tenant.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return new URL(info.normalized).hostname.replace(/^www\./, "");
}

export interface ImportResult {
  input: string;
  outcome: "created" | "duplicate" | "invalid" | "unsupported";
  job_id?: number;
  message?: string;
}

/** Title for a hand-added job whose posting page couldn't be read. */
export const UNKNOWN_TITLE = "(title unknown)";

/**
 * Adds links as hand-tracked applications, like the Add form: company, title and
 * description come from the posting page when it can be read (workflow_state
 * stays NULL).
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

/** Hosts whose share links are posts about a job, not the posting itself; their pages need a login to read. */
const SOCIAL_HOSTS = ["instagram.com", "threads.net", "threads.com", "facebook.com", "tiktok.com", "x.com", "twitter.com"];

function isSocialPost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return SOCIAL_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

/** Only the http(s) links in shared text (a caption, a message, or a bare URL). */
export function linksInText(text: string): string[] {
  return splitPastedUrls(text).filter((t) => /^https?:\/\//i.test(t));
}

export interface InboxResult {
  results: ImportResult[];
  /** One line for the Shortcut to show as a notification. */
  message: string;
}

/** Each link's page is fetched before replying, so a share is capped at a few. */
const MAX_LINKS = 10;

export async function importSharedText(text: string, parse?: (url: string) => Promise<ParsedPosting>): Promise<InboxResult> {
  const links = linksInText(text);
  if (!links.length) return { results: [], message: "No link found in what was shared" };

  const social = links.filter(isSocialPost);
  const jobLinks = links.filter((l) => !isSocialPost(l));
  const results: ImportResult[] = [
    ...(await addUrlsManually(jobLinks.slice(0, MAX_LINKS), parse)),
    ...social.map((input): ImportResult => ({
      input,
      outcome: "unsupported",
      message: "Social post, not a job page — share the job link from the post instead",
    })),
  ];
  return { results, message: summarize(results) };
}

function summarize(results: ImportResult[]): string {
  const created = results.filter((r) => r.outcome === "created");
  const dupes = results.filter((r) => r.outcome === "duplicate");
  const failed = results.filter((r) => r.outcome === "invalid" || r.outcome === "unsupported");
  const parts: string[] = [];
  if (created.length) parts.push(created.length === 1 ? `Added: ${created[0].message}` : `Added ${created.length} jobs`);
  if (dupes.length) parts.push(dupes.length === 1 ? `Already tracked: ${dupes[0].message}` : `${dupes.length} already tracked`);
  if (failed.length) parts.push(failed.length === 1 ? `Skipped: ${failed[0].message}` : `${failed.length} skipped`);
  return parts.join(" · ");
}
