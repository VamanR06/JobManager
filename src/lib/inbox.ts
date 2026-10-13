import { addUrlsManually, type ImportResult } from "./automation";
import type { ParsedPosting } from "./parser";
import { splitPastedUrls } from "./urls";

/**
 * Inbox for links shared from a phone (an iOS Shortcut in the share sheet).
 * Links are added to the applications list only, like the Add form; nothing is
 * queued for automation (start that from the job with "automate").
 * The token check lives in auth.ts so the proxy can use it without loading the DB.
 */

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
