import { getDb } from "./db";
import { analyzeUrl } from "./urls";

/**
 * Duplicate detection for new applications.
 *
 *  - Same posting: the link's posting identity (urls.ts: the ATS's own posting ID,
 *    else the link without tracking params) matches a tracked job's posting_key.
 *    That's the same job; adding it again needs an explicit "add anyway".
 *  - Similar: same company and title (ignoring case, punctuation and "Inc"/"LLC"…)
 *    under a different link. Often a separate posting (another location or req),
 *    so it's only a heads-up.
 */

export interface JobRef {
  id: number;
  company: string;
  title: string;
  url: string | null;
}

/** The posting identity jobs.posting_key/ats/ats_tenant/posting_id hold for a link (all null without one). */
export function postingIdentity(url: string | null | undefined) {
  const info = url ? analyzeUrl(url) : null;
  return info?.ok
    ? { posting_key: info.key, ats: info.ats, ats_tenant: info.tenant, posting_id: info.postingId }
    : { posting_key: null, ats: null, ats_tenant: null, posting_id: null };
}

const LEGAL = /\b(inc|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|plc|gmbh|sa|ag|careers?|jobs)\b/g;
export const normCompany = (s: string) => s.toLowerCase().replace(/&amp;/g, "&").replace(LEGAL, " ").replace(/[^a-z0-9]+/g, " ").trim();
export const normTitle = (s: string) => s.toLowerCase().replace(/&amp;/g, "&").replace(/[^a-z0-9]+/g, " ").trim();

export function findDuplicates(input: { url?: string | null; company?: string | null; title?: string | null; excludeId?: number }): {
  same_posting: JobRef | null;
  similar: JobRef[];
} {
  const db = getDb();
  const exclude = input.excludeId ?? 0;
  const key = postingIdentity(input.url).posting_key;
  const same = key
    ? ((db.prepare("SELECT id, company, title, url FROM jobs WHERE posting_key = ? AND id <> ? ORDER BY id LIMIT 1").get(key, exclude) as JobRef | undefined) ?? null)
    : null;
  let similar: JobRef[] = [];
  const company = input.company?.trim() ? normCompany(input.company) : "";
  const title = input.title?.trim() ? normTitle(input.title) : "";
  if (company && title) {
    similar = (db.prepare("SELECT id, company, title, url FROM jobs WHERE id <> ? ORDER BY id DESC").all(exclude) as JobRef[])
      .filter((j) => j.id !== same?.id && normCompany(j.company) === company && normTitle(j.title) === title)
      .slice(0, 5);
  }
  return { same_posting: same, similar };
}
