import fs from "fs";
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

const cache = new Map<string, string>();

/** The resume's text: PDFs through pdf.js (unpdf), plain text and Markdown as they are. null if unreadable. */
export async function documentText(doc: AppDocument): Promise<string | null> {
  const key = doc.content_sha256 ?? doc.file_path;
  if (cache.has(key)) return cache.get(key)!;
  const file = path.join(DATA_DIR, doc.file_path);
  if (!fs.existsSync(file)) return null;
  const ext = path.extname(doc.file_path).toLowerCase();
  let text: string | null = null;
  try {
    if (ext === ".pdf") {
      const { extractText, getDocumentProxy } = await import("unpdf");
      const pdf = await getDocumentProxy(new Uint8Array(fs.readFileSync(file)));
      text = (await extractText(pdf, { mergePages: true })).text;
    } else if (ext === ".txt" || ext === ".md") {
      text = fs.readFileSync(file, "utf8");
    }
  } catch {
    text = null;
  }
  if (text?.trim()) cache.set(key, text);
  return text?.trim() ? text : null;
}

/** The Profile jobs to fill for `jobId`: the ones its resume mentions, else all of them (with the reason). */
export async function experiencesForJob(jobId: number | null): Promise<ResumeMatch> {
  const all = listExperiences();
  if (!all.length) return { experiences: [], fallback: null };
  const job = jobId ? getJob(jobId) : null;
  const doc = job?.resume_id ? getDocument(job.resume_id) : null;
  if (!doc) return { experiences: all, fallback: "No resume picked for this job" };
  const text = await documentText(doc);
  if (!text) return { experiences: all, fallback: `Couldn't read ${doc.name} (PDF, .txt or .md only)` };
  const matched = matchExperiences(all, text);
  if (!matched.length) return { experiences: all, fallback: `${doc.name} doesn't name any of your Profile's companies` };
  return { experiences: matched, fallback: null };
}
