import { getDb } from "./db";
import type { Job } from "./types";

/** Lowercase, strip punctuation, collapse whitespace — "Goldman-Sachs, Inc." -> "goldman sachs inc". */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Company-name noise that shouldn't influence matching. */
const STOP_WORDS = new Set(["inc", "llc", "ltd", "corp", "co", "the", "and", "of", "at", "a"]);

function tokens(text: string): string[] {
  return normalize(text).split(" ").filter((t) => t && !STOP_WORDS.has(t));
}

/** Levenshtein distance, capped work for short strings (company/role names). */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

/** 0..1 similarity between two whole strings. */
function similarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (!longest) return 0;
  return 1 - editDistance(a, b) / longest;
}

/**
 * How well `query` matches `target`, 0..1.
 * Rewards exact/prefix/substring hits first, then falls back to per-token fuzzy
 * matching so typos ("gogle", "sofware eng") still land.
 */
export function scoreText(query: string, target: string): number {
  const q = normalize(query);
  const t = normalize(target);
  if (!q || !t) return 0;
  if (q === t) return 1;
  if (t.startsWith(q)) return 0.95;
  if (t.includes(q)) return 0.85;

  const qTokens = tokens(query);
  const tTokens = tokens(target);
  if (!qTokens.length || !tTokens.length) return 0;

  // Acronyms: "ml" -> "Machine Learning …", "swe" -> "Software Engineer …".
  // Check the initials of every run of consecutive target tokens so the match
  // doesn't have to start at the beginning of the title.
  if (qTokens.length === 1 && q.length >= 2 && q.length <= 5) {
    for (let i = 0; i + q.length <= tTokens.length; i++) {
      const initials = tTokens.slice(i, i + q.length).map((t) => t[0]).join("");
      if (initials === q) return i === 0 ? 0.9 : 0.85;
    }
  }

  // Average best-match score of each query token against the target's tokens.
  let total = 0;
  for (const qt of qTokens) {
    let best = 0;
    for (const tt of tTokens) {
      const s = tt === qt ? 1 : tt.startsWith(qt) ? 0.9 : similarity(qt, tt);
      if (s > best) best = s;
    }
    total += best;
  }
  const avg = total / qTokens.length;
  // Whole-string similarity as a floor, so "googl" vs "google" scores well even
  // when tokenization doesn't help.
  return Math.max(avg, similarity(q, t));
}

export interface JobMatch {
  job: Job;
  score: number;
  /** Which part of the job the query matched best. */
  matchedOn: "company" | "title" | "both";
}

/** Minimum score for a result to be worth showing at all. */
export const MIN_SCORE = 0.45;
/** A single result at/above this score is confident enough to redirect straight to it. */
export const AUTO_NAVIGATE_SCORE = 0.75;

function allJobs(): Job[] {
  return getDb().prepare("SELECT * FROM jobs ORDER BY created_at DESC, id DESC").all() as Job[];
}

/** Rank companies (distinct company names across jobs) against a query. */
export function searchCompanies(query: string): { company: string; jobs: Job[]; score: number }[] {
  const byCompany = new Map<string, Job[]>();
  for (const job of allJobs()) {
    const key = normalize(job.company);
    const bucket = byCompany.get(key);
    if (bucket) bucket.push(job);
    else byCompany.set(key, [job]);
  }
  return [...byCompany.values()]
    .map((jobs) => ({ company: jobs[0].company, jobs, score: scoreText(query, jobs[0].company) }))
    .filter((c) => c.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score);
}

/**
 * Rank individual applications.
 * `company` narrows the pool (soft — a weak company match just lowers the score);
 * `role` matches against the job title. Either may be omitted.
 */
export function searchJobs(query: { company?: string; role?: string }, pool?: Job[]): JobMatch[] {
  const jobs = pool ?? allJobs();
  const matches: JobMatch[] = [];
  for (const job of jobs) {
    const companyScore = query.company ? scoreText(query.company, job.company) : null;
    const roleScore = query.role ? scoreText(query.role, job.title) : null;

    let score: number;
    let matchedOn: JobMatch["matchedOn"];
    if (companyScore !== null && roleScore !== null) {
      // Company is the stronger signal; weight it accordingly.
      score = companyScore * 0.6 + roleScore * 0.4;
      matchedOn = "both";
    } else if (companyScore !== null) {
      score = companyScore;
      matchedOn = "company";
    } else if (roleScore !== null) {
      score = roleScore;
      matchedOn = "title";
    } else {
      continue;
    }
    if (score >= MIN_SCORE) matches.push({ job, score, matchedOn });
  }
  return matches.sort((a, b) => b.score - a.score);
}

/**
 * Free-text search where the query isn't split into company/role by the caller
 * (e.g. "search google swe intern"). Scores each job on the whole query against
 * company, title, and "company title" combined, taking the best.
 */
export function searchFreeText(query: string, pool?: Job[]): JobMatch[] {
  const jobs = pool ?? allJobs();
  const matches: JobMatch[] = [];
  for (const job of jobs) {
    const companyScore = scoreText(query, job.company);
    const titleScore = scoreText(query, job.title);
    const combinedScore = scoreText(query, `${job.company} ${job.title}`);
    const score = Math.max(companyScore, titleScore, combinedScore);
    if (score < MIN_SCORE) continue;
    matches.push({
      job,
      score,
      matchedOn: combinedScore >= companyScore && combinedScore >= titleScore
        ? "both"
        : companyScore >= titleScore
          ? "company"
          : "title",
    });
  }
  return matches.sort((a, b) => b.score - a.score);
}
