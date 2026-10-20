import crypto from "crypto";
import { getDb } from "../db";
import type { AnswerScope, FieldCategory } from "../workflow-types";
import type { ScannedField } from "./scan";

/**
 * Decides what goes in each form field (plan §6):
 *  - exact facts come from the verified profile, verbatim;
 *  - eligibility (work authorization, sponsorship) only from explicit answers;
 *  - voluntary demographic questions follow the user's stated policy, never inferred;
 *  - attestations/certifications and narrative answers always come from the user;
 *  - anything else from the answer bank, or the user is asked.
 * No model is involved in any of this.
 */

export interface Resolution {
  category: FieldCategory;
  /** Text to enter, or the exact option label to pick. null = nothing to fill. */
  answer: string | null;
  source: string | null;
  status: "resolved" | "unknown" | "skipped" | "unsupported";
  note?: string;
  /** The value we meant to pick when it didn't match the listed options (lets search boxes be searched for it). */
  intended?: string;
}

export interface ResolveContext {
  profile: Record<string, string>;
  company: string;
  jobId: number;
  /** Local path of the approved resume PDF. */
  resumePath: string | null;
  /** Local path of a cover letter linked to the job, if any. */
  coverLetterPath: string | null;
}

// ---------- text normalisation ----------

export function norm(s: string): string {
  return s.toLowerCase().replace(/[*✱]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Question text with the company name abstracted, so answers can be reused across employers. */
export function questionKey(label: string, company: string): string {
  let q = norm(label);
  const c = norm(company);
  if (c.length >= 2) q = q.split(c).join("{company}");
  return q;
}

export function optionsSig(options: string[]): string {
  if (!options.length) return "";
  const joined = options.map(norm).sort().join("|");
  return crypto.createHash("sha1").update(joined).digest("hex").slice(0, 16);
}

const companyKey = (company: string) => norm(company);

// ---------- option matching ----------

const YES = new Set(["yes", "y", "true"]);
const NO = new Set(["no", "n", "false"]);

/**
 * Picks the option an answer refers to, or null when it isn't clear. Never
 * guesses between two plausible options.
 */
export function matchOption(answer: string, options: string[]): string | null {
  if (!options.length) return null;
  const a = norm(answer);
  if (!a) return null;
  const exact = options.filter((o) => norm(o) === a);
  if (exact.length === 1) return exact[0];
  if (YES.has(a) || NO.has(a)) {
    const want = YES.has(a) ? "yes" : "no";
    const hits = options.filter((o) => norm(o).split(" ")[0] === want);
    return hits.length === 1 ? hits[0] : null;
  }
  const contains = options.filter((o) => {
    const n = norm(o);
    return n.length >= 2 && (n.includes(a) || (a.includes(n) && n.length >= 4));
  });
  if (contains.length === 1) return contains[0];
  // Token overlap as a last resort, only with a clear winner.
  const at = new Set(a.split(" "));
  const scored = options
    .map((o) => {
      const ot = new Set(norm(o).split(" "));
      const inter = [...at].filter((t) => ot.has(t)).length;
      return { o, s: inter / new Set([...at, ...ot]).size };
    })
    .sort((x, y) => y.s - x.s);
  if (scored[0].s >= 0.6 && (scored.length === 1 || scored[0].s - scored[1].s >= 0.2)) return scored[0].o;
  return null;
}

const DECLINE = /decline|prefer not|don.?t wish|do not wish|not wish to|choose not|rather not|not to (say|answer|disclose|self.?identify)|i don.?t want/i;

// ---------- classification ----------

type Rule = { test: RegExp; key: string | ((p: Record<string, string>) => string | null) };

const monthNames = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function gradPart(p: Record<string, string>, part: "month" | "year"): string | null {
  const g = p.graduation?.trim();
  if (!g) return null;
  if (part === "year") return g.match(/\b(19|20)\d{2}\b/)?.[0] ?? null;
  const m = monthNames.find((n) => g.toLowerCase().includes(n.slice(0, 3)));
  return m ? m[0].toUpperCase() + m.slice(1) : null;
}

/** Exact facts: label pattern → verified profile value. Order matters (specific first). */
const FACT_RULES: Rule[] = [
  { test: /\bpreferred (first )?name\b/, key: "preferred_name" },
  { test: /^(legal )?first name$|^given name$/, key: "first_name" },
  { test: /^(legal )?last name$|^surname$|^family name$/, key: "last_name" },
  { test: /^(full |legal |your )?(full )?name$|^full legal name$/, key: "full_name" },
  { test: /\be ?mail\b/, key: "email" },
  { test: /\b(phone|mobile|cell)\b/, key: "phone" },
  { test: /\blinkedin\b/, key: "linkedin" },
  { test: /\bgithub\b/, key: "github" },
  { test: /\b(portfolio|personal (web)?site|website|personal url)\b/, key: "website" },
  { test: /^country( of residence)?$/, key: "country" },
  { test: /^(current )?location|\bcity\b|where are you (currently )?(based|located)/, key: "location" },
  { test: /^(current )?(company|employer|organization)( name)?$|^current company|^org$/, key: "current_company" },
  { test: /^(current )?(job )?title$|^current (job )?title|^position title$/, key: "current_title" },
  { test: /^(school|university|college)( name)?$|^which (school|university)/, key: "school" },
  { test: /^degree$|degree are you (currently )?pursuing|^highest degree|^degree type/, key: "degree" },
  { test: /^(discipline|major|field of study|area of study)$/, key: "major" },
  { test: /\bgpa\b|grade point/, key: "gpa" },
  { test: /^end date month$|graduation month/, key: (p) => gradPart(p, "month") },
  { test: /^end date year$|graduation year/, key: (p) => gradPart(p, "year") },
  { test: /(expected )?graduation( date)?\b|when do you graduate|expected to graduate/, key: "graduation" },
  { test: /when can you start|earliest (possible )?start|available to start|start date$|availability date/, key: "earliest_start" },
];

const ELIGIBILITY = /authori[sz]ed to work|legally (authori[sz]ed|eligible|permitted)|eligible to work|right to work|work authori[sz]ation|employment eligibility|sponsor/;
const DEMOGRAPHIC = /\b(gender|sex|race|racial|ethnic(ity)?|hispanic|latin[oax]|veteran|disabilit(y|ies)|sexual orientation|transgender|pronouns?|lgbt)\b|age range|how old/;
const ATTESTATION = /\bi (hereby )?(certify|acknowledge|agree|consent|attest|confirm|understand)\b|privacy (policy|notice)|terms (of|and) |accurate (and|&) complete|by (checking|submitting)/;
const NARRATIVE = /\bwhy\b|describe|tell us|explain|cover letter|additional information|anything else|what (excites|interests|draws)|motivat/;

/** Secrets are never filled from the profile ("Portfolio Password" is not a portfolio URL). */
const SECRET = /\b(password|passcode|pin|ssn|social security)\b/;

export function categorize(f: ScannedField): FieldCategory {
  const l = norm(f.label);
  if (f.kind === "file") return "file";
  if (SECRET.test(l)) return "other";
  if (ELIGIBILITY.test(l)) return "eligibility";
  if (DEMOGRAPHIC.test(l)) return "demographic";
  if (ATTESTATION.test(l) || (f.kind === "checkbox" && f.options.length === 1 && /agree|certify|acknowledge|consent|confirm|i have read|understand/.test(norm(f.options[0].label)))) {
    return "attestation";
  }
  if (FACT_RULES.some((r) => r.test.test(l))) return "fact";
  // A question with options is a choice, however it's worded ("which best describes…").
  if (f.options.length && f.kind !== "text" && f.kind !== "textarea") return "other";
  if (f.kind === "textarea" || NARRATIVE.test(l)) return "narrative";
  return "other";
}

// ---------- answer bank ----------

export interface SavedAnswer {
  answer: string;
  scope: AnswerScope;
}

export function lookupAnswer(label: string, options: string[], ctx: { company: string; jobId: number }): SavedAnswer | null {
  const row = getDb()
    .prepare(
      `SELECT answer, scope FROM answers
       WHERE question_norm = ? AND (options_sig = ? OR options_sig = '')
         AND ((scope = 'job' AND job_id = ?) OR (scope = 'company' AND company_key = ?) OR scope = 'global')
       ORDER BY CASE scope WHEN 'job' THEN 0 WHEN 'company' THEN 1 ELSE 2 END,
                CASE WHEN options_sig = '' THEN 1 ELSE 0 END
       LIMIT 1`
    )
    .get(questionKey(label, ctx.company), optionsSig(options), ctx.jobId, companyKey(ctx.company)) as SavedAnswer | undefined;
  return row ?? null;
}

export function saveAnswer(input: {
  label: string; options: string[]; answer: string; scope: AnswerScope; company: string; jobId: number;
}): void {
  const scope = input.scope;
  getDb()
    .prepare(
      `INSERT INTO answers (question_norm, question_text, options_sig, answer, scope, company_key, job_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(question_norm, options_sig, scope, COALESCE(company_key, ''), COALESCE(job_id, 0))
       DO UPDATE SET answer = excluded.answer, question_text = excluded.question_text,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
    )
    .run(
      questionKey(input.label, input.company), input.label, optionsSig(input.options), input.answer, scope,
      scope === "company" ? companyKey(input.company) : null, scope === "job" ? input.jobId : null
    );
}

// ---------- editing (Profile page) ----------

export interface AnswerRow {
  id: number;
  question_text: string;
  answer: string;
  scope: AnswerScope;
  /** Normalised company name, for company-scoped answers. */
  company_key: string | null;
  job_id: number | null;
  /** "Company — Title", for job-scoped answers. */
  job_label: string | null;
  /** Saved for a question with a fixed list of options (the answer must match one). */
  has_options: boolean;
  updated_at: string;
}

export function listAnswers(): AnswerRow[] {
  return (getDb()
    .prepare(
      `SELECT a.id, a.question_text, a.answer, a.scope, a.company_key, a.job_id, a.options_sig, a.updated_at,
              CASE WHEN j.id IS NULL THEN NULL ELSE j.company || ' — ' || j.title END AS job_label
         FROM answers a LEFT JOIN jobs j ON j.id = a.job_id
        ORDER BY CASE a.scope WHEN 'global' THEN 0 WHEN 'company' THEN 1 ELSE 2 END, a.company_key, lower(a.question_text)`
    )
    .all() as (Omit<AnswerRow, "has_options"> & { options_sig: string })[])
    .map(({ options_sig, ...r }) => ({ ...r, has_options: options_sig !== "" }));
}

/** Changes a saved answer's text. False if there's no such answer. */
export function updateAnswerText(id: number, answer: string): boolean {
  return getDb()
    .prepare("UPDATE answers SET answer = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
    .run(answer, id).changes > 0;
}

export function deleteAnswer(id: number): boolean {
  return getDb().prepare("DELETE FROM answers WHERE id = ?").run(id).changes > 0;
}

/**
 * Adds an answer for every application. Write "{company}" where the company's
 * name goes ("Why {company}?"); it works for any list of options, as long as the
 * answer matches one of them.
 */
export function addGlobalAnswer(question: string, answer: string): void {
  // Same key questionKey() makes from a real form ("Why Acme?" at Acme → "why {company}").
  const key = question.split(/\{company\}/i).map(norm).join(" {company} ").replace(/\s+/g, " ").trim();
  getDb()
    .prepare(
      `INSERT INTO answers (question_norm, question_text, options_sig, answer, scope)
       VALUES (?, ?, '', ?, 'global')
       ON CONFLICT(question_norm, options_sig, scope, COALESCE(company_key, ''), COALESCE(job_id, 0))
       DO UPDATE SET answer = excluded.answer, question_text = excluded.question_text,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
    )
    .run(key, question.trim(), answer);
}

// ---------- resolution ----------

function yesNo(v: string | undefined): "Yes" | "No" | null {
  if (!v) return null;
  const n = norm(v);
  if (YES.has(n)) return "Yes";
  if (NO.has(n)) return "No";
  return null;
}

/** Fits a value to the field: options must match one exactly, free text is used as-is. */
function fit(f: ScannedField, value: string, source: string, category: FieldCategory): Resolution {
  const labels = f.options.map((o) => o.label);
  // A lone checkbox ("I certify…"): yes ticks it, no leaves it unticked.
  if (f.kind === "checkbox" && labels.length === 1) {
    const yn = yesNo(value);
    if (yn === "Yes") return { category, answer: labels[0], source, status: "resolved" };
    if (yn === "No") return { category, answer: null, source, status: f.required ? "unknown" : "skipped", note: "Left unticked; the form requires it" };
    return { category, answer: null, source, status: "unknown", note: 'Answer "Yes" to tick this box' };
  }
  // Checkbox groups can hold several choices: "A; B" (commas are tried too, when every part matches).
  if (f.kind === "checkbox" && labels.length > 1) {
    const parts = value.includes(";") ? value.split(";") : value.split(",").length > 1 && value.split(",").every((p) => matchOption(p, labels)) ? value.split(",") : [value];
    const picks = parts.map((p) => p.trim()).filter(Boolean).map((p) => matchOption(p, labels));
    if (!picks.length || picks.some((p) => !p)) {
      return { category, answer: null, source, status: "unknown", note: `"${value}" doesn't clearly match the options` };
    }
    return { category, answer: [...new Set(picks as string[])].join("; "), source, status: "resolved" };
  }
  const listed = f.kind === "select" || f.kind === "radio" || f.kind === "buttons" || (f.kind === "combobox" && labels.length > 0);
  if (listed) {
    // "Please confirm…" dropdowns with a single option: yes means that option.
    if (labels.length === 1 && yesNo(value) === "Yes") return { category, answer: labels[0], source, status: "resolved" };
    const pick = matchOption(value, labels);
    if (!pick) {
      return { category, answer: null, source, status: "unknown", note: `"${value}" doesn't clearly match one of the options`, intended: value };
    }
    return { category, answer: pick, source, status: "resolved" };
  }
  // Search-as-you-type comboboxes (no options until typed) are matched at fill time.
  return { category, answer: value, source, status: "resolved" };
}

export function resolveField(f: ScannedField, ctx: ResolveContext): Resolution {
  const category = categorize(f);
  const l = norm(f.label);
  const labels = f.options.map((o) => o.label);
  const unknown = (note: string): Resolution =>
    f.required ? { category, answer: null, source: null, status: "unknown", note } : { category, answer: null, source: null, status: "skipped", note };

  if (!f.label) return { category, answer: null, source: null, status: f.required ? "unsupported" : "skipped", note: "Field has no readable label" };

  // Saved answers take precedence for everything except files and demographic policy.
  if (category !== "file" && category !== "demographic") {
    const saved = lookupAnswer(f.label, labels, ctx);
    // Attestations are confirmed per application; a global "I agree" never carries over.
    if (saved && (category !== "attestation" || saved.scope === "job")) {
      return fit(f, saved.answer, `answer bank (${saved.scope})`, category);
    }
  }

  switch (category) {
    case "file": {
      if (/resume|cv\b|curriculum/.test(l)) {
        return ctx.resumePath
          ? { category, answer: ctx.resumePath, source: "approved resume", status: "resolved" }
          : { category, answer: null, source: null, status: "unknown", note: "Approve a resume first" };
      }
      if (/cover letter/.test(l) && ctx.coverLetterPath) {
        return { category, answer: ctx.coverLetterPath, source: "linked cover letter", status: "resolved" };
      }
      return f.required
        ? { category, answer: null, source: null, status: "unsupported", note: "Required upload other than the resume; attach it yourself" }
        : { category, answer: null, source: null, status: "skipped", note: "Optional upload" };
    }
    case "fact": {
      const rule = FACT_RULES.find((r) => r.test.test(l))!;
      const value = typeof rule.key === "function" ? rule.key(ctx.profile) : ctx.profile[rule.key];
      if (!value) return unknown(`Not in your Profile yet (${typeof rule.key === "string" ? rule.key : "graduation"})`);
      return fit(f, value, "profile", category);
    }
    case "eligibility": {
      const sponsor = /sponsor/.test(l);
      const key = sponsor ? (/future|will you|in the future/.test(l) ? "needs_sponsorship_future" : "needs_sponsorship_now") : "work_authorized_us";
      const v = yesNo(ctx.profile[key]);
      if (!v) return { category, answer: null, source: null, status: "unknown", note: `Set "${key.replace(/_/g, " ")}" in your Profile or answer here` };
      return fit(f, v, `profile (${key})`, category);
    }
    case "demographic": {
      const policy = ctx.profile.demographic_policy ?? "";
      if (DECLINE.test(policy)) {
        const decline = labels.filter((o) => DECLINE.test(o));
        if (decline.length === 1) return { category, answer: decline[0], source: "demographic policy", status: "resolved" };
        if (f.kind === "combobox") return { category, answer: "Decline", source: "demographic policy", status: "resolved", note: "Will pick the decline option" };
        return unknown("No decline option to choose");
      }
      return unknown("Voluntary question: set a demographic policy in your Profile or answer here");
    }
    case "attestation":
      // Always a per-application decision by the person.
      return { category, answer: null, source: null, status: f.required ? "unknown" : "skipped", note: "You need to confirm this yourself" };
    case "narrative":
      return unknown("Write this answer (it's saved for this job only by default)");
    default:
      return unknown("No saved answer yet");
  }
}
