import path from "path";
import { getDb } from "../db";
import { getProfileMap } from "../profile";
import { getDocument, getJob } from "../queries";
import type { AppDocument, Job } from "../types";
import { analyzeUrl } from "../urls";
import { resolveField, type Resolution } from "./answers";
import { toPickerDate } from "./fill";
import type { FieldOption, ScannedField } from "./scan";

/**
 * Filling an application in the person's own browser (NotchMan): it reads the form with SCAN_SCRIPT, asks
 * `/api/apply/resolve` what goes where — the same rules as `browser_autofill` (`answers.ts`: Profile facts,
 * explicit eligibility answers, the answer bank, the demographic policy; no model) — and runs PAGE_FILL_SCRIPT
 * with the result. Nothing here submits anything.
 */

/** An application form's URL is often the posting's plus /apply or /application. */
const APPLY_SUFFIX = /\/(apply|application)\/?$/i;

/** The tracked job whose posting (or application form) `url` is, by the same posting identity as duplicates. */
export function jobForPage(url: string): Job | null {
  const candidates = [url];
  try {
    const u = new URL(url);
    if (APPLY_SUFFIX.test(u.pathname)) {
      u.pathname = u.pathname.replace(APPLY_SUFFIX, "");
      candidates.push(u.toString());
    }
  } catch {
    return null;
  }
  const db = getDb();
  for (const candidate of candidates) {
    const analysis = analyzeUrl(candidate);
    if (!analysis.ok) continue;
    const row = db.prepare("SELECT id FROM jobs WHERE posting_key = ? ORDER BY id DESC LIMIT 1").get(analysis.key) as
      | { id: number }
      | undefined;
    if (row) return getJob(row.id);
  }
  return null;
}

export interface PageDocument {
  id: number;
  /** File name with its extension, as an upload should show it. */
  name: string;
}

function documentSummary(id: number | null): PageDocument | null {
  const doc = id ? getDocument(id) : null;
  return doc ? { id: doc.id, name: fileName(doc) } : null;
}

export function fileName(doc: AppDocument): string {
  return path.extname(doc.name) ? doc.name : `${doc.name}${path.extname(doc.file_path)}`;
}

export interface PageInfo {
  job: { id: number; company: string; title: string; url: string | null } | null;
  resume: PageDocument | null;
  cover_letter: PageDocument | null;
}

export function pageInfo(url: string): PageInfo {
  const job = jobForPage(url);
  if (!job) return { job: null, resume: null, cover_letter: null };
  return {
    job: { id: job.id, company: job.company, title: job.title, url: job.url },
    resume: documentSummary(job.resume_id),
    cover_letter: documentSummary(job.cover_letter_id),
  };
}

/** One field to fill. `upload` asks the caller to attach the job's resume or cover letter. */
export interface FillStep {
  key: string;
  selector: string;
  kind: ScannedField["kind"];
  inputType: string;
  answer: string | null;
  upload: "resume" | "cover_letter" | null;
  options: FieldOption[];
}

export interface FieldPlan {
  key: string;
  label: string;
  kind: ScannedField["kind"];
  required: boolean;
  status: Resolution["status"];
  category: Resolution["category"];
  source: string | null;
  note: string | null;
}

export interface FillPlan {
  fill: FillStep[];
  fields: FieldPlan[];
}

/** Sentinels standing in for file paths: the browser's side holds the files. */
const RESUME = "\u0000resume";
const COVER_LETTER = "\u0000cover_letter";

/** What goes in each scanned field of `jobId`'s form, by `answers.ts`'s rules. */
export function planFill(jobId: number, scanned: ScannedField[]): FillPlan {
  const job = getJob(jobId);
  if (!job) throw new Error("Job not found");
  const ctx = {
    profile: getProfileMap(),
    company: job.company,
    jobId,
    resumePath: job.resume_id && getDocument(job.resume_id) ? RESUME : null,
    coverLetterPath: job.cover_letter_id && getDocument(job.cover_letter_id) ? COVER_LETTER : null,
  };
  const fill: FillStep[] = [];
  const fields: FieldPlan[] = [];
  for (const f of scanned) {
    const r = resolveField(f, ctx);
    let status = r.status;
    let note = r.note ?? null;
    if (status === "resolved" && r.answer !== null) {
      const upload = r.answer === RESUME ? "resume" : r.answer === COVER_LETTER ? "cover_letter" : null;
      let answer = upload ? null : r.answer;
      if (answer && f.inputType === "date") {
        answer = toPickerDate(answer);
        if (!answer) {
          status = "unknown";
          note = `"${r.answer}" isn't a date the picker understands`;
        }
      }
      if (status === "resolved") {
        fill.push({ key: f.key, selector: f.selector, kind: f.kind, inputType: f.inputType, answer, upload, options: f.options });
      }
    }
    fields.push({ key: f.key, label: f.label, kind: f.kind, required: f.required, status, category: r.category, source: r.source, note });
  }
  // Files first: ATS resume parsers fill fields from the upload, and the plan's answers should win.
  fill.sort((a, b) => Number(b.kind === "file") - Number(a.kind === "file"));
  return { fill, fields };
}

/** Options kept per field: generous enough for full school and country lists. */
export const MAX_OPTIONS = 10_000;

/** Rough shape check on what a browser sent, so a malformed body can't reach the resolver. */
export function parseScannedFields(value: unknown): ScannedField[] | null {
  if (!Array.isArray(value) || value.length > 400) return null;
  const kinds = new Set(["text", "textarea", "select", "combobox", "radio", "checkbox", "buttons", "file"]);
  const out: ScannedField[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") return null;
    const f = raw as Record<string, unknown>;
    if (typeof f.key !== "string" || typeof f.selector !== "string" || typeof f.kind !== "string" || !kinds.has(f.kind)) return null;
    const options = Array.isArray(f.options) ? f.options : [];
    out.push({
      key: f.key.slice(0, 300),
      kind: f.kind as ScannedField["kind"],
      inputType: typeof f.inputType === "string" ? f.inputType.slice(0, 40) : String(f.kind),
      label: typeof f.label === "string" ? f.label.slice(0, 1000) : "",
      required: f.required === true,
      selector: f.selector.slice(0, 500),
      value: typeof f.value === "string" ? f.value.slice(0, 5000) : "",
      maxLength: typeof f.maxLength === "number" ? f.maxLength : null,
      // Real dropdowns run long (a university list had 3,301 entries); cutting them short loses the answer.
      options: options.slice(0, MAX_OPTIONS).flatMap((o) =>
        o && typeof o === "object" && typeof (o as FieldOption).label === "string"
          ? [{
              label: (o as FieldOption).label.slice(0, 500),
              selector: typeof (o as FieldOption).selector === "string" ? (o as FieldOption).selector : null,
              value: typeof (o as FieldOption).value === "string" ? (o as FieldOption).value : null,
            }]
          : []
      ),
    });
  }
  return out;
}

/**
 * Runs in the person's browser with `(steps, files)`: fills each step and reports what happened. React and
 * other frameworks only notice values set through the native setter plus input/change events. Files come as
 * base64 and are attached with a DataTransfer, as a drop would. Comboboxes (search-as-you-type) get the text
 * typed and the matching option clicked if it's already listed; otherwise they're reported for a person.
 * Must stay plain browser JavaScript (String.raw), like scan.ts.
 */
export const PAGE_FILL_SCRIPT = String.raw`((steps, files) => {
  const clean = (t) => (t || "").replace(/\s+/g, " ").replace(/[*✱]/g, "").trim();
  const norm = (t) => clean(t).toLowerCase();
  const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));
  const setValue = (el, value) => {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    el.focus();
    setter.call(el, value);
    fire(el, "input");
    fire(el, "change");
    el.blur();
  };
  const choose = (opt) => {
    const input = opt && opt.selector ? document.querySelector(opt.selector) : null;
    if (!input) return false;
    if (input.checked) return true;
    const label = input.id ? document.querySelector("label[for='" + CSS.escape(input.id) + "']") : null;
    (label || input).click();
    if (!input.checked && input.type) { input.checked = true; fire(input, "input"); fire(input, "change"); }
    return true;
  };
  const results = [];
  for (const s of steps) {
    const el = document.querySelector(s.selector);
    const done = (status, note) => results.push({ key: s.key, status, note: note || null });
    try {
      if (!el && s.kind !== "radio" && s.kind !== "checkbox" && s.kind !== "buttons") { done("missing", "Field not found"); continue; }
      switch (s.kind) {
        case "file": {
          const f = files && files[s.upload];
          if (!f) { done("skipped", "No " + (s.upload || "file") + " to attach"); break; }
          const bytes = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
          const dt = new DataTransfer();
          dt.items.add(new File([bytes], f.name, { type: f.type || "application/octet-stream" }));
          el.files = dt.files;
          fire(el, "input");
          fire(el, "change");
          done("filled");
          break;
        }
        case "text":
        case "textarea":
          setValue(el, s.answer);
          done("filled");
          break;
        case "select": {
          const opt = Array.from(el.options).find((o) => clean(o.textContent) === s.answer || o.value === s.answer);
          if (!opt) { done("mismatch", "Option not found: " + s.answer); break; }
          setValue(el, opt.value);
          done("filled");
          break;
        }
        case "radio":
        case "checkbox": {
          const wanted = s.kind === "checkbox" && s.options.length > 1 ? s.answer.split(/\s*;\s*/).filter(Boolean) : [s.answer];
          const missing = wanted.filter((w) => !choose(s.options.find((o) => o.label === w)));
          if (missing.length) done("mismatch", "Option not found: " + missing.join(", ")); else done("filled");
          break;
        }
        case "buttons": {
          const opt = s.options.find((o) => o.label === s.answer);
          const btn = opt && opt.selector ? document.querySelector(opt.selector) : null;
          if (!btn) { done("mismatch", "Option not found: " + s.answer); break; }
          btn.click();
          done("filled");
          break;
        }
        case "combobox": {
          setValue(el, s.answer);
          el.focus();
          fire(el, "keydown");
          const options = Array.from(document.querySelectorAll("[role=option]"));
          const hit = options.find((o) => norm(o.textContent) === norm(s.answer)) || (options.length === 1 ? options[0] : null);
          if (hit) { hit.click(); done("filled"); } else done("check", "Typed “" + s.answer + "”; pick it from the list");
          break;
        }
        default:
          done("skipped", "Unsupported field");
      }
    } catch (e) {
      done("mismatch", String(e && e.message || e).slice(0, 200));
    }
  }
  return results;
})`;

/**
 * Application forms embedded from an ATS on a company's own site live in a cross-origin iframe the page's
 * script can't reach; this lists them so the person can open the form itself.
 */
export const ATS_FRAMES_SCRIPT = String.raw`(() => Array.from(document.querySelectorAll("iframe"))
  .map((f) => f.src || "")
  .filter((s) => /greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|smartrecruiters\.com|workable\.com/.test(s))
)()`;
