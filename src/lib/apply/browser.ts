import fs from "fs";
import path from "path";
import type { BrowserContext, Frame, Page } from "playwright";
import { WORK_DIR } from "../db";
import { assertPublicUrl } from "../netguard";
import { POLYFILL_SCRIPT } from "./polyfills";

/**
 * The browser for applying (apply/harness.ts): a dedicated Chromium profile
 * under ~/.jobmanager/ — never the person's own Chrome profile, and no cookies
 * are imported. Logins made here persist in that profile only.
 *
 * Each job's tab may only navigate (top-level) to that job's application
 * hosts; anything else — including links in a posting — is blocked, so
 * personal data typed here only goes to the selected employer's ATS. A host
 * starting with "." allows that domain and its subdomains (".myworkdayjobs.com").
 *
 * Headless when JOBMANAGER_BROWSER_HEADLESS=1, or on Linux with no display
 * (a server). CHROMIUM_PATH runs an installed Chromium (e.g. Alpine's
 * /usr/bin/chromium-browser) instead of Playwright's download, with the flags
 * a small container needs.
 */

export function hostAllowed(hosts: Set<string> | string[], hostname: string): boolean {
  const h = hostname.toLowerCase();
  for (const a of hosts) {
    if (a.startsWith(".") ? h === a.slice(1) || h.endsWith(a) : h === a) return true;
  }
  return false;
}

export function defaultHeadless(): boolean {
  if (process.env.JOBMANAGER_BROWSER_HEADLESS === "1") return true;
  if (process.env.JOBMANAGER_BROWSER_HEADLESS === "0") return false;
  return process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
}

export interface BrowserOptions {
  headless?: boolean;
  profileDir?: string;
  /** Tests only: allow loopback fixture servers through the navigation guard. */
  allowLocal?: boolean;
}

/**
 * Playwright 1.64+ calls Element.checkVisibility (Chrome 105+) unconditionally,
 * so it can't drive an older Chromium, like the server's Alpine Chromium 93:
 * every action fails with "element.checkVisibility is not a function". 1.63
 * checks first and falls back. package.json pins playwright to 1.63.0; this
 * catches a server that installed something newer anyway.
 */
export function checkPlaywrightFits(playwrightVersion: string, browserHasCheckVisibility: boolean): string | null {
  const [major, minor] = playwrightVersion.split(".").map(Number);
  if (browserHasCheckVisibility || major < 1 || (major === 1 && minor <= 63)) return null;
  return `Playwright ${playwrightVersion} needs Chromium 105 or newer, but CHROMIUM_PATH is an older Chromium. On the server, run: npm install --save-exact playwright@1.63.0 (then restart), or point CHROMIUM_PATH at a newer Chromium.`;
}

function installedPlaywright(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require("playwright-core/package.json") as { version: string }).version;
  } catch {
    return "unknown";
  }
}

export const PROFILE_DIR = path.join(path.dirname(WORK_DIR), "browser-profile");

export class BrowserOwner {
  private ctx: BrowserContext | null = null;
  private pages = new Map<number, Page>();
  private allowed = new WeakMap<Page, Set<string>>();
  readonly blockedNavigations: string[] = [];

  constructor(private opts: BrowserOptions = {}) {}

  private async context(): Promise<BrowserContext> {
    if (this.ctx) return this.ctx;
    const { chromium } = await import("playwright");
    const dir = this.opts.profileDir ?? PROFILE_DIR;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    const headless = this.opts.headless ?? defaultHeadless();
    const system = process.env.CHROMIUM_PATH?.trim();
    this.ctx = await chromium.launchPersistentContext(dir, {
      headless,
      // Headless has no window to size the page by; use a desktop size so forms lay out normally.
      viewport: headless ? { width: 1280, height: 900 } : null,
      acceptDownloads: false,
      ...(system && {
        executablePath: system,
        // No sandbox (containers usually can't provide one), /tmp instead of a small /dev/shm, no GPU.
        args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
      }),
    });
    // Newer JavaScript built-ins for sites that assume them (see polyfills.ts); no-ops on a current browser.
    await this.ctx.addInitScript(POLYFILL_SCRIPT);
    const pw = installedPlaywright();
    const first = this.ctx.pages()[0] ?? (await this.ctx.newPage());
    const native = (await first.evaluate("typeof Element.prototype.checkVisibility === 'function'").catch(() => true)) as boolean;
    const misfit = checkPlaywrightFits(pw, native);
    console.log(`[browser] launched ${system ? `CHROMIUM_PATH=${system}` : "Playwright's Chromium"} (${await first.evaluate("navigator.userAgent").catch(() => "?")}), playwright ${pw}, ${headless ? "headless" : "windowed"}, profile ${dir}`);
    if (misfit) {
      console.error(`[browser] ${misfit}`);
      const ctx = this.ctx;
      this.ctx = null;
      await ctx.close().catch(() => {});
      throw new Error(misfit);
    }
    this.ctx.on("close", () => {
      this.ctx = null;
      this.pages.clear();
    });
    // Popups/new tabs opened by an application page may go where their opener may.
    this.ctx.on("page", (p) => {
      p.opener()
        .then((opener) => {
          const hosts = opener && this.allowed.get(opener);
          if (hosts) this.allowed.set(p, hosts);
        })
        .catch(() => {});
    });
    await this.ctx.route("**/*", async (route) => {
      try {
        const req = route.request();
        // Only top-level navigations are restricted; sub-resources and iframes (e.g. CAPTCHA) load normally.
        if (!req.isNavigationRequest()) return await route.continue();
        let frame: Frame | null = null;
        try {
          frame = req.frame();
        } catch {
          // A popup or new window's first request arrives before its frame exists.
          frame = null;
        }
        if (frame && frame !== frame.page().mainFrame()) return await route.continue();
        const page = frame?.page();
        const hosts = page ? this.allowed.get(page) : this.allAllowedHosts();
        const url = new URL(req.url());
        let ok = !!hosts && hostAllowed(hosts, url.hostname);
        if (ok && !this.opts.allowLocal) {
          try {
            await assertPublicUrl(url);
          } catch {
            ok = false;
          }
        }
        if (!ok) {
          this.blockedNavigations.push(req.url());
          return await route.abort("blockedbyclient");
        }
        return await route.continue();
      } catch {
        // Never let a routing hiccup take the server down; refuse just this request.
        await route.abort("blockedbyclient").catch(() => {});
      }
    });
    return this.ctx;
  }

  /**
   * The job's tab, reused if it's still open (so a half-filled form you took
   * over isn't reloaded), else a new tab at `url`.
   */
  async pageFor(jobId: number, url: string, hosts: string[], reload = false): Promise<Page> {
    const ctx = await this.context();
    let page = this.pages.get(jobId);
    if (page && page.isClosed()) page = undefined;
    const fresh = !page;
    if (!page) {
      page = await ctx.newPage();
      this.pages.set(jobId, page);
      const opened = page;
      page.on("close", () => {
        if (this.pages.get(jobId) === opened) this.pages.delete(jobId);
      });
    }
    this.allowed.set(page, new Set(hosts));
    if (fresh || reload || new URL(page.url()).hostname !== new URL(url).hostname) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    }
    // No bringToFront: with several forms filling in parallel, it would yank focus away
    // from a tab you're reviewing. New tabs still open in the automation window.
    return page;
  }

  /** Makes `page` (e.g. a tab the site opened) the job's tab, with the given allowed hosts. */
  adopt(jobId: number, page: Page, hosts: string[]): void {
    this.pages.set(jobId, page);
    this.allowed.set(page, new Set(hosts));
    page.on("close", () => {
      if (this.pages.get(jobId) === page) this.pages.delete(jobId);
    });
  }

  /** Open job tabs, for the submission watcher. */
  openPages(): [number, Page][] {
    return [...this.pages.entries()].filter(([, p]) => !p.isClosed());
  }

  /** Hosts any open job tab may use (for popups whose tab isn't known yet). */
  private allAllowedHosts(): Set<string> {
    const all = new Set<string>();
    for (const p of this.pages.values()) for (const h of this.allowed.get(p) ?? []) all.add(h);
    return all;
  }

  /** The job's open tab, if any. */
  existingPage(jobId: number): Page | null {
    const p = this.pages.get(jobId);
    return p && !p.isClosed() ? p : null;
  }

  /** The hosts the job's tab may navigate to. */
  allowedHosts(page: Page): Set<string> {
    return this.allowed.get(page) ?? new Set();
  }

  hasPage(jobId: number): boolean {
    const p = this.pages.get(jobId);
    return !!p && !p.isClosed();
  }

  async close(): Promise<void> {
    const ctx = this.ctx;
    this.ctx = null;
    this.pages.clear();
    await ctx?.close().catch(() => {});
  }
}
