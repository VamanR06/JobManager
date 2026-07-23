import { Readability } from "@mozilla/readability";
import { JSDOM, VirtualConsole } from "jsdom";
import TurndownService from "turndown";

export interface ParsedPosting {
  title: string | null;
  company: string | null;
  location: string | null;
  description_md: string;
}

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const turndown = new TurndownService({ headingStyle: "atx", bulletListMarker: "-" });

function htmlToMarkdown(html: string): string {
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

export async function parsePostingUrl(url: string): Promise<ParsedPosting> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Fetch failed: HTTP ${res.status}`);
  const html = await res.text();

  // Silence jsdom's noisy CSS-parse errors from real-world pages.
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(html, { url, virtualConsole });

  const result = fromJsonLd(dom.window.document) ?? fromReadability(dom);
  if (!result || !result.description_md) throw new Error("Could not extract posting content");
  return result;
}
