import fs from "fs";
import { createRequire } from "module";
import path from "path";
import { DATA_DIR } from "./db";
import { listExperiences } from "./experience";
import { getDocument, getJob } from "./queries";
import type { AppDocument } from "./types";
import type { WorkExperience } from "./workflow-types";

/**
 * Which of the Profile's jobs a resume mentions, so a form's Work Experience sections get the same jobs as the
 * resume sent with it, in the resume's order. Plain text matching on company names (and titles, to tell two jobs
 * at one company apart); no model.
 */

const norm = (s: string) => ` ${s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;

/** Legal-form words resumes usually leave off ("Acme Inc." is just "Acme" on a resume). */
const SUFFIXES = /\s(inc|incorporated|llc|ltd|limited|corp|corporation|co|company|plc|gmbh|lp|llp)\s*$/;

/** Where `phrase` first appears in `text` as whole words (both normalised), or -1. */
function find(text: string, phrase: string): number {
  const p = norm(phrase);
  if (p.trim().length < 2) return -1;
  const at = text.indexOf(p);
  if (at >= 0) return at;
  const short = p.replace(SUFFIXES, " ");
  return short !== p && short.trim().length >= 2 ? text.indexOf(short) : -1;
}

export interface ResumeMatch {
  /** The jobs to fill, in the resume's order. */
  experiences: WorkExperience[];
  /** Why every job is used instead (no resume, unreadable, mentions none); null when the resume decided. */
  fallback: string | null;
}

/**
 * The Profile jobs `resumeText` mentions, in the order it mentions them. A job counts when its company appears;
 * when several jobs share a company, each also needs its title to appear (and is placed by it).
 */
export function matchExperiences(experiences: WorkExperience[], resumeText: string): WorkExperience[] {
  const text = norm(resumeText);
  const sameCompany = (e: WorkExperience) => experiences.filter((o) => norm(o.company) === norm(e.company)).length;
  return experiences
    .flatMap((e, i) => {
      const company = find(text, e.company);
      if (company < 0) return [];
      const title = find(text, e.title);
      if (sameCompany(e) > 1 && title < 0) return [];
      // Order by where the job appears; a shared company is placed by its title.
      return [{ e, at: sameCompany(e) > 1 ? title : company, i }];
    })
    .sort((a, b) => a.at - b.at || a.i - b.i)
    .map((m) => m.e);
}

/**
 * pdf.js (inside unpdf) uses built-ins from Node 22+ (`Iterator`, `process.getBuiltinModule`, `URL.parse`), and
 * without them it fails to load at all ("Iterator is not defined"), so on an older Node every PDF was unreadable.
 * Only what's missing is added.
 */
function addPdfjsBuiltins(): void {
  const g = globalThis as { Iterator?: unknown };
  if (typeof g.Iterator === "undefined") {
    // The prototype every built-in iterator inherits from; pdf.js only adds methods to it.
    const prototype = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
    const Iterator = function Iterator() {};
    Iterator.prototype = prototype;
    Object.defineProperty(globalThis, "Iterator", { value: Iterator, writable: true, configurable: true });
  }
  const proc = process as { getBuiltinModule?: (id: string) => unknown };
  if (typeof proc.getBuiltinModule !== "function") {
    const load = createRequire(path.join(process.cwd(), "package.json"));
    proc.getBuiltinModule = (id: string) => load(id);
  }
  const url = URL as { parse?: (u: string, base?: string | URL) => URL | null };
  if (typeof url.parse !== "function") {
    url.parse = (u, base) => {
      try {
        return new URL(u, base);
      } catch {
        return null;
      }
    };
  }
}

const cache = new Map<string, string>();

/** The resume's text (PDFs through pdf.js via unpdf, plain text and Markdown as they are), or why it has none. */
export async function documentText(doc: AppDocument): Promise<{ text: string } | { error: string }> {
  const key = doc.content_sha256 ?? doc.file_path;
  const cached = cache.get(key);
  if (cached) return { text: cached };
  const file = path.join(DATA_DIR, doc.file_path);
  if (!fs.existsSync(file)) return { error: "the file is missing" };
  const ext = path.extname(doc.file_path).toLowerCase();
  let text: string;
  try {
    if (ext === ".pdf") {
      addPdfjsBuiltins();
      const { extractText, getDocumentProxy } = await import("unpdf");
      const pdf = await getDocumentProxy(new Uint8Array(fs.readFileSync(file)));
      text = (await extractText(pdf, { mergePages: true })).text;
    } else if (ext === ".txt" || ext === ".md") {
      text = fs.readFileSync(file, "utf8");
    } else {
      return { error: "only PDF, .txt and .md can be read" };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[resume-experience] reading ${doc.file_path} failed (Node ${process.version}):`, err);
    return { error: message };
  }
  if (!text.trim()) return { error: "it has no text (a scanned image?)" };
  cache.set(key, text);
  return { text };
}

/** The Profile jobs to fill for `jobId`: the ones its resume mentions, else all of them (with the reason). */
export async function experiencesForJob(jobId: number | null): Promise<ResumeMatch> {
  const all = listExperiences();
  if (!all.length) return { experiences: [], fallback: null };
  const job = jobId ? getJob(jobId) : null;
  const doc = job?.resume_id ? getDocument(job.resume_id) : null;
  if (!doc) return { experiences: all, fallback: "No resume picked for this job" };
  const read = await documentText(doc);
  if ("error" in read) return { experiences: all, fallback: `Couldn't read ${doc.name}: ${read.error}` };
  const matched = matchExperiences(all, read.text);
  if (!matched.length) return { experiences: all, fallback: `${doc.name} doesn't name any of your Profile's companies` };
  return { experiences: matched, fallback: null };
}
