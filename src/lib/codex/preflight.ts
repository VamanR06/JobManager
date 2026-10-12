import { execFile } from "child_process";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { claudeConfig } from "./claude";
import { codexConfig, codexEnv, type CodexConfig } from "./config";
import { toolPath } from "./toolpath";

/**
 * Checks everything a Resume Builder run depends on and reports each problem as
 * a specific blocker. Nothing here installs, updates, or reconfigures anything.
 */

export type BlockerCode =
  | "codex_missing" | "codex_login" | "plugin_missing" | "plugin_disabled" | "plugin_resources"
  | "latex_missing" | "latex_packages" | "pdf_tools_missing" | "claude_missing" | "claude_login";

export interface PreflightBlocker {
  code: BlockerCode;
  message: string;
}

export interface PluginInfo {
  ref: string;
  version: string;
  /** Directory Codex loads the skill from (its plugin cache), discovered at runtime. */
  root: string;
  skillDir: string;
  /** sha256 over the sorted per-file hashes of the skill directory. */
  resourceHash: string;
  files: { rel: string; sha256: string; bytes: number }[];
}

export interface PreflightResult {
  ok: boolean;
  /** Which CLI cliVersion/loggedIn describe. */
  engine: "codex" | "claude";
  checkedAt: string;
  cliVersion: string | null;
  loggedIn: boolean;
  plugin: PluginInfo | null;
  tools: Record<string, string | null>;
  blockers: PreflightBlocker[];
}

function run(file: string, args: string[], timeoutMs = 20_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { env: codexEnv(), timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException).code === "number" ? Number((err as NodeJS.ErrnoException).code) : -1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** Resolves an executable on PATH (no shell). */
export function which(name: string, envPath = toolPath()): string | null {
  if (name.includes("/")) return fs.existsSync(name) ? name : null;
  for (const dir of envPath.split(path.delimiter)) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

function hashTree(dir: string): { files: PluginInfo["files"]; hash: string } {
  const files: PluginInfo["files"] = [];
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name === ".DS_Store") continue;
      const abs = path.join(d, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) {
        const buf = fs.readFileSync(abs);
        files.push({ rel: path.relative(dir, abs), sha256: crypto.createHash("sha256").update(buf).digest("hex"), bytes: buf.length });
      }
    }
  };
  walk(dir);
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  const hash = crypto.createHash("sha256").update(files.map((f) => `${f.rel}:${f.sha256}`).join("\n")).digest("hex");
  return { files, hash };
}

interface PluginListEntry {
  pluginId: string;
  version?: string;
  installed?: boolean;
  enabled?: boolean;
  source?: { path?: string };
}

async function inspectPlugin(cfg: CodexConfig, bin: string, blockers: PreflightBlocker[]): Promise<PluginInfo | null> {
  if (!cfg.pluginRef) {
    blockers.push({
      code: "plugin_missing",
      message: "RESUME_PLUGIN_REF is not set. Add your Resume Builder's <plugin>@<marketplace> (see `codex plugin list`) to .env.local",
    });
    return null;
  }
  let entry: PluginListEntry | undefined;
  let parsed = false;
  // Retries: the CLI occasionally returns nothing while another codex command holds its state
  // (seen when a draft and a setup check started together).
  for (let attempt = 0; attempt < 3 && !parsed; attempt++) {
    const listed = await run(bin, ["plugin", "list", "--json"]);
    try {
      entry = (JSON.parse(listed.stdout).installed as PluginListEntry[]).find((p) => p.pluginId === cfg.pluginRef);
      parsed = true;
    } catch {
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1_500 * (attempt + 1)));
    }
  }
  if (!parsed) {
    blockers.push({ code: "plugin_missing", message: "Could not read `codex plugin list --json` output (tried 3 times); run `npm run codex:doctor`" });
    return null;
  }
  if (!entry?.installed) {
    blockers.push({
      code: "plugin_missing",
      message: `Resume Builder (${cfg.pluginRef}) is not installed. Run: codex plugin add ${cfg.pluginRef}`,
    });
    return null;
  }
  if (!entry.enabled) {
    blockers.push({ code: "plugin_disabled", message: `Resume Builder (${cfg.pluginRef}) is installed but disabled` });
    return null;
  }
  const version = entry.version ?? "";
  // Codex loads skills from its cache copy; fall back to the marketplace source.
  const cacheRoot = path.join(cfg.codexHome, "plugins", "cache", cfg.marketplace, cfg.pluginName, version);
  const root = fs.existsSync(cacheRoot) ? cacheRoot : entry.source?.path ?? "";
  const skillDir = path.join(root, "skills", "instructions");
  const required = ["SKILL.md", "lookup/knowledge-index.json", "references/tailored_resume_builder_spec.md", "references/Example.tex"];
  const missing = required.filter((rel) => !fs.existsSync(path.join(skillDir, rel)));
  if (!root || missing.length) {
    blockers.push({ code: "plugin_resources", message: `Plugin resources missing from ${skillDir || "(unknown)"}: ${missing.join(", ")}` });
    return null;
  }
  // Everything the knowledge index promises must exist, and archives must open.
  try {
    const index = JSON.parse(fs.readFileSync(path.join(skillDir, "lookup/knowledge-index.json"), "utf8")) as { files: { path: string }[] };
    for (const f of index.files) {
      const abs = path.join(skillDir, f.path);
      if (!fs.existsSync(abs)) blockers.push({ code: "plugin_resources", message: `Knowledge index lists a missing file: ${f.path}` });
      else if (abs.endsWith(".zip")) {
        const t = await run("unzip", ["-tq", abs]);
        if (t.code !== 0) blockers.push({ code: "plugin_resources", message: `Archive does not open cleanly: ${f.path}` });
      }
    }
  } catch {
    blockers.push({ code: "plugin_resources", message: "knowledge-index.json is not valid JSON" });
  }
  const { files, hash } = hashTree(skillDir);
  return { ref: cfg.pluginRef, version, root, skillDir, resourceHash: hash, files };
}

/** TeX Live package names for .sty/.ldf files whose package name differs. */
const TLMGR_PACKAGE: Record<string, string> = { "fullpage.sty": "preprint", "english.ldf": "babel-english" };

/**
 * Every package the plugin's Example.tex loads must resolve in the local TeX
 * install. Otherwise the sandboxed run (no network) can't install it and would
 * be tempted to fake a substitute, silently changing the template.
 */
async function missingTemplatePackages(skillDir: string): Promise<string[]> {
  const example = path.join(skillDir, "references", "Example.tex");
  if (!fs.existsSync(example)) return [];
  const src = fs.readFileSync(example, "utf8").replace(/(^|[^\\])%.*$/gm, "$1");
  const needed = new Set<string>();
  for (const m of src.matchAll(/\\usepackage(?:\[([^\]]*)\])?\{([^}]+)\}/g)) {
    for (const pkg of m[2].split(",")) needed.add(`${pkg.trim()}.sty`);
    // babel's language options are separate files.
    if (m[2].includes("babel") && m[1]) for (const lang of m[1].split(",")) needed.add(`${lang.trim()}.ldf`);
  }
  for (const m of src.matchAll(/\\input\{([^}]+)\}/g)) needed.add(m[1].includes(".") ? m[1] : `${m[1]}.tex`);
  const missing: string[] = [];
  for (const file of needed) {
    const r = await run("kpsewhich", [file]);
    if (!r.stdout.trim()) missing.push(file);
  }
  return missing;
}

export type ResumeEngine = "codex" | "claude";
export const RESUME_ENGINES: ResumeEngine[] = ["codex", "claude"];

async function checkClaude(blockers: PreflightBlocker[]): Promise<{ version: string | null; loggedIn: boolean }> {
  const bin = which(claudeConfig().bin);
  if (!bin) {
    blockers.push({ code: "claude_missing", message: "Claude Code CLI not found. Set CLAUDE_BIN to its full path (`which claude` in a terminal)." });
    return { version: null, loggedIn: false };
  }
  const version = (await run(bin, ["--version"])).stdout.trim() || null;
  let loggedIn = false;
  try {
    loggedIn = JSON.parse((await run(bin, ["auth", "status"])).stdout).loggedIn === true;
  } catch {
    // unreadable → treated as logged out
  }
  if (!loggedIn) blockers.push({ code: "claude_login", message: "Claude Code is not logged in for this OS user. Run `claude auth login` in a terminal." });
  return { version, loggedIn };
}

/**
 * Checks one engine. The skill folder is always discovered through Codex's
 * plugin registry, so both engines run the same installed Resume Builder files.
 */
/** Preflights run one at a time: concurrent `codex` CLI calls can trip over each other. */
let preflightChain: Promise<unknown> = Promise.resolve();

export function preflight(cfg: CodexConfig = codexConfig(), engine: ResumeEngine = "codex"): Promise<PreflightResult> {
  const next = preflightChain.then(() => runPreflight(cfg, engine));
  preflightChain = next.catch(() => {});
  return next;
}

async function runPreflight(cfg: CodexConfig, engine: ResumeEngine): Promise<PreflightResult> {
  const blockers: PreflightBlocker[] = [];
  const tools: Record<string, string | null> = {};
  for (const t of ["pdflatex", "pdfinfo", "pdftotext", "unzip"]) tools[t] = which(t);
  if (!tools.pdflatex) blockers.push({ code: "latex_missing", message: "pdflatex was not found on PATH (install MacTeX or BasicTeX)" });
  if (!tools.pdfinfo || !tools.pdftotext) blockers.push({ code: "pdf_tools_missing", message: "pdfinfo/pdftotext not found (brew install poppler)" });

  // The selected engine's CLI and login are checked even if Codex is missing,
  // so the panel reports every problem at once.
  const bin = which(cfg.bin);
  if (!bin) {
    blockers.push({ code: "codex_missing", message: `Codex CLI not found (${cfg.bin}); it's needed to locate the installed Resume Builder plugin. Set CODEX_BIN to its full path (\`which codex\` in a terminal).` });
  }
  let cliVersion: string | null = null;
  let loggedIn = false;
  if (engine === "claude") {
    ({ version: cliVersion, loggedIn } = await checkClaude(blockers));
  } else if (bin) {
    cliVersion = (await run(bin, ["--version"])).stdout.trim() || null;
    const login = await run(bin, ["login", "status"]);
    loggedIn = login.code === 0 && /logged in/i.test(login.stdout + login.stderr);
    if (!loggedIn) {
      blockers.push({ code: "codex_login", message: "Codex is not logged in for this OS user. Run `codex login` in a terminal." });
    }
  }
  if (!bin) return { ok: false, engine, checkedAt: new Date().toISOString(), cliVersion, loggedIn, plugin: null, tools, blockers };
  const plugin = await inspectPlugin(cfg, bin, blockers);
  if (plugin && tools.pdflatex) {
    const missing = await missingTemplatePackages(plugin.skillDir);
    if (missing.length) {
      const pkgs = [...new Set(missing.map((f) => TLMGR_PACKAGE[f] ?? f.replace(/\.(sty|ldf|tex)$/, "")))];
      blockers.push({
        code: "latex_packages",
        message: `Your TeX install is missing files the Resume Builder template needs: ${missing.join(", ")}. Install them with: tlmgr install ${pkgs.join(" ")}`,
      });
    }
  }
  return { ok: blockers.length === 0, engine, checkedAt: new Date().toISOString(), cliVersion, loggedIn, plugin, tools, blockers };
}

const cached = new Map<ResumeEngine, { at: number; result: PreflightResult }>();

/** Preflight at most every few minutes per engine; a failing result is never cached. */
export async function cachedPreflight(engine: ResumeEngine = "codex", maxAgeMs = 5 * 60_000): Promise<PreflightResult> {
  const hit = cached.get(engine);
  if (hit && hit.result.ok && Date.now() - hit.at < maxAgeMs) return hit.result;
  const result = await preflight(codexConfig(), engine);
  cached.set(engine, { at: Date.now(), result });
  return result;
}
