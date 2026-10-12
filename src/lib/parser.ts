import { Readability } from "@mozilla/readability";
import { JSDOM, VirtualConsole } from "jsdom";
import TurndownService from "turndown";
import { safeFetch } from "./netguard";

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
      title: str(posting.title),
      company,
      location: extractLocation(posting),
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

export async function parsePostingUrl(url: string): Promise<ParsedPosting> {
  // safeFetch refuses private/local hosts at every redirect hop.
  const res = await safeFetch(url);
  if (!res.ok) throw new Error(`Fetch failed: HTTP ${res.status}`);
  const result = parsePostingHtml(res.body, res.finalUrl);
  if (!result || !result.description_md) throw new Error("Could not extract posting content");
  return result;
}
