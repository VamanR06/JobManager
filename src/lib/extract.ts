import { JSDOM } from "jsdom";
import { htmlToMarkdown, parsePostingHtml } from "./parser";
import { safeFetch, type SafeResponse } from "./netguard";
import { analyzeUrl } from "./urls";

/**
 * Posting extraction for the automation queue. Uses the ATS's public posting API
 * where one exists (reliable, no JavaScript needed, tells us when a posting is
 * closed), and generic HTML parsing otherwise.
 *
 * Everything returned here is untrusted page content: it is stored and shown,
 * and handed to Codex only as data in a file, never as instructions.
 */

export interface ExtractedPosting {
  title: string | null;
  company: string | null;
  location: string | null;
  employment_type: string | null;
  posting_id: string | null;
  description_md: string;
  /** The URL the content was served from after redirects. */
  final_url: string;
  canonical_url: string | null;
  application_url: string | null;
  method: "greenhouse_api" | "lever_api" | "ashby_api" | "workday_api" | "oracle_api" | "workable_api" | "html";
}

export type ExtractionFailure = "closed" | "incomplete" | "blocked" | "failed";

export class ExtractionError extends Error {
  constructor(public kind: ExtractionFailure, message: string) {
    super(message);
    this.name = "ExtractionError";
  }
}

export type Fetcher = (url: string, accept?: string, maxBytes?: number) => Promise<SafeResponse>;
const defaultFetcher: Fetcher = (url, accept, maxBytes) => safeFetch(url, { accept, maxBytes });

/** Shorter than this and it's a snippet or an error page, not a job description. */
export const MIN_DESCRIPTION_CHARS = 400;

const CLOSED_TEXT =
  /(no longer (accepting applications|available|open)|this (job|position|posting) (has been|is) (closed|filled|removed)|position has been filled|job (you are looking for|you're looking for) (is|was) (no longer|not)|page (you requested|you're looking for) (could not be found|doesn't exist))/i;
const BLOCKED_TEXT =
  /(enable javascript|verify (that )?you are (a )?human|captcha|access denied|are you a robot|checking your browser)/i;

function titleCase(slug: string): string {
  return slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Greenhouse's API returns HTML-escaped HTML; decode it once before converting. */
function decodeEntities(escaped: string): string {
  const { window } = new JSDOM("<!doctype html><textarea></textarea>");
  const el = window.document.querySelector("textarea")!;
  el.innerHTML = escaped;
  return el.value;
}

function json(res: SafeResponse): Record<string, unknown> {
  try {
    return JSON.parse(res.body);
  } catch {
    throw new ExtractionError("failed", "The job API returned invalid JSON");
  }
}

function s(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

async function greenhouse(tenant: string, id: string, fetcher: Fetcher, sourceUrl: string): Promise<ExtractedPosting | null> {
  const res = await fetcher(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(tenant)}/jobs/${id}`, "application/json");
  if (res.status === 404) return null;
  if (!res.ok) throw new ExtractionError("failed", `Greenhouse API returned HTTP ${res.status}`);
  const body = json(res);
  const content = s(body.content);
  const location = body.location && typeof body.location === "object" ? s((body.location as Record<string, unknown>).name) : null;
  const absolute = s(body.absolute_url);
  return {
    title: s(body.title),
    company: s(body.company_name) ?? titleCase(tenant),
    location,
    employment_type: null,
    posting_id: id,
    description_md: content ? htmlToMarkdown(decodeEntities(content)) : "",
    final_url: absolute ?? sourceUrl,
    canonical_url: absolute,
    application_url: absolute,
    method: "greenhouse_api",
  };
}

async function lever(tenant: string, id: string, eu: boolean, fetcher: Fetcher): Promise<ExtractedPosting | null> {
  const api = eu ? "https://api.eu.lever.co" : "https://api.lever.co";
  const res = await fetcher(`${api}/v0/postings/${encodeURIComponent(tenant)}/${id}`, "application/json");
  if (res.status === 404) return null;
  if (!res.ok) throw new ExtractionError("failed", `Lever API returned HTTP ${res.status}`);
  const body = json(res);
  const cats = (body.categories ?? {}) as Record<string, unknown>;
  // Lever splits the description into an intro, titled lists, and a closing block.
  const parts: string[] = [];
  if (s(body.description)) parts.push(s(body.description)!);
  for (const list of (Array.isArray(body.lists) ? body.lists : []) as Record<string, unknown>[]) {
    parts.push(`<h3>${s(list.text) ?? ""}</h3><ul>${s(list.content) ?? ""}</ul>`);
  }
  if (s(body.additional)) parts.push(s(body.additional)!);
  return {
    title: s(body.text),
    company: titleCase(tenant),
    location: s(cats.location),
    employment_type: s(cats.commitment),
    posting_id: id,
    description_md: htmlToMarkdown(parts.join("\n")),
    final_url: s(body.hostedUrl) ?? `https://jobs.lever.co/${tenant}/${id}`,
    canonical_url: s(body.hostedUrl),
    application_url: s(body.applyUrl),
    method: "lever_api",
  };
}

async function ashby(tenant: string, id: string, fetcher: Fetcher): Promise<ExtractedPosting | null> {
  // The board endpoint returns every posting with full descriptions; big employers exceed the default cap.
  const res = await fetcher(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(tenant)}`, "application/json", 50 * 1024 * 1024);
  if (res.status === 404) return null;
  if (!res.ok) throw new ExtractionError("failed", `Ashby API returned HTTP ${res.status}`);
  const jobs = (json(res).jobs ?? []) as Record<string, unknown>[];
  const job = jobs.find((j) => typeof j.id === "string" && j.id.toLowerCase() === id);
  if (!job) return null;
  return {
    title: s(job.title),
    company: titleCase(tenant),
    location: s(job.location),
    employment_type: s(job.employmentType),
    posting_id: id,
    description_md: s(job.descriptionHtml) ? htmlToMarkdown(s(job.descriptionHtml)!) : s(job.descriptionPlain) ?? "",
    final_url: s(job.jobUrl) ?? `https://jobs.ashbyhq.com/${tenant}/${id}`,
    canonical_url: s(job.jobUrl),
    application_url: s(job.applyUrl),
    method: "ashby_api",
  };
}

async function workday(u: URL, fetcher: Fetcher): Promise<ExtractedPosting | null> {
  // /{locale?}/{site}/job/{...} → /wday/cxs/{tenant}/{site}/job/{...}
  const segs = u.pathname.split("/").filter(Boolean);
  const jobIdx = segs.indexOf("job");
  if (jobIdx < 1) return null;
  const site = segs[jobIdx - 1];
  const tenant = u.hostname.split(".")[0];
  const api = `https://${u.hostname}/wday/cxs/${tenant}/${site}/${segs.slice(jobIdx).join("/")}`;
  const res = await fetcher(api, "application/json");
  if (res.status === 404) return null;
  if (!res.ok) throw new ExtractionError("failed", `Workday API returned HTTP ${res.status}`);
  const body = json(res);
  const info = (body.jobPostingInfo ?? {}) as Record<string, unknown>;
  if (info.canApply === false) return null;
  const org = (body.hiringOrganization ?? {}) as Record<string, unknown>;
  const external = s(info.externalUrl);
  return {
    title: s(info.title),
    company: s(org.name) ?? titleCase(tenant),
    location: s(info.location),
    employment_type: s(info.timeType),
    posting_id: s(info.jobReqId),
    description_md: s(info.jobDescription) ? htmlToMarkdown(s(info.jobDescription)!) : "",
    final_url: external ?? u.toString(),
    canonical_url: external,
    application_url: external ? `${external.replace(/\/$/, "")}/apply` : null,
    method: "workday_api",
  };
}

/** Oracle Recruiting Cloud's candidate-experience REST resource (what its career site's JS calls). */
async function oracle(u: URL, id: string, fetcher: Fetcher): Promise<ExtractedPosting | null> {
  const segs = u.pathname.split("/").filter(Boolean);
  const site = segs[segs.indexOf("sites") + 1];
  if (!site) return null;
  const finder = encodeURIComponent(`ById;Id="${id}",siteNumber=${site}`);
  const res = await fetcher(
    `https://${u.hostname}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=${finder}`,
    "application/json"
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new ExtractionError("failed", `Oracle API returned HTTP ${res.status}`);
  const item = ((json(res).items ?? []) as Record<string, unknown>[])[0];
  if (!item) return null;
  const html = ["ExternalDescriptionStr", "ExternalResponsibilitiesStr", "ExternalQualificationsStr", "CorporateDescriptionStr"]
    .map((k) => s(item[k]))
    .filter(Boolean)
    .join("\n");
  const canonical = `https://${u.hostname}/hcmUI/CandidateExperience/en/sites/${site}/job/${id}`;
  return {
    title: s(item.Title),
    company: null, // not exposed by this resource; the import placeholder stays until edited
    location: s(item.PrimaryLocation),
    employment_type: s(item.JobSchedule),
    posting_id: id,
    description_md: html ? htmlToMarkdown(html) : "",
    final_url: canonical,
    canonical_url: canonical,
    application_url: `${canonical}/apply`,
    method: "oracle_api",
  };
}

/** Workable's public job and account endpoints (what apply.workable.com's JS calls). */
async function workable(account: string, code: string, fetcher: Fetcher): Promise<ExtractedPosting | null> {
  const res = await fetcher(`https://apply.workable.com/api/v2/accounts/${encodeURIComponent(account)}/jobs/${code}`, "application/json");
  if (res.status === 404) return null;
  if (!res.ok) throw new ExtractionError("failed", `Workable API returned HTTP ${res.status}`);
  const job = json(res);
  if (s(job.state) && job.state !== "published") return null;
  let company: string | null = null;
  try {
    const acct = await fetcher(`https://apply.workable.com/api/v1/accounts/${encodeURIComponent(account)}`, "application/json");
    if (acct.ok) company = s(json(acct).name);
  } catch {
    // name is optional
  }
  const loc = (job.location ?? {}) as Record<string, unknown>;
  const html = [
    s(job.description),
    s(job.requirements) ? `<h3>Requirements</h3>${s(job.requirements)}` : null,
    s(job.benefits) ? `<h3>Benefits</h3>${s(job.benefits)}` : null,
  ].filter(Boolean).join("\n");
  const url = `https://apply.workable.com/${account}/j/${code}/`;
  return {
    title: s(job.title),
    company: company ?? titleCase(account),
    location: [s(loc.city), s(loc.region), s(loc.country)].filter(Boolean).join(", ") || null,
    employment_type: s(job.type),
    posting_id: code,
    description_md: html ? htmlToMarkdown(html) : "",
    final_url: url,
    canonical_url: url,
    application_url: `${url}apply/`,
    method: "workable_api",
  };
}

async function generic(url: string, fetcher: Fetcher): Promise<ExtractedPosting> {
  const res = await fetcher(url);
  if (res.status === 404 || res.status === 410) throw new ExtractionError("closed", `Posting page returned HTTP ${res.status}`);
  if (res.status === 403 || res.status === 429) {
    throw new ExtractionError("blocked", `The site refused automated access (HTTP ${res.status}). Paste the description manually.`);
  }
  if (!res.ok) throw new ExtractionError("failed", `Fetch failed: HTTP ${res.status}`);

  const parsed = parsePostingHtml(res.body, res.finalUrl);
  if (parsed?.valid_through && Date.parse(parsed.valid_through) < Date.now()) {
    throw new ExtractionError("closed", `Posting closed on ${parsed.valid_through.slice(0, 10)}`);
  }
  const text = parsed?.description_md ?? "";
  if (text.length < MIN_DESCRIPTION_CHARS && CLOSED_TEXT.test(res.body)) {
    throw new ExtractionError("closed", "The page says this posting is closed");
  }
  if (text.length < MIN_DESCRIPTION_CHARS && BLOCKED_TEXT.test(res.body)) {
    throw new ExtractionError("blocked", "The page needs JavaScript or a human check. Paste the description manually.");
  }
  const { window } = new JSDOM(res.body);
  const canonical = window.document.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? null;
  const redirected = res.chain.length > 1 ? analyzeUrl(res.finalUrl) : null;
  return {
    title: parsed?.title ?? null,
    company: parsed?.company ?? null,
    location: parsed?.location ?? null,
    employment_type: parsed?.employment_type ?? null,
    posting_id: parsed?.posting_id ?? (redirected?.ok ? redirected.postingId : null),
    description_md: text,
    final_url: res.finalUrl,
    canonical_url: canonical ? new URL(canonical, res.finalUrl).toString() : null,
    application_url: res.finalUrl,
    method: "html",
  };
}

/**
 * Extracts one posting. Throws ExtractionError with a kind the queue maps to a
 * user-facing state: closed postings and incomplete/blocked pages need the user,
 * transient failures are retried.
 */
export async function extractPosting(url: string, fetcher: Fetcher = defaultFetcher): Promise<ExtractedPosting> {
  const info = analyzeUrl(url);
  if (!info.ok) throw new ExtractionError("failed", info.message);
  const u = new URL(info.normalized);

  let result: ExtractedPosting | null | undefined;
  try {
    if (info.ats === "greenhouse" && info.postingId) {
      // Employer pages embedding a board (?gh_jid=) don't name the tenant; the
      // employer's domain label is the usual board token, else fall back to HTML.
      const tenant = info.tenant ?? u.hostname.replace(/^www\./, "").split(".")[0];
      result = await greenhouse(tenant, info.postingId, fetcher, info.normalized);
      if (result === null && info.tenant) throw new ExtractionError("closed", "Greenhouse reports this posting is closed or removed");
    } else if (info.ats === "lever" && info.tenant && info.postingId) {
      result = await lever(info.tenant, info.postingId, u.hostname.includes(".eu."), fetcher);
      if (result === null) throw new ExtractionError("closed", "Lever reports this posting is closed or removed");
    } else if (info.ats === "ashby" && info.tenant && info.postingId) {
      result = await ashby(info.tenant, info.postingId, fetcher);
      if (result === null) throw new ExtractionError("closed", "Ashby's job board no longer lists this posting");
    } else if (info.ats === "workday") {
      result = await workday(u, fetcher);
      if (result === null) throw new ExtractionError("closed", "Workday reports this posting is closed");
    } else if (info.ats === "oracle" && info.postingId) {
      result = await oracle(u, info.postingId, fetcher);
      if (result === null) throw new ExtractionError("closed", "Oracle reports this posting is closed or removed");
    } else if (info.ats === "workable" && info.tenant && info.postingId) {
      result = await workable(info.tenant, info.postingId, fetcher);
      if (result === null) throw new ExtractionError("closed", "Workable reports this posting is closed or removed");
    }
  } catch (err) {
    if (err instanceof ExtractionError) throw err;
    if (err instanceof Error && err.name === "BlockedUrlError") throw new ExtractionError("failed", err.message);
    // API unreachable or changed shape: fall through to generic HTML.
    result = null;
  }
  if (!result) result = await generic(info.normalized, fetcher);

  if (result.description_md.trim().length < MIN_DESCRIPTION_CHARS) {
    throw new ExtractionError(
      "incomplete",
      `Only ${result.description_md.trim().length} characters of description were found, which is too little to tailor a resume from. Paste the full description manually.`
    );
  }
  return result;
}
