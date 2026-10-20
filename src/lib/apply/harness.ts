import fs from "fs";
import path from "path";
import type { Page } from "playwright";
import { ARTIFACTS_DIR, DATA_DIR, getDb, WORK_DIR } from "../db";
import { approvedArtifact, getProfileMap, markSubmitted } from "../automation";
import { getDocument, getJob } from "../queries";
import { logEvent } from "../queue";
import { artifactDownloadName } from "../steps";
import { matchOption } from "./answers";
import { BrowserOwner, hostAllowed, PROFILE_DIR } from "./browser";
import { CONFIRM_SCRIPT, type ConfirmationCheck } from "./confirm";
import { applicationTarget, prepareApplication, SUPPORTED_ATS, type Ats } from "./fill";
import { COMBO_OPTIONS_SCRIPT } from "./scan";
import { locateRef, requiredEmpty, SUBMIT_TEXT, takeSnapshot, type PageSnapshot } from "./snapshot";
import { accountPassword, createAccount, findAccount } from "./vault";

/**
 * The browser harness behind the ChatGPT browser tools (mcp-browser.ts).
 * ChatGPT is the agent: it reads a snapshot, then asks for one action at a
 * time (click, type, choose, upload…), and gets a fresh snapshot back.
 *
 * It runs inside the web server, so it works on a headless server with no
 * worker. It has its own browser profile (separate from the worker's, which
 * may run on the same machine) and the worker's navigation guard: each job's
 * tab may only go to that job's own sites and known ATS domains.
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
    private opts: { idleCloseMs?: number } = {},
  ) {}

  private async locked<T>(jobId: number, fn: () => Promise<T>): Promise<T> {
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

  screenshot(jobId: number): Promise<{ png: Buffer; url: string }> {
    return this.locked(jobId, async () => {
      const page = this.page(jobId);
      return { png: await page.screenshot({ type: "png" }), url: page.url() };
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
      const approved = approvedArtifact(jobId);
      const doc = !approved && job.resume_id ? getDocument(job.resume_id) : null;
      if (approved) {
        src = path.join(DATA_DIR, approved.pdf_path);
        name = `${artifactDownloadName(job.company)}.pdf`;
      } else if (doc) {
        src = path.join(DATA_DIR, doc.file_path);
        name = path.extname(doc.name) ? doc.name : `${doc.name}${path.extname(doc.file_path)}`;
      } else {
        throw new HarnessError("This application has no resume: approve a generated one, link one (update_application resume_id), or pass document_id.");
      }
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

  /** Fills everything the Profile and answer bank answer (the same rules as the worker's prepare step). */
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
      let page = this.page(jobId);
      const db = getDb();
      const before = db.prepare("SELECT workflow_state FROM jobs WHERE id = ?").get(jobId) as { workflow_state: string | null };
      if (before.workflow_state === "submitted") throw new HarnessError("This application is already recorded as submitted.");
      if (before.workflow_state === "submitting" || before.workflow_state === "submission_unknown") {
        throw new HarnessError("A submission for this application may already have gone through. Don't submit again: ask the user to check the portal or their email, then mark it on the queue.");
      }
      const snap = await takeSnapshot(page);
      if (snap.blockers.length) throw new HarnessError(`Can't submit: ${snap.blockers.join("; ")}. The user has to deal with that.`);
      const missing = await requiredEmpty(page);
      if (missing.length) throw new HarnessError(`Required fields are still empty: ${missing.join(", ")}.`);
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
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        await page.waitForTimeout(1_000);
        check = (await page.evaluate(CONFIRM_SCRIPT).catch(() => null)) as ConfirmationCheck | null;
        if (check?.confirmed || check?.warning) break;
      }
      if (check?.confirmed) {
        const receipt = await this.recordConfirmed(jobId, page, check, "Submitted through ChatGPT");
        return { ...(await this.withSnapshot(page)), submitted: true, state: "submitted", note: `Submitted; the site confirmed it ("${check.snippet}").${receipt ? " Receipt screenshot saved." : ""}` };
      }
      const after = await takeSnapshot(page);
      const formStillThere = after.elements.some((e) => e.ref === ref) || (await requiredEmpty(page).catch(() => [])).length > 0 || after.errors.length > 0;
      if (check?.warning || (formStillThere && after.errors.length)) {
        const why = check?.warning ?? after.errors.slice(0, 3).join("; ");
        restore("needs_input", `The site didn't accept the submission: "${why.slice(0, 160)}"`);
        return { snapshot: after, submitted: false, state: "needs_input", note: `Not submitted: the site says "${why}". Fix it and try again.` };
      }
      restore("submission_unknown", "Clicked submit through ChatGPT but the site showed no confirmation. Check the portal or your email before doing anything else.");
      return {
        snapshot: after, submitted: false, state: "submission_unknown",
        note: "The site showed no confirmation, so it's unknown whether this went through. Don't submit again: ask the user to check the portal or their email, then mark it on the queue.",
      };
    });
  }
}

/** The server's harness: one browser, its own profile, closed after 20 idle minutes. */
const g = globalThis as { __jmHarness?: Harness };
export function serverHarness(): Harness {
  return (g.__jmHarness ??= new Harness(new BrowserOwner({ profileDir: `${PROFILE_DIR}-chatgpt` }), { idleCloseMs: 20 * 60_000 }));
}
