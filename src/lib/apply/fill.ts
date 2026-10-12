import type { Page } from "playwright";
import { matchOption, resolveField, type ResolveContext, type Resolution } from "./answers";
import { CONFIRM_SCRIPT, type ConfirmationCheck } from "./confirm";
import {
  COMBO_OPTIONS_SCRIPT, SCAN_SCRIPT, SUBMIT_GUARD_OFF, SUBMIT_GUARD_ON, type ScanResult, type ScannedField,
} from "./scan";

/**
 * Form adapter for single-page ATS forms (Greenhouse, Lever, Ashby):
 * inspectForm → resolve → fillFields/uploadResume → readBack. There is
 * deliberately no submit operation here: the filled form is left open for the
 * person to review and submit.
 */

export type Ats = "greenhouse" | "lever" | "ashby";
export const SUPPORTED_ATS: Ats[] = ["greenhouse", "lever", "ashby"];

export function applicationTarget(ats: Ats, tenant: string | null, postingId: string, fallback: string | null): { url: string; hosts: string[] } | null {
  switch (ats) {
    case "greenhouse":
      // The embed address is the bare application form. The regular job page redirects to
      // the employer's own careers site for many companies (e.g. Coinbase), where the form
      // only opens in a new tab.
      return tenant
        ? { url: `https://job-boards.greenhouse.io/embed/job_app?for=${encodeURIComponent(tenant)}&token=${postingId}`, hosts: ["job-boards.greenhouse.io", "boards.greenhouse.io"] }
        : null;
    case "lever":
      return tenant ? { url: `https://jobs.lever.co/${tenant}/${postingId}/apply`, hosts: ["jobs.lever.co", "jobs.eu.lever.co"] } : null;
    case "ashby":
      return tenant ? { url: `https://jobs.ashbyhq.com/${tenant}/${postingId}/application`, hosts: ["jobs.ashbyhq.com"] } : null;
  }
  void fallback;
  return null;
}

export interface FieldReport {
  field: ScannedField;
  resolution: Resolution;
  status: "resolved" | "unknown" | "skipped" | "unsupported" | "filled" | "mismatch";
  readback: string | null;
  note: string | null;
}

export type PrepareOutcome =
  | { kind: "already_submitted"; reports: FieldReport[]; message: string }
  | { kind: "needs_input"; reports: FieldReport[]; message: string }
  | { kind: "blocked"; reports: FieldReport[]; message: string }
  | { kind: "filled"; reports: FieldReport[]; message: string; overwrites: string[] };

export async function scanPage(page: Page): Promise<ScanResult> {
  return (await page.evaluate(SCAN_SCRIPT)) as ScanResult;
}

/** Lists a combobox's options by opening and closing it; types nothing. */
async function comboOptions(page: Page, f: ScannedField): Promise<string[]> {
  const loc = page.locator(f.selector).first();
  try {
    await loc.click({ timeout: 3_000 });
    await page.waitForTimeout(350);
    const opts = (await page.evaluate(COMBO_OPTIONS_SCRIPT)) as string[];
    await page.keyboard.press("Escape");
    return opts;
  } catch {
    return [];
  }
}

const settle = (page: Page, ms = 400) => page.waitForTimeout(ms);

const PLACEHOLDER_OPTION = /^(no (options|results|matches)|loading|searching|type to search|start typing)/i;

/**
 * Waits for a search box's results after typing: they often come from the
 * network (school lists, places). Returns once the list is non-empty and the
 * same on two consecutive looks, or whatever is there at the timeout.
 */
async function waitForOptions(page: Page, timeoutMs = 6_000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let last: string[] = [];
  let stableFor = 0;
  while (Date.now() < deadline) {
    await settle(page, 300);
    const now = ((await page.evaluate(COMBO_OPTIONS_SCRIPT)) as string[]).filter((o) => !PLACEHOLDER_OPTION.test(o));
    stableFor = now.length && now.join("|") === last.join("|") ? stableFor + 1 : 0;
    last = now;
    if (stableFor >= 1) break;
  }
  return last;
}

/** Types into a search box, reads the results, then clears it again. Chooses nothing. */
async function comboSearch(page: Page, f: ScannedField, text: string): Promise<string[]> {
  const loc = page.locator(f.selector).first();
  try {
    await loc.click({ timeout: 3_000 });
    await loc.fill(text);
    const found = await waitForOptions(page);
    await loc.fill("");
    await page.keyboard.press("Escape");
    return found;
  } catch {
    return [];
  }
}
const normText = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Multi-select answers are stored as "A; B". */
export const splitChoices = (answer: string) => answer.split(/\s*;\s*/).map((a) => a.trim()).filter(Boolean);

/** US-style date for date pickers ("May 2027" → 05/01/2027). null if unparseable. */
export function toPickerDate(answer: string): string | null {
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(answer.trim())) return answer.trim();
  const d = new Date(answer);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`;
}

/** Fills one field. Returns a note on failure. */
async function fillOne(page: Page, f: ScannedField, answer: string): Promise<string | null> {
  const loc = page.locator(f.selector).first();
  try {
    switch (f.kind) {
      case "file":
        await loc.setInputFiles(answer);
        return null;
      case "text":
      case "textarea":
        if (f.inputType === "date") {
          const date = toPickerDate(answer);
          if (!date) return `"${answer}" isn't a date the picker understands`;
          await loc.fill(date);
          await page.keyboard.press("Escape"); // close the calendar popup without submitting anything
          return null;
        }
        await loc.fill(answer);
        return null;
      case "buttons": {
        const opt = f.options.find((o) => o.label === answer);
        if (!opt?.selector) return `Option "${answer}" not found`;
        await page.locator(opt.selector).first().click();
        return null;
      }
      case "select":
        await loc.selectOption({ label: answer });
        return null;
      case "radio":
      case "checkbox": {
        // Checkbox groups can take several choices ("A; B").
        for (const choice of f.kind === "checkbox" ? splitChoices(answer) : [answer]) {
          const opt = f.options.find((o) => o.label === choice);
          if (!opt?.selector) return `Option "${choice}" not found`;
          const input = page.locator(opt.selector).first();
          if (await input.isChecked().catch(() => false)) continue;
          try {
            await input.check({ timeout: 3_000 });
          } catch {
            // Styled inputs hide the real control; its label is the clickable part.
            const id = await input.getAttribute("id");
            if (id) await page.locator(`label[for="${id.replace(/"/g, '\\"')}"]`).first().click();
            else await input.check({ force: true });
          }
        }
        return null;
      }
      case "combobox": {
        await loc.click();
        await loc.fill(answer);
        let options = await waitForOptions(page);
        if (!options.length) {
          // Some menus filter on the first word only.
          await loc.fill(answer.split(/\s+/)[0]);
          options = await waitForOptions(page);
        }
        const decline = /^decline$/i.test(answer) ? options.filter((o) => /decline|prefer not|don.?t wish|do not wish|choose not/i.test(o)) : [];
        let pick = decline.length === 1 ? decline[0] : matchOption(answer, options);
        // Place search ("Ann Arbor, MI" → "Ann Arbor, Michigan, United States"): accept the
        // suggestion only when exactly one starts with the same city.
        if (!pick && answer.includes(",")) {
          const city = normText(answer.split(",")[0]);
          const hits = options.filter((o) => normText(o).startsWith(`${city},`));
          if (hits.length === 1) pick = hits[0];
        }
        if (!pick) {
          await page.keyboard.press("Escape");
          await loc.fill("");
          return options.length
            ? `No option clearly matches "${answer}" (options include: ${options.slice(0, 6).join(", ")})`
            : `No options appeared for "${answer}"`;
        }
        await page.getByRole("option", { name: pick, exact: true }).first().click();
        return null;
      }
    }
  } catch (err) {
    return err instanceof Error ? err.message.split("\n")[0].slice(0, 200) : String(err);
  }
  return null;
}

/** Does the page now show what we meant to enter? */
function matches(f: ScannedField, expected: string, fileName: string | null): boolean {
  const shown = normText(f.value);
  if (f.kind === "checkbox" && f.options.length > 1) {
    const want = new Set(splitChoices(expected).map(normText));
    const have = new Set(splitChoices(f.value).map(normText));
    return [...want].every((w) => have.has(w));
  }
  if (f.inputType === "date") {
    const a = new Date(f.value), b = new Date(toPickerDate(expected) ?? expected);
    return !Number.isNaN(a.getTime()) && a.toDateString() === b.toDateString();
  }
  if (f.kind === "combobox" && expected.includes(",") && shown.startsWith(normText(expected.split(",")[0]))) return true;
  if (f.kind === "file") return !!fileName && shown.includes(normText(fileName));
  if (f.kind === "combobox") return shown.length > 0 && (shown.includes(normText(expected)) || normText(expected).includes(shown));
  if (f.kind === "text" && f.inputType === "tel") return shown.replace(/\D/g, "").endsWith(expected.replace(/\D/g, "").slice(-7));
  return shown === normText(expected);
}

export interface PrepareInput {
  page: Page;
  ctx: ResolveContext;
  /** Filename the uploaded resume should show (the employer sees it). */
  resumeFileName: string | null;
  /** Called before each external action; true = stop now. */
  stopRequested: () => boolean;
  /** How long to let the site's resume parser run after upload. */
  parserWaitMs?: number;
  /** The application page; a reused tab showing no form is reloaded to it once. */
  url?: string;
  /** How long to wait for a form to render (ms). */
  formWaitMs?: number;
  /** Called when the form turns out to live in a new tab (Apply opened one); that tab becomes the job's tab. */
  adoptPage?: (page: Page) => void;
}

/** Scans until the form has rendered (React forms appear after load), or the time runs out. */
async function waitForForm(page: Page, timeoutMs: number): Promise<ScanResult> {
  const deadline = Date.now() + timeoutMs;
  let scan = await scanPage(page).catch(() => ({ fields: [], blockers: [], hasApplyButton: false }) as ScanResult);
  while (!scan.fields.length && !scan.hasApplyButton && !scan.blockers.length && Date.now() < deadline) {
    await settle(page, 500);
    scan = await scanPage(page).catch(() => scan);
  }
  return scan;
}

export async function prepareApplication(input: PrepareInput): Promise<PrepareOutcome> {
  const { ctx } = input;
  let page = input.page;
  let scan = await waitForForm(page, input.formWaitMs ?? 10_000);
  if (!scan.fields.length && !scan.hasApplyButton && !scan.blockers.length) {
    // A reused tab may be on another page — or on the site's own "thank you" page.
    const done = (await page.evaluate(CONFIRM_SCRIPT).catch(() => null)) as ConfirmationCheck | null;
    if (done?.confirmed) return { kind: "already_submitted", reports: [], message: done.snippet ?? "The site shows the application as submitted" };
    if (input.url) {
      await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      scan = await waitForForm(page, input.formWaitMs ?? 10_000);
    }
  }
  if (scan.hasApplyButton) {
    // "Apply" may reveal the form here, navigate, or open the ATS in a new tab.
    const popup = page.context().waitForEvent("page", { timeout: 6_000 }).catch(() => null);
    const name = /^apply( for this job| now| to this job)?$/i;
    await page.getByRole("button", { name }).first().click({ timeout: 3_000 }).catch(() =>
      page.getByRole("link", { name }).first().click({ timeout: 3_000 }).catch(() => {})
    );
    const opened = await popup;
    if (opened) {
      await opened.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => {});
      await opened.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      const inNewTab = await waitForForm(opened, input.formWaitMs ?? 10_000);
      if (inNewTab.fields.length) {
        const old = page;
        page = opened;
        input.adoptPage?.(opened);
        await old.close().catch(() => {}); // the careers page is no longer needed
      }
    } else {
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    }
    scan = await waitForForm(page, input.formWaitMs ?? 10_000);
  }
  if (scan.blockers.length) return { kind: "blocked", reports: [], message: scan.blockers.join("; ") };
  if (!scan.fields.length) return { kind: "blocked", reports: [], message: `No application form appeared on ${page.url()}, even after reloading` };

  const resolveAll = async (fields: ScannedField[]) => {
    const out: FieldReport[] = [];
    for (const f of fields) {
      if (f.kind === "combobox" && !f.options.length) {
        f.options = (await comboOptions(page, f)).map((label) => ({ label, selector: null, value: null }));
      }
      let r = resolveField(f, ctx);
      // A search box's first page of options (e.g. the first 100 schools) may not include
      // the value at all: search for it, then decide against the real results.
      if (f.kind === "combobox" && r.status === "unknown" && r.intended) {
        const found = await comboSearch(page, f, r.intended);
        if (found.length) {
          f.options = found.map((label) => ({ label, selector: null, value: null }));
          r = resolveField(f, ctx);
          if (r.status === "unknown" && found.length > 1) r = { ...r, note: `Several results for "${r.intended}"; pick the right one` };
        }
      }
      out.push({ field: f, resolution: r, status: r.status, readback: null, note: r.note ?? null });
    }
    return out;
  };

  // Everything we can answer is filled now; unanswered questions are left blank
  // and reported, so the person only has those left to do.
  let reports = await resolveAll(scan.fields);

  await page.evaluate(SUBMIT_GUARD_ON);
  const overwrites: string[] = [];
  try {
    // Resume first: ATS parsers autofill from it, and we want to overwrite that, not the reverse.
    const order = [...reports].sort((a, b) => Number(b.field.kind === "file") - Number(a.field.kind === "file"));
    for (const rep of order) {
      if (rep.status !== "resolved" || !rep.resolution.answer) continue;
      if (input.stopRequested()) return { kind: "blocked", reports, message: "Stopped by request" };
      const note = await fillOne(page, rep.field, rep.resolution.answer);
      if (note) {
        rep.status = "mismatch";
        rep.note = note;
      } else {
        rep.status = "filled";
      }
      if (rep.field.kind === "file") await settle(page, input.parserWaitMs ?? 4_000);
      // Choices can reveal follow-up questions; resolve any that appeared.
      if (["select", "radio", "checkbox", "combobox", "buttons"].includes(rep.field.kind)) {
        await settle(page, 300);
        const fresh = (await scanPage(page)).fields.filter((f) => !reports.some((r) => r.field.key === f.key));
        if (fresh.length) {
          const added = await resolveAll(fresh);
          reports = [...reports, ...added];
          order.push(...added);
        }
      }
    }
    // Read back everything; re-enter anything a resume parser or script changed.
    await settle(page, 1_000);
    for (let pass = 0; pass < 2; pass++) {
      const now = new Map((await scanPage(page)).fields.map((f) => [f.key, f]));
      let refilled = false;
      for (const rep of reports) {
        if (rep.status !== "filled" && rep.status !== "mismatch") continue;
        const shown = now.get(rep.field.key);
        rep.readback = shown ? shown.value : null;
        if (!shown) {
          rep.status = "mismatch";
          rep.note = "Field disappeared after filling";
          continue;
        }
        if (matches(shown, rep.resolution.answer!, input.resumeFileName)) {
          rep.status = "filled";
          continue;
        }
        if (pass === 0 && rep.field.kind !== "file") {
          overwrites.push(rep.field.label);
          const note = await fillOne(page, shown, rep.resolution.answer!);
          if (!note) refilled = true;
          rep.note = note ?? "Changed by the page after filling (e.g. resume parser); re-entered";
        } else {
          rep.status = "mismatch";
          rep.note = rep.note ?? `Page shows "${shown.value.slice(0, 80)}"`;
        }
      }
      if (!refilled) break;
      await settle(page, 800);
    }
  } finally {
    await page.evaluate(SUBMIT_GUARD_OFF).catch(() => {});
  }

  const bad = reports.filter((r) => r.status === "mismatch");
  const manual = reports.filter((r) => r.status === "unsupported" && r.field.required);
  const missing = reports.filter((r) => r.status === "unknown");
  if (missing.length) {
    const filled = reports.filter((r) => r.status === "filled").length;
    const n = missing.length;
    return {
      kind: "needs_input", reports,
      message: `Filled ${filled} field${filled === 1 ? "" : "s"}; ${n} question${n === 1 ? "" : "s"} still need${n === 1 ? "s" : ""} your answer${bad.length ? ` and ${bad.length} need${bad.length === 1 ? "s" : ""} checking` : ""}`,
    };
  }
  if (manual.length) {
    return { kind: "blocked", reports, message: `Everything else is filled; do these yourself in the browser: ${manual.map((r) => r.field.label).join(", ")}` };
  }
  if (bad.length) {
    return { kind: "blocked", reports, message: `${bad.length} field${bad.length === 1 ? "" : "s"} didn't take the intended value; check them in the browser` };
  }
  return { kind: "filled", reports, message: "Form filled and read back", overwrites };
}
