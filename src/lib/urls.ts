import net from "net";
import { isBlockedIp } from "./netguard";

/**
 * Job-link normalisation and ATS detection, used for deduplication at import.
 *
 * The dedup key prefers the ATS's own posting identity (e.g. `greenhouse:4012345`)
 * so an employer career page and the ATS page it redirects to collapse into one
 * application. Without a recognised ATS, it falls back to a normalised URL that
 * drops tracking parameters but keeps anything that might identify the job.
 */

export type Ats =
  | "greenhouse" | "lever" | "ashby" | "workday" | "smartrecruiters" | "icims" | "oracle" | "workable"
  | "linkedin" | "indeed";

export type UrlAnalysis =
  | {
      ok: true;
      /** Normalised URL: lowercase host, no fragment/tracking params, sorted query. */
      normalized: string;
      ats: Ats | null;
      tenant: string | null;
      postingId: string | null;
      key: string;
      /** Non-fatal caveat to show in the import preview. */
      warning: string | null;
    }
  | { ok: false; reason: "invalid" | "unsupported"; message: string };

/** Query params that only track where a click came from. Everything else is kept. */
const TRACKING_PARAM = /^(utm_[a-z_]+|gh_src|lever-source|lever-origin|lever-via|source|src|ref|referrer|refid|trk|trackingid|fbclid|gclid|msclkid|mc_cid|mc_eid|_hsenc|_hsmi|hsa_[a-z_]+|mkt_tok|ccuid|sid)$/i;

const GREENHOUSE_HOSTS = /^(boards|job-boards)(\.eu)?\.greenhouse\.io$/;
const LEVER_HOSTS = /^jobs(\.eu)?\.lever\.co$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function stripWww(host: string): string {
  return host.replace(/^www\./, "");
}

export function normalizeUrl(u: URL): string {
  const out = new URL(u.toString());
  out.hostname = out.hostname.toLowerCase();
  out.username = "";
  out.password = "";
  // Hash routes (`#/jobs/123`) can carry the job identity in SPAs; plain anchors don't.
  if (!/^#[/!]/.test(out.hash)) out.hash = "";
  const kept = [...out.searchParams.entries()]
    .filter(([k]) => !TRACKING_PARAM.test(k))
    .sort(([a], [b]) => a.localeCompare(b));
  out.search = "";
  for (const [k, v] of kept) out.searchParams.append(k, v);
  if (out.pathname.length > 1) out.pathname = out.pathname.replace(/\/+$/, "");
  return out.toString();
}

interface Detected {
  ats: Ats;
  tenant: string | null;
  postingId: string;
  /** Globally unique within that ATS. */
  key: string;
}

export function detectAts(u: URL): Detected | null {
  const host = stripWww(u.hostname.toLowerCase());
  const segs = u.pathname.split("/").filter(Boolean);
  const q = u.searchParams;

  // Greenhouse posting IDs are unique across all boards, so the key omits the tenant.
  if (GREENHOUSE_HOSTS.test(host)) {
    const i = segs.indexOf("jobs");
    if (i >= 1 && /^\d+$/.test(segs[i + 1] ?? "")) {
      return { ats: "greenhouse", tenant: segs[i - 1].toLowerCase(), postingId: segs[i + 1], key: `greenhouse:${segs[i + 1]}` };
    }
    const token = q.get("token");
    if (token && /^\d+$/.test(token)) {
      const tenant = q.get("for")?.toLowerCase() ?? null;
      return { ats: "greenhouse", tenant, postingId: token, key: `greenhouse:${token}` };
    }
  }
  // Employer career pages embedding a Greenhouse board.
  const ghJid = q.get("gh_jid");
  if (ghJid && /^\d+$/.test(ghJid)) {
    return { ats: "greenhouse", tenant: null, postingId: ghJid, key: `greenhouse:${ghJid}` };
  }

  if (LEVER_HOSTS.test(host) && segs.length >= 2 && UUID.test(segs[1])) {
    const id = segs[1].toLowerCase();
    return { ats: "lever", tenant: segs[0].toLowerCase(), postingId: id, key: `lever:${id}` };
  }

  if (host === "jobs.ashbyhq.com" && segs.length >= 2 && UUID.test(segs[1])) {
    const id = segs[1].toLowerCase();
    return { ats: "ashby", tenant: segs[0].toLowerCase(), postingId: id, key: `ashby:${id}` };
  }
  const ashbyJid = q.get("ashby_jid");
  if (ashbyJid && UUID.test(ashbyJid)) {
    const id = ashbyJid.toLowerCase();
    return { ats: "ashby", tenant: null, postingId: id, key: `ashby:${id}` };
  }

  // e.g. nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Software-Intern_JR1990000
  if (host.endsWith(".myworkdayjobs.com")) {
    const jobIdx = segs.indexOf("job");
    const last = segs[segs.length - 1] ?? "";
    const req = jobIdx >= 0 ? last.match(/_([A-Za-z]*-?\d[\w-]*)$/)?.[1] : undefined;
    if (req) {
      const tenant = host.split(".")[0];
      return { ats: "workday", tenant, postingId: req, key: `workday:${tenant}:${req.toLowerCase()}` };
    }
  }

  if (host === "jobs.smartrecruiters.com" && segs.length >= 2) {
    const id = segs[1].match(/^(\d{6,})/)?.[1];
    if (id) return { ats: "smartrecruiters", tenant: segs[0].toLowerCase(), postingId: id, key: `smartrecruiters:${id}` };
  }

  if (host.endsWith(".icims.com")) {
    const i = segs.indexOf("jobs");
    const id = i >= 0 ? segs[i + 1] : undefined;
    if (id && /^\d+$/.test(id)) {
      const tenant = host.split(".")[0].replace(/^careers-/, "");
      return { ats: "icims", tenant, postingId: id, key: `icims:${tenant}:${id}` };
    }
  }

  // Oracle Recruiting Cloud: {pod}.fa.{region}.oraclecloud.com/hcmUI/CandidateExperience/{lang}/sites/{site}/job/{id}
  if (host.endsWith(".oraclecloud.com") && segs.includes("CandidateExperience")) {
    const i = segs.indexOf("job");
    const id = i >= 0 ? segs[i + 1] : undefined;
    if (id && /^\d+$/.test(id)) return { ats: "oracle", tenant: null, postingId: id, key: `oracle:${host}:${id}` };
  }

  // Workable: apply.workable.com/{account}/j/{shortcode}
  if (host === "apply.workable.com" && segs[1] === "j" && /^[0-9A-F]{6,}$/i.test(segs[2] ?? "")) {
    const code = segs[2].toUpperCase();
    return { ats: "workable", tenant: segs[0].toLowerCase(), postingId: code, key: `workable:${segs[0].toLowerCase()}:${code}` };
  }

  if (host.endsWith("linkedin.com")) {
    const i = segs.indexOf("view");
    const fromPath = i >= 0 ? segs[i + 1]?.match(/(\d{6,})$/)?.[1] : undefined;
    const id = fromPath ?? q.get("currentJobId") ?? undefined;
    if (id && /^\d+$/.test(id)) return { ats: "linkedin", tenant: null, postingId: id, key: `linkedin:${id}` };
  }

  if (host.endsWith("indeed.com")) {
    const jk = q.get("jk") ?? q.get("vjk");
    if (jk && /^[0-9a-f]+$/i.test(jk)) return { ats: "indeed", tenant: null, postingId: jk, key: `indeed:${jk.toLowerCase()}` };
  }

  return null;
}

export function analyzeUrl(raw: string): UrlAnalysis {
  const text = raw.trim();
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return { ok: false, reason: "invalid", message: "Not a valid URL" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, reason: "invalid", message: "Only http(s) links are supported" };
  }
  if (u.username || u.password) {
    return { ok: false, reason: "invalid", message: "Links with embedded credentials are not accepted" };
  }

  const host = stripWww(u.hostname.toLowerCase());
  // Obvious local targets are refused up front; safeFetch still re-checks DNS on every hop.
  const bare = host.replace(/^\[|\]$/g, "");
  if (bare === "localhost" || /\.(localhost|local|internal)$/.test(bare) || (net.isIP(bare) && isBlockedIp(bare))) {
    return { ok: false, reason: "unsupported", message: "Local or private network address" };
  }
  if (u.port && u.port !== "80" && u.port !== "443") {
    return { ok: false, reason: "unsupported", message: "Non-standard port" };
  }
  const detected = detectAts(u);

  if (!detected && host.endsWith("linkedin.com")) {
    return { ok: false, reason: "unsupported", message: "LinkedIn link without a job ID (search or feed page)" };
  }
  if (!detected && host.endsWith("indeed.com")) {
    return { ok: false, reason: "unsupported", message: "Indeed link without a job key (search page)" };
  }

  const normalized = normalizeUrl(u);
  const n = new URL(normalized);
  let warning: string | null = null;
  if (detected?.ats === "linkedin" || detected?.ats === "indeed") {
    warning = "Job board link: the description may need manual entry, and you apply on the employer's site";
  } else if (!detected) {
    warning = "Unrecognised site: will try generic page extraction";
  }

  return {
    ok: true,
    normalized,
    ats: detected?.ats ?? null,
    tenant: detected?.tenant ?? null,
    postingId: detected?.postingId ?? null,
    key: detected?.key ?? `url:${stripWww(n.host)}${n.pathname}${n.search}${n.hash}`,
    warning,
  };
}

/** Pulls http(s) URLs out of pasted text: one per line, or several separated by spaces. */
export function splitPastedUrls(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  // Links pasted with no separator ("…ref=Simplifyhttps://jobs.lever.co/…") are split
  // where a new scheme starts right after a letter or digit. A URL nested as a
  // parameter value ("?url=https://…") follows "=", so it stays intact.
  const unglued = text.replace(/([A-Za-z0-9])(?=https?:\/\/)/g, "$1 ");
  for (const token of unglued.split(/[\s,]+/)) {
    const t = token.trim().replace(/^[<("']+|[>)"'.]+$/g, "");
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}
