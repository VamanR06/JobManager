import fs from "fs";
import path from "path";
import type { Page } from "playwright";
import { ARTIFACTS_DIR, DATA_DIR, getDb, WORK_DIR } from "../db";
import { getDocument, getJob } from "../queries";
import { getProfileMap } from "../profile";
import { logEvent, markSubmitted } from "../submission";
import { matchOption } from "./answers";
import { BrowserOwner, hostAllowed, PROFILE_DIR } from "./browser";
import { CONFIRM_SCRIPT, type ConfirmationCheck } from "./confirm";
import { applicationTarget, prepareApplication, SUPPORTED_ATS, type Ats } from "./fill";
import { COMBO_OPTIONS_SCRIPT } from "./scan";
import { FLAGGED_SCRIPT, locateRef, requiredEmpty, SUBMIT_TEXT, takeSnapshot, type PageSnapshot } from "./snapshot";
import { accountPassword, createAccount, findAccount } from "./vault";

/**
 * The browser harness behind the ChatGPT browser tools (mcp-browser.ts).
 * ChatGPT is the agent: it reads a snapshot, then asks for one action at a
 * time (click, type, choose, upload…), and gets a fresh snapshot back.
 *
 * It runs inside the web server, so it works on a headless server. It has its
 * own browser profile and a navigation guard: each job's tab may only go to
 * that job's own sites and known ATS domains.
 *
 * Rules it enforces, whatever the model asks:
 *  - Passwords are generated and stored in the vault and typed straight into
 *    password fields; they're never returned. browser_type refuses password fields.
 *  - Final submission only goes through submit(): a click on a button labelled
 *    "Submit…" is refused. submit() checks required fields, persists the attempt
 *    and a payload snapshot, refuses to resubmit, and counts it as submitted only
 *    when the site confirms it (confirm.ts). Anything else is submission_unknown.
 *  - CAPTCHAs and bot checks are reported, never worked around.
 */

export class HarnessError extends Error {}

const TAB_CLOSED =
  "The application's browser tab has closed (it closes after a few idle minutes). Ask ChatGPT to open it again; the site may send a new code.";

/** What the person can do from the job page's Take over panel. Coordinates are CSS pixels in the view. */
export type TakeOverInput =
  | { kind: "click"; x: number; y: number }
  | { kind: "type"; text: string }
  | { kind: "key"; key: TakeOverKey }
  | { kind: "scroll"; dy: number; x?: number; y?: number };
export const TAKE_OVER_KEYS = ["Enter", "Tab", "Shift+Tab", "Backspace", "Escape", "Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"] as const;
export type TakeOverKey = (typeof TAKE_OVER_KEYS)[number];

/** Labels of verification-code fields ("Security code", "Enter the code we sent", "One-time passcode"…). */
const CODE_LABEL = /\b(security|verification|confirmation|one[- ]?time|access)\b.*\bcode\b|\bcode\b.*\b(sent|emailed|texted)\b|\b(otp|passcode|pin)\b|^code$|enter (the|your) code/i;
/** Page text asking for such a code. */
const CODE_REQUEST = /(security|verification|confirmation|one[- ]?time) code|code (we|was) (sent|emailed)|enter the code/i;

/** ATS vendors whose subdomains host many employers' application portals. */
const ATS_DOMAINS = [
  ".greenhouse.io", ".lever.co", ".ashbyhq.com", ".myworkdayjobs.com", ".myworkdaysite.com", ".myworkday.com",
  ".icims.com", ".smartrecruiters.com", ".jobvite.com", ".taleo.net", ".successfactors.com", ".successfactors.eu",
  ".workable.com", ".bamboohr.com", ".recruitee.com", ".breezy.hr", ".applytojob.com", ".paylocity.com",
  ".ultipro.com", ".rippling-ats.com", ".teamtailor.com", ".eightfold.ai", ".avature.net", ".phenompeople.com",
];

function extraHosts(): string[] {
  return (process.env.JOBMANAGER_BROWSER_EXTRA_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
}

const hostOf = (u: string | null | undefined): string | null => {
  if (!u) return null;
  try {
    const url = new URL(u);
    return /^https?:$/.test(url.protocol) ? url.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
};

interface JobTarget {
  jobId: number;
  company: string;
  /** Where browser_open goes by default. */
  url: string | null;
  hosts: string[];
}

function jobTarget(jobId: number): JobTarget {
  const job = getJob(jobId);
  if (!job) throw new HarnessError(`No application with id ${jobId}.`);
  const meta = getDb().prepare("SELECT ats, ats_tenant, posting_id, application_url FROM jobs WHERE id = ?").get(jobId) as {
    ats: string | null; ats_tenant: string | null; posting_id: string | null; application_url: string | null;
  };
  const ats = meta.ats && SUPPORTED_ATS.includes(meta.ats as Ats) && meta.posting_id
    ? applicationTarget(meta.ats as Ats, meta.ats_tenant, meta.posting_id, meta.application_url)
    : null;
  const own = [hostOf(job.url), hostOf(meta.application_url), ...(ats?.hosts ?? [])].filter((h): h is string => !!h);
  return {
    jobId, company: job.company,
    url: ats?.url ?? meta.application_url ?? job.url,
    hosts: [...new Set([...own, ...ATS_DOMAINS, ...extraHosts()])],
  };
}

export interface ActionResult {
  snapshot: PageSnapshot;
  /** What happened, in a sentence, when there's something to say. */
  note?: string;
  [extra: string]: unknown;
}

const settle = async (page: Page, ms = 3_000) => {
  await page.waitForLoadState("domcontentloaded", { timeout: ms }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: ms }).catch(() => {});
};

const firstLine = (err: unknown) => (err instanceof Error ? err.message.split("\n")[0] : String(err)).slice(0, 240);

export class Harness {
  /** One action at a time per application, so two tool calls can't interleave on a tab. */
  private locks = new Map<number, Promise<unknown>>();
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(
    private browser: BrowserOwner,
    private opts: { idleCloseMs?: number; maxTabs?: number } = {},
  ) {}

  /** When each application's tab was last used, for closing the oldest. */
  private lastUsed = new Map<number, number>();

  /** Closes the least recently used other applications' tabs beyond maxTabs. */
  private async trimTabs(keep: number) {
    const max = this.opts.maxTabs;
    if (!max) return;
    const others = this.browser.openPages()
      .filter(([id]) => id !== keep && !this.locks.has(id))
      .sort(([a], [b]) => (this.lastUsed.get(a) ?? 0) - (this.lastUsed.get(b) ?? 0));
    for (const [id, page] of others.slice(0, Math.max(0, others.length - (max - 1)))) {
      await page.close().catch(() => {});
      this.lastUsed.delete(id);
    }
  }

  private async locked<T>(jobId: number, fn: () => Promise<T>): Promise<T> {
    this.lastUsed.set(jobId, Date.now());
    const prev = this.locks.get(jobId) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    this.locks.set(jobId, run);
    try {
      return await run;
    } finally {
      if (this.locks.get(jobId) === run) this.locks.delete(jobId);
      this.touch();
    }
  }

  /** Closes the browser after a while unused, so an idle server doesn't hold a Chromium. */
  private touch() {
    const ms = this.opts.idleCloseMs;
    if (!ms) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.browser.close(), ms);
    this.idleTimer.unref?.();
  }

  private page(jobId: number): Page {
    const page = this.browser.existingPage(jobId);
    if (!page) throw new HarnessError("No browser tab is open for this application; call browser_open first.");
    return page;
  }

  private async withSnapshot(page: Page, extra: Omit<ActionResult, "snapshot"> = {}): Promise<ActionResult> {
    return { ...extra, snapshot: await takeSnapshot(page) };
  }

  /** Records a submission the site confirmed (receipt screenshot + Applied entry). */
  private async recordConfirmed(jobId: number, page: Page, check: ConfirmationCheck, how: string): Promise<string | null> {
    let receipt: string | null = null;
    try {
      const dir = path.join(ARTIFACTS_DIR, `job-${jobId}`);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, `receipt-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
      await page.screenshot({ path: file, fullPage: true });
      receipt = path.relative(DATA_DIR, file);
    } catch {
      // a missing screenshot doesn't undo a confirmed submission
    }
    markSubmitted(jobId, { how: "confirmation_page", detail: `${how}: ${page.url()} :: ${check.snippet ?? ""}`, receipt });
    return receipt;
  }

  private async blockedSince(before: number): Promise<string[]> {
    return this.browser.blockedNavigations.slice(before).map((u) => hostOf(u) ?? u);
  }

  /** Where a job's tab is and which browser it runs, for error logs. Never throws. */
  async debugInfo(jobId: number): Promise<{ url: string | null; browser: string | null }> {
    const page = this.browser.existingPage(jobId);
    if (!page) return { url: null, browser: null };
    const ua = (await Promise.race([
      page.evaluate("navigator.userAgent").catch(() => null),
      new Promise((r) => setTimeout(() => r(null), 2_000)),
    ])) as string | null;
    return { url: page.url(), browser: ua?.match(/(Headless)?Chrom(e|ium)\/[\d.]+/)?.[0] ?? ua };
  }

  /** Whether this application has a browser tab open (e.g. waiting for a verification code). */
  hasTab(jobId: number): boolean {
    return this.browser.hasPage(jobId);
  }

  // ---------- actions ----------

  open(jobId: number, url?: string): Promise<ActionResult> {
    return this.locked(jobId, async () => {
      const target = jobTarget(jobId);
      const go = url ?? target.url;
      if (!go) throw new HarnessError("This application has no posting URL; pass url.");
      const host = hostOf(go);
      if (!host) throw new HarnessError("url must be an http(s) address.");
      if (!hostAllowed(target.hosts, host)) {
        throw new HarnessError(
          `${host} isn't this application's site or a known ATS. Allowed: the posting's own hosts (${target.hosts.filter((h) => !h.startsWith(".")).join(", ") || "none"}) and ATS domains. Ask the user to set the job's URL to the application page, or add the host to JOBMANAGER_BROWSER_EXTRA_HOSTS.`
        );
      }
      const existing = this.browser.existingPage(jobId);
      if (!existing) await this.trimTabs(jobId);
      const page = await this.browser.pageFor(jobId, go, target.hosts, !!url && !!existing);
      await settle(page);
      const email = getProfileMap().email;
      const account = email ? findAccount(new URL(page.url()).hostname, email) : null;
      return this.withSnapshot(page, {
        note: existing && !url ? "Reused the tab already open for this application." : undefined,
        account_on_file: !!account,
      });
    });
  }

  snapshot(jobId: number): Promise<ActionResult> {
    return this.locked(jobId, async () => this.withSnapshot(this.page(jobId)));
  }

  /**
   * Screenshots the tab and saves it in data/artifacts/job-<id>/ (the latest
   * 20 are kept), so the person can open it from a link.
   */
  screenshot(jobId: number): Promise<{ png: Buffer; url: string; file: string }> {
    return this.locked(jobId, async () => {
      const page = this.page(jobId);
      const png = await page.screenshot({ type: "png" });
      const dir = path.join(ARTIFACTS_DIR, `job-${jobId}`);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = `screenshot-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
      fs.writeFileSync(path.join(dir, file), png, { mode: 0o600 });
      const old = fs.readdirSync(dir).filter((f) => /^screenshot-.*\.png$/.test(f)).sort().slice(0, -20);
      for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
      return { png, url: page.url(), file };
    });
  }

  navigate(jobId: number, url: string): Promise<ActionResult> {
    return this.locked(jobId, async () => {
      const page = this.page(jobId);
      const host = hostOf(url);
      if (!host || !hostAllowed(this.browser.allowedHosts(page), host)) {
        throw new HarnessError(`Can't go to ${host ?? url}: it isn't this application's site or a known ATS.`);
      }
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await settle(page);
      return this.withSnapshot(page);
    });
  }

  private async mustLocate(page: Page, ref: string) {
    const found = await locateRef(page, ref);
    if (!found) throw new HarnessError(`No element ${ref} on the page now; take a new snapshot.`);
    return found;
  }

  click(jobId: number, ref: string): Promise<ActionResult> {
    return this.locked(jobId, async () => {
      let page = this.page(jobId);
      const { loc } = await this.mustLocate(page, ref);
      const text = await loc.evaluate((el) =>
        ((el as HTMLElement).innerText || (el as HTMLInputElement).value || el.getAttribute("aria-label") || "").trim()
      );
      if (SUBMIT_TEXT.test(text)) {
        throw new HarnessError(`"${text.slice(0, 60)}" submits the application. Use submit_application for that (after the user confirms).`);
      }
      const blockedBefore = this.browser.blockedNavigations.length;
      const popup = page.context().waitForEvent("page", { timeout: 2_500 }).catch(() => null);
      await loc.click({ timeout: 8_000 });
      const opened = await popup;
      let note: string | undefined;
      if (opened && !opened.isClosed()) {
        await settle(opened, 8_000);
        this.browser.adopt(jobId, opened, [...this.browser.allowedHosts(page)]);
        page = opened;
        note = "That opened a new tab; it's now this application's tab.";
      } else {
        await settle(page);
      }
      const blocked = await this.blockedSince(blockedBefore);
      if (blocked.length) {
        note = `Blocked navigation to ${[...new Set(blocked)].join(", ")}: not this application's site.`;
        // A blocked navigation leaves Chrome's error page in the tab; go back to where we were.
        if (page.url().startsWith("chrome-error:")) {
          await page.goBack({ waitUntil: "domcontentloaded", timeout: 10_000 }).catch(() => {});
          await settle(page);
        }
      }
      const check = (await page.evaluate(CONFIRM_SCRIPT).catch(() => null)) as ConfirmationCheck | null;
      if (check?.confirmed) {
        await this.recordConfirmed(jobId, page, check, "Confirmation seen after a ChatGPT click");
        note = `The site now shows a confirmation ("${check.snippet}"); recorded as submitted.`;
      }
      return this.withSnapshot(page, { note });
    });
  }

  // ---------- take over (the person, from the job page) ----------

  /**
   * What the tab shows right now, for the job page's Take over panel: a JPEG of
   * the visible part of the page and its size in CSS pixels (clicks use the same).
   */
  view(jobId: number): Promise<{ jpeg: Buffer; width: number; height: number; url: string }> {
    return this.locked(jobId, async () => {
      const page = this.browser.existingPage(jobId);
      if (!page) throw new HarnessError(TAB_CLOSED);
      const size = page.viewportSize() ?? ((await page.evaluate("({ width: innerWidth, height: innerHeight })")) as { width: number; height: number });
      return { jpeg: await page.screenshot({ type: "jpeg", quality: 60 }), width: size.width, height: size.height, url: page.url() };
    });
  }

  /**
   * One input from the person taking over: a click at a point on the view,
   * typed text, a key, or a scroll. The navigation guard still applies. If it
   * leads to the site's confirmation, that's recorded like any submission.
   */
  takeOver(jobId: number, input: TakeOverInput): Promise<{ url: string; note?: string }> {
    return this.locked(jobId, async () => {
      let page = this.browser.existingPage(jobId);
      if (!page) throw new HarnessError(TAB_CLOSED);
      const popup = input.kind === "click" ? page.context().waitForEvent("page", { timeout: 1_500 }).catch(() => null) : null;
      switch (input.kind) {
        case "click":
          await page.mouse.click(input.x, input.y);
          break;
        case "type":
          await page.keyboard.type(input.text, { delay: 30 });
          break;
        case "key":
          await page.keyboard.press(input.key);
          break;
        case "scroll":
          await page.mouse.move(input.x ?? 640, input.y ?? 450);
          await page.mouse.wheel(0, input.dy);
          break;
      }
      const opened = popup && (await popup);
      if (opened && !opened.isClosed()) {
        this.browser.adopt(jobId, opened, [...this.browser.allowedHosts(page)]);
        page = opened;
      }
      await page.waitForTimeout(300);
      const check = (await page.evaluate(CONFIRM_SCRIPT).catch(() => null)) as ConfirmationCheck | null;
      const state = (getDb().prepare("SELECT workflow_state FROM jobs WHERE id = ?").get(jobId) as { workflow_state: string | null } | undefined)?.workflow_state;
      if (check?.confirmed && state !== "submitted") {
        await this.recordConfirmed(jobId, page, check, "Submitted by the user through Take over");
        return { url: page.url(), note: "The site confirmed the submission; it's recorded as submitted." };
      }
      return { url: page.url() };
    });
  }

  /**
   * Types a verification code the person got by email/text into the page
   * (one field, or one box per character). Called from the job page, so the
   * code never passes through ChatGPT. Doesn't submit.
   */
  enterCode(jobId: number, code: string): Promise<ActionResult> {
    return this.locked(jobId, async () => {
      const page = this.browser.existingPage(jobId);
      if (!page) throw new HarnessError(TAB_CLOSED);
      const snap = await takeSnapshot(page);
      const fields = snap.elements.filter((e) =>
        ["text", "number", "tel", "textbox"].includes(e.kind) && !e.disabled && CODE_LABEL.test(e.label)
      );
      if (!fields.length) throw new HarnessError("No verification-code field is showing on the page. If the site asked for one, ask ChatGPT for a screenshot link to check.");
      if (fields.length > 1 && fields.length === code.length) {
        for (let i = 0; i < code.length; i++) await (await this.mustLocate(page, fields[i].ref)).loc.fill(code[i], { timeout: 5_000 });
      } else if (fields.length > 1) {
        // Boxes that don't match the code's length: type it and let the site move between boxes.
        const { loc } = await this.mustLocate(page, fields[0].ref);
        await loc.click({ timeout: 5_000 });
        await page.keyboard.type(code, { delay: 50 });
      } else {
        await (await this.mustLocate(page, fields[0].ref)).loc.fill(code, { timeout: 5_000 });
      }
      await page.waitForTimeout(500);
      logEvent(jobId, "chatgpt:verification_code", `Entered on the job page into ${fields.length} field${fields.length === 1 ? "" : "s"}`);
      return this.withSnapshot(page, { note: "Verification code entered. Now call submit_application again." });
    });
  }

  type(jobId: number, ref: string, text: string): Promise<ActionResult> {
    return this.locked(jobId, async () => {
      const page = this.page(jobId);
      const { loc } = await this.mustLocate(page, ref);
      const kind = await loc.evaluate((el) => (el.getAttribute("type") || el.tagName).toLowerCase());
      if (kind === "password") throw new HarnessError("Password fields are filled only by portal_credentials.");
      if (kind === "file") throw new HarnessError("That's a file field; use browser_upload.");
      if (kind === "select") throw new HarnessError("That's a dropdown; use browser_choose.");
      await loc.fill(text, { timeout: 8_000 });
      await page.waitForTimeout(300);
      return this.withSnapshot(page);
    });
  }

  choose(jobId: number, ref: string, option: string): Promise<ActionResult> {
    return this.locked(jobId, async () => {
      const page = this.page(jobId);
      const { frame, loc } = await this.mustLocate(page, ref);
      const info = await loc.evaluate((el) => ({
        tag: el.tagName,
        type: (el.getAttribute("type") || "").toLowerCase(),
        role: el.getAttribute("role") || "",
        options: el.tagName === "SELECT" ? Array.from((el as HTMLSelectElement).options).map((o) => o.textContent?.trim() ?? "") : [],
      }));
      if (info.tag === "SELECT") {
        const pick = info.options.find((o) => o.toLowerCase() === option.trim().toLowerCase()) ?? matchOption(option, info.options.filter(Boolean));
        if (!pick) throw new HarnessError(`No option clearly matches "${option}". Options: ${info.options.filter(Boolean).slice(0, 40).join(" | ")}`);
        await loc.selectOption({ label: pick });
        await page.waitForTimeout(300);
        return this.withSnapshot(page, { note: `Selected "${pick}".` });
      }
      if (info.type === "checkbox" || info.type === "radio" || info.role === "checkbox" || info.role === "switch") {
        const on = !/^(unchecked|off|no|false)$/i.test(option.trim());
        if (on) await loc.check({ timeout: 5_000 }).catch(() => loc.click({ timeout: 5_000, force: true }));
        else await loc.uncheck({ timeout: 5_000 }).catch(() => loc.click({ timeout: 5_000, force: true }));
        return this.withSnapshot(page);
      }
      // A search-as-you-type dropdown: type, wait for the list, click the matching option.
      await loc.click({ timeout: 5_000 });
      await loc.fill(option).catch(() => page.keyboard.type(option));
      let options: string[] = [];
      for (let i = 0, last = ""; i < 15; i++) {
        await page.waitForTimeout(300);
        options = ((await frame.evaluate(COMBO_OPTIONS_SCRIPT).catch(() => [])) as string[]).filter((o) => !/^(no (options|results)|loading|searching)/i.test(o));
        if (options.length && options.join("|") === last) break;
        last = options.join("|");
      }
      const pick = options.find((o) => o.toLowerCase() === option.trim().toLowerCase()) ?? matchOption(option, options);
      if (!pick) {
        await page.keyboard.press("Escape");
        return this.withSnapshot(page, {
          note: options.length
            ? `No option clearly matches "${option}". Call browser_choose again with one of these exactly.`
            : `No options appeared for "${option}". Try a shorter search.`,
          options: options.slice(0, 40),
        });
      }
      await frame.getByRole("option", { name: pick, exact: true }).first().click({ timeout: 5_000 });
      await page.waitForTimeout(300);
      return this.withSnapshot(page, { note: `Chose "${pick}".` });
    });
  }

  /** The file to upload, copied under the name the employer will see. */
  private stageFile(jobId: number, opts: { documentId?: number; kind?: "resume" | "cover_letter" }): { file: string; name: string } {
    const job = getJob(jobId)!;
    let src: string, name: string;
    if (opts.documentId !== undefined) {
      const doc = getDocument(opts.documentId);
      if (!doc) throw new HarnessError(`No document with id ${opts.documentId}; see list_documents.`);
      src = path.join(DATA_DIR, doc.file_path);
      name = path.extname(doc.name) ? doc.name : `${doc.name}${path.extname(doc.file_path)}`;
    } else if ((opts.kind ?? "resume") === "resume") {
      const doc = job.resume_id ? getDocument(job.resume_id) : null;
      if (!doc) throw new HarnessError("This application has no resume linked: link one (update_application resume_id, or upload_document with application_id), or pass document_id.");
      src = path.join(DATA_DIR, doc.file_path);
      name = path.extname(doc.name) ? doc.name : `${doc.name}${path.extname(doc.file_path)}`;
    } else {
      const doc = job.cover_letter_id ? getDocument(job.cover_letter_id) : null;
      if (!doc) throw new HarnessError("This application has no cover letter linked; pass document_id.");
      src = path.join(DATA_DIR, doc.file_path);
      name = path.extname(doc.name) ? doc.name : `${doc.name}${path.extname(doc.file_path)}`;
    }
    if (!fs.existsSync(src)) throw new HarnessError(`The file for "${name}" is missing on the server.`);
    const dir = path.join(WORK_DIR, "uploads", `job-${jobId}`);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, name.replace(/[^\w.\-() ]+/g, "_"));
    // Artifacts are read-only (0400) and copies keep the mode: replace, then make it ours.
    fs.rmSync(file, { force: true });
    fs.copyFileSync(src, file);
    fs.chmodSync(file, 0o600);
    return { file, name: path.basename(file) };
  }

  upload(jobId: number, ref: string, opts: { documentId?: number; kind?: "resume" | "cover_letter" }): Promise<ActionResult> {
    return this.locked(jobId, async () => {
      const page = this.page(jobId);
      const { file, name } = this.stageFile(jobId, opts);
      const { loc } = await this.mustLocate(page, ref);
      const isFileInput = await loc.evaluate((el) => el.tagName === "INPUT" && (el as HTMLInputElement).type === "file");
      if (isFileInput) {
        await loc.setInputFiles(file);
      } else {
        // An "Upload" button that opens the file picker.
        const chooser = page.waitForEvent("filechooser", { timeout: 6_000 });
        await loc.click({ timeout: 5_000 });
        await (await chooser).setFiles(file);
      }
      await settle(page, 5_000); // let the site's resume parser run
      logEvent(jobId, "chatgpt:upload", name);
      return this.withSnapshot(page, { note: `Uploaded ${name}. Parsers may have changed other fields; check them.` });
    });
  }

  /** Fills everything the Profile and answer bank answer (apply/answers.ts rules). */
  autofill(jobId: number): Promise<ActionResult> {
    return this.locked(jobId, async () => {
      const page = this.page(jobId);
      const job = getJob(jobId)!;
      let resume: { file: string; name: string } | null = null;
      try {
        resume = this.stageFile(jobId, { kind: "resume" });
      } catch {
        // no resume: file questions are just left for the model / person
      }
      const cover = job.cover_letter_id ? (() => { try { return this.stageFile(jobId, { kind: "cover_letter" }).file; } catch { return null; } })() : null;
      const hosts = [...this.browser.allowedHosts(page)];
      const outcome = await prepareApplication({
        page, resumeFileName: resume?.name ?? null, stopRequested: () => false, formWaitMs: 5_000,
        adoptPage: (p) => this.browser.adopt(jobId, p, hosts),
        ctx: { profile: getProfileMap(), company: job.company, jobId, resumePath: resume?.file ?? null, coverLetterPath: cover },
      });
      logEvent(jobId, `chatgpt:autofill:${outcome.kind}`, outcome.message);
      return this.withSnapshot(this.page(jobId), {
        note: outcome.message,
        outcome: outcome.kind,
        fields: outcome.reports.map((r) => ({
          label: r.field.label, status: r.status, ...(r.resolution.answer && r.field.kind !== "file" && { answer: r.resolution.answer.slice(0, 200) }),
          ...(r.note && { note: r.note }), ...(r.field.required && { required: true }),
        })),
      });
    });
  }

  /**
   * Signs up or signs in on the portal now showing, with the Profile email and
   * a password from the vault. The password is typed into the page, never returned.
   */
  credentials(jobId: number, mode: "create" | "sign_in", opts: { emailRef?: string; passwordRefs?: string[]; replace?: boolean } = {}): Promise<ActionResult> {
    return this.locked(jobId, async () => {
      const page = this.page(jobId);
      const email = getProfileMap().email?.trim();
      if (!email) throw new HarnessError("Add your email on the Profile page first; accounts are made with it.");
      const host = new URL(page.url()).hostname.toLowerCase();
      const snap = await takeSnapshot(page);
      const passwordRefs = opts.passwordRefs?.length ? opts.passwordRefs : snap.elements.filter((e) => e.kind === "password" && !e.disabled).map((e) => e.ref);
      if (!passwordRefs.length) throw new HarnessError("No password field on the page now.");
      const emailRef = opts.emailRef ?? snap.elements.find((e) =>
        e.kind === "email" || ((e.kind === "text" || e.kind === "combobox") && /e-?mail|user ?(name|id)|login/i.test(e.label))
      )?.ref;

      let password: string;
      let created = false;
      if (mode === "create") {
        ({ password } = createAccount(host, email, jobId, opts.replace));
        created = true;
      } else {
        const saved = accountPassword(host, email);
        if (!saved) throw new HarnessError(`No saved password for ${email} on ${host}. If there's no account yet, use mode "create"; otherwise the user signs in themselves.`);
        password = saved;
      }

      const filled: string[] = [];
      if (emailRef) {
        const { loc } = await this.mustLocate(page, emailRef);
        await loc.fill(email, { timeout: 8_000 });
        filled.push("email");
      }
      for (const ref of passwordRefs) {
        const { loc } = await this.mustLocate(page, ref);
        const isPassword = await loc.evaluate((el) => (el.getAttribute("type") || "").toLowerCase() === "password");
        if (!isPassword) throw new HarnessError(`${ref} isn't a password field.`);
        await loc.fill(password, { timeout: 8_000 });
        filled.push("password");
      }
      logEvent(jobId, `chatgpt:credentials:${mode}`, `${email} on ${host}`);
      return this.withSnapshot(page, {
        note: `${created ? "Generated and saved a new password" : "Used the saved password"} for ${email} on ${host}; filled ${filled.join(", ")}. ${emailRef ? "" : "No email field was found; fill it with browser_type if needed. "}Now click the sign-up / sign-in button. If the site sends a verification code or link, ask the user for it.`,
        account: { host, email, created },
      });
    });
  }

  /**
   * Submits the application by clicking `ref`, with the checks a submission
   * needs. Returns whether the site confirmed it.
   */
  submit(jobId: number, ref: string): Promise<ActionResult & { submitted: boolean; state: string }> {
    return this.locked(jobId, async () => {
      const db = getDb();
      const before = db.prepare("SELECT workflow_state FROM jobs WHERE id = ?").get(jobId) as { workflow_state: string | null };
      if (before.workflow_state === "submitted") throw new HarnessError("This application is already recorded as submitted.");
      if (before.workflow_state === "submitting" || before.workflow_state === "submission_unknown") {
        throw new HarnessError("A submission for this application may already have gone through. Don't submit again: ask the user to check the portal or their email, then mark it on the job page.");
      }
      let page = this.page(jobId);
      const snap = await takeSnapshot(page);
      // A challenge or bot check that's showing; a CAPTCHA checkbox may already be ticked, so it doesn't block.
      const blocking = snap.blockers.filter((b) => !/checkbox/i.test(b));
      if (blocking.length) throw new HarnessError(`Can't submit: ${blocking.join("; ")}. Ask the user to solve it with Take over on the application's JobManager page, then try again.`);
      // Only a heads-up: portals use custom widgets this can misread, and the site validates anyway.
      const missing = await requiredEmpty(page).catch(() => [] as string[]);
      const target = snap.elements.find((e) => e.ref === ref);
      if (!target) throw new HarnessError(`No element ${ref} on the page now; take a new snapshot.`);
      if (target.kind !== "button" && target.kind !== "link") throw new HarnessError(`${ref} is a ${target.kind}, not a button.`);
      if (target.disabled) throw new HarnessError(`The "${target.label}" button is disabled; something on the form still needs doing.`);
      const { loc } = await this.mustLocate(page, ref);

      // The attempt and exactly what's being sent are saved before the click.
      const dir = path.join(ARTIFACTS_DIR, `job-${jobId}`);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const payloadFile = path.join(dir, `submission-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
      const fields = snap.elements
        .filter((e) => e.kind !== "button" && e.kind !== "link")
        .map((e) => ({ label: e.question ? `${e.question} — ${e.label}` : e.label, kind: e.kind, value: e.value ?? (e.checked !== undefined ? String(e.checked) : "") }));
      fs.writeFileSync(payloadFile, JSON.stringify({ url: page.url(), button: target.label, at: new Date().toISOString(), fields }, null, 2), { mode: 0o600 });
      const claimed = db.prepare(
        `UPDATE jobs SET workflow_state = 'submitting', workflow_detail = ? WHERE id = ?
           AND (workflow_state IS NULL OR workflow_state NOT IN ('submitting', 'submitted', 'submission_unknown'))`
      ).run("Submitting through ChatGPT", jobId);
      if (!claimed.changes) throw new HarnessError("Another submission for this application just started.");
      logEvent(jobId, "submission:attempt", `ChatGPT clicked "${target.label}" on ${page.url()} | payload: ${path.relative(DATA_DIR, payloadFile)}`);

      const restore = (state: string | null, detail: string) => {
        db.prepare("UPDATE jobs SET workflow_state = ?, workflow_detail = ? WHERE id = ?").run(state, detail, jobId);
        logEvent(jobId, `state:${state ?? "manual"}`, detail);
      };
      const popup = page.context().waitForEvent("page", { timeout: 3_000 }).catch(() => null);
      try {
        await loc.click({ timeout: 10_000 });
      } catch (err) {
        // The click didn't happen, so nothing was sent.
        restore(before.workflow_state, `Submit click failed: ${firstLine(err)}`);
        throw new HarnessError(`Couldn't click "${target.label}": ${firstLine(err)}`);
      }
      const opened = await popup;
      if (opened) page = opened;

      let check: ConfirmationCheck | null = null;
      const clickedAt = Date.now();
      while (Date.now() - clickedAt < 30_000) {
        await page.waitForTimeout(1_000);
        check = (await page.evaluate(CONFIRM_SCRIPT).catch(() => null)) as ConfirmationCheck | null;
        if (check?.confirmed || check?.warning) break;
        // The site rejected it outright: the button is still there and fields are flagged. No need to wait it out.
        if (Date.now() - clickedAt >= 4_000 && (await locateRef(page, ref))) {
          if (await page.evaluate(FLAGGED_SCRIPT).catch(() => false)) break;
          // Or it's asking for an emailed code: the person has to fetch it.
          if (CODE_REQUEST.test(((await page.evaluate("document.body ? document.body.innerText : ''").catch(() => "")) as string))) break;
        }
      }
      if (check?.confirmed) {
        const receipt = await this.recordConfirmed(jobId, page, check, "Submitted through ChatGPT");
        const done = await this.withSnapshot(page);
        await page.close().catch(() => {}); // nothing left to do there; frees the memory
        return { ...done, submitted: true, state: "submitted", ...(receipt && { receipt_file: path.basename(receipt) }), note: `Submitted; the site confirmed it ("${check.snippet}"). Receipt screenshot saved${receipt ? "" : " failed"}; the tab is closed.` };
      }
      const after = await takeSnapshot(page);
      const looksEmpty = missing.length ? ` Before submitting, these looked empty: ${missing.join(", ")}.` : "";
      if (check?.warning) {
        restore("needs_input", `The site flagged the submission: "${check.warning.slice(0, 160)}"`);
        return { snapshot: after, submitted: false, state: "needs_input", note: `Not submitted: the site says "${check.warning}". Tell the user; retrying may not help.` };
      }
      // The submit button is still on the page and there's no confirmation: the site didn't take it.
      if (after.elements.some((e) => e.ref === ref) || (await locateRef(page, ref))) {
        const why = after.errors.length ? `the site shows: ${after.errors.slice(0, 5).join("; ")}` : "the form is still showing with no confirmation";
        restore("needs_input", `Not submitted: ${why.slice(0, 200)}`);
        if (CODE_REQUEST.test(after.text)) {
          restore("needs_input", "The site sent a verification code: enter it in the Verification code box on this page, then ask ChatGPT to submit again.");
          return {
            snapshot: after, submitted: false, state: "needs_input", needs_code: true,
            note: "The site is asking for a verification code it sent to the user's email or phone. Don't ask for the code in chat: tell the user to enter it in the Verification code box on the application's JobManager page (code_entry_url), then call submit_application again when they say it's in.",
          };
        }
        return {
          snapshot: after, submitted: false, state: "needs_input",
          note: `Not submitted: ${why}.${looksEmpty} Fix those fields (see the snapshot's errors and empty required fields) and call submit_application again.`,
        };
      }
      restore("submission_unknown", "Clicked submit through ChatGPT but the site showed no confirmation. Check the portal or your email before doing anything else.");
      return {
        snapshot: after, submitted: false, state: "submission_unknown",
        note: "The site showed no confirmation, so it's unknown whether this went through. Don't submit again: ask the user to check the portal or their email, then mark it on the job page.",
      };
    });
  }
}

/**
 * The server's harness: one browser with its own profile, closed after
 * JOBMANAGER_BROWSER_IDLE_MINUTES unused (default 5), with at most
 * JOBMANAGER_BROWSER_MAX_TABS applications open at once (default 2) — Chromium
 * is most of the memory on a small server.
 */
const g = globalThis as { __jmHarness?: Harness };
export function serverHarness(): Harness {
  const idleMinutes = Number(process.env.JOBMANAGER_BROWSER_IDLE_MINUTES);
  const maxTabs = Number(process.env.JOBMANAGER_BROWSER_MAX_TABS);
  return (g.__jmHarness ??= new Harness(new BrowserOwner({ profileDir: `${PROFILE_DIR}-chatgpt` }), {
    idleCloseMs: (idleMinutes > 0 ? idleMinutes : 5) * 60_000,
    maxTabs: maxTabs >= 1 ? Math.floor(maxTabs) : 2,
  }));
}
