import { Readability } from "@mozilla/readability";
import { JSDOM, VirtualConsole } from "jsdom";
import TurndownService from "turndown";
import { safeFetch, type SafeResponse } from "./netguard";

export interface ParsedPosting {
  title: string | null;
  company: string | null;
  location: string | null;
  description_md: string;
  /** Extra JobPosting fields, when the page publishes them. */
  employment_type?: string | null;
  posting_id?: string | null;
  /** ISO date after which the employer says the posting closes. */
  valid_through?: string | null;
}

const turndown = new TurndownService({ headingStyle: "atx", bulletListMarker: "-" });

export function htmlToMarkdown(html: string): string {
  return turndown.turndown(html).trim();
}

// ---------- JSON-LD JobPosting pass ----------

type JsonLdNode = Record<string, unknown>;

/** Recursively find a JobPosting node inside a JSON-LD document (handles @graph, arrays). */
function findJobPosting(node: unknown): JsonLdNode | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findJobPosting(item);
      if (found) return found;
    }
    return null;
  }
  if (node && typeof node === "object") {
    const obj = node as JsonLdNode;
    const type = obj["@type"];
    if (type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"))) return obj;
    if (obj["@graph"]) return findJobPosting(obj["@graph"]);
  }
  return null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function extractLocation(posting: JsonLdNode): string | null {
  const loc = posting.jobLocation;
  const first = Array.isArray(loc) ? loc[0] : loc;
  if (first && typeof first === "object") {
    const address = (first as JsonLdNode).address;
    if (address && typeof address === "object") {
      const a = address as JsonLdNode;
      const parts = [str(a.addressLocality), str(a.addressRegion), str(a.addressCountry)].filter(Boolean);
      if (parts.length) return parts.join(", ");
    }
    const name = str((first as JsonLdNode).name);
    if (name) return name;
  }
  return str(posting.jobLocationType);
}

function fromJsonLd(doc: Document): ParsedPosting | null {
  for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(script.textContent ?? "");
    } catch {
      continue;
    }
    const posting = findJobPosting(parsed);
    if (!posting) continue;

    const description = str(posting.description);
    const org = posting.hiringOrganization;
    const company =
      org && typeof org === "object" ? str((org as JsonLdNode).name) : str(org);

    return {
      title: decoded(str(posting.title)),
      company: decoded(company),
      location: decoded(extractLocation(posting)),
      description_md: description ? htmlToMarkdown(description) : "",
      employment_type: Array.isArray(posting.employmentType)
        ? posting.employmentType.filter((t) => typeof t === "string").join(", ") || null
        : str(posting.employmentType),
      posting_id:
        posting.identifier && typeof posting.identifier === "object"
          ? str((posting.identifier as JsonLdNode).value) ?? (typeof (posting.identifier as JsonLdNode).value === "number" ? String((posting.identifier as JsonLdNode).value) : null)
          : str(posting.identifier),
      valid_through: str(posting.validThrough),
    };
  }
  return null;
}

/** Some sites double-escape text in JSON-LD ("AT&amp;T"); decode it once. */
function decoded(v: string | null): string | null {
  if (!v || !/&(#\d+|#x[\da-f]+|[a-z]+);/i.test(v)) return v;
  const doc = new JSDOM("<!doctype html><textarea></textarea>").window.document;
  const el = doc.querySelector("textarea")!;
  el.innerHTML = v;
  return el.value.trim() || v;
}

// ---------- Workday ----------
//
// Workday's job pages are built by JavaScript. Most tenants also put the posting
// in the page as JSON-LD, but not all, so its own JSON API (what the page's
// script calls) is asked first. It also says when a posting is closed.

/** The Workday JSON API address for a posting link, or null if it isn't one. */
export function workdayApiUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const segs = u.pathname.split("/").filter(Boolean);
  const job = segs.indexOf("job");
  if (job < 1 || job + 2 > segs.length) return null;
  let tenant: string | null = null;
  if (host.endsWith(".myworkdayjobs.com")) tenant = host.split(".")[0];
  // wd1.myworkdaysite.com/{locale?}/recruiting/{tenant}/{site}/job/…
  else if (host.endsWith(".myworkdaysite.com") || host === "myworkdaysite.com") {
    const r = segs.indexOf("recruiting");
    tenant = r >= 0 && r + 1 < job ? segs[r + 1] : null;
  }
  if (!tenant) return null;
  const site = segs[job - 1];
  // Apply links (…/job/<location>/<title>_<id>/apply/…) point at the same posting.
  const end = segs.indexOf("apply", job);
  const path = segs.slice(job, end > job ? end : undefined);
  return `https://${host}/wday/cxs/${tenant}/${site}/${path.join("/")}`;
}

type WorkdayResult = { posting: ParsedPosting } | { closed: true } | { failed: string };

async function fromWorkdayApi(api: string, fetcher: Fetcher): Promise<WorkdayResult> {
  let res: SafeResponse;
  try {
    res = await fetcher(api, "application/json");
  } catch (err) {
    return { failed: err instanceof Error ? err.message : String(err) };
  }
  let body: Record<string, unknown> | null = null;
  try {
    body = JSON.parse(res.body);
  } catch {
    body = null;
  }
  // A closed or unlisted posting: 404, or Workday's own "permission denied" (S22).
  if (res.status === 404 || (res.status === 403 && body?.errorCode === "S22")) return { closed: true };
  if (!res.ok || !body) return { failed: `Workday API HTTP ${res.status}${body ? "" : res.body.trimStart().startsWith("<") ? " (an HTML page, not data: probably a bot check)" : ""}` };
  const info = (body.jobPostingInfo ?? {}) as Record<string, unknown>;
  if (info.canApply === false) return { closed: true };
  const html = str(info.jobDescription);
  if (!html) return { failed: "Workday API returned no description" };
  const org = (body.hiringOrganization ?? {}) as Record<string, unknown>;
  return {
    posting: {
      title: decoded(str(info.title)),
      company: decoded(str(org.name)),
      location: decoded(str(info.location)),
      description_md: htmlToMarkdown(html),
      employment_type: str(info.timeType),
      posting_id: str(info.jobReqId),
      valid_through: str(info.endDate),
    },
  };
}

// ---------- Readability fallback ----------

function fromReadability(dom: JSDOM): ParsedPosting | null {
  const article = new Readability(dom.window.document.cloneNode(true) as Document).parse();
  if (!article?.content) return null;
  return {
    title: article.title?.trim() || null,
    company: article.siteName?.trim() || null,
    location: null,
    description_md: htmlToMarkdown(article.content),
  };
}

// ---------- entry point ----------

/** JSON-LD first, Readability fallback. Also used by the automation extractor. */
export function parsePostingHtml(html: string, url: string): ParsedPosting | null {
  // Silence jsdom's noisy CSS-parse errors from real-world pages.
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(html, { url, virtualConsole });
  return fromJsonLd(dom.window.document) ?? fromReadability(dom);
}

/** Fetches a URL (GET); swappable in tests. safeFetch refuses private/local hosts at every redirect hop. */
export type Fetcher = (url: string, accept?: string) => Promise<SafeResponse>;
const defaultFetcher: Fetcher = (url, accept) => safeFetch(url, accept ? { accept } : {});

export async function parsePostingUrl(url: string, fetcher: Fetcher = defaultFetcher): Promise<ParsedPosting> {
  const api = workdayApiUrl(url);
  const workday = api ? await fromWorkdayApi(api, fetcher) : null;
  if (workday && "posting" in workday) return workday.posting;

  const res = await fetcher(url);
  const result = res.ok ? parsePostingHtml(res.body, res.finalUrl) : null;
  if (result?.description_md) return result;

  if (workday && "closed" in workday) {
    throw new Error("This Workday posting is closed or no longer public. If you still need it, paste the description with Edit manually.");
  }
  const why = [
    workday && "failed" in workday ? workday.failed : null,
    res.ok ? null : `page HTTP ${res.status}`,
  ].filter(Boolean).join("; ");
  if (!res.ok && !workday) throw new Error(`Fetch failed: HTTP ${res.status}`);
  throw new Error(`Could not extract posting content${why ? ` (${why})` : ""}`);
}
