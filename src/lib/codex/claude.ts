import fs from "fs";
import os from "os";
import path from "path";
import { DATA_DIR, WORK_DIR } from "../db";
import type { PluginInfo } from "./preflight";
import { pushCommand, type EventInterpreter } from "./process";

/**
 * The Claude Code backend for resume runs (`claude -p`). It runs the same
 * Resume Builder skill files as the Codex path: a tiny wrapper plugin points
 * at the installed skill folder, so there is one copy of the rules.
 */

export interface ClaudeConfig {
  bin: string;
  /** Optional `--model`; blank = the CLI's default. */
  model: string | null;
  /** `--effort` (low | medium | high | xhigh | max); blank = CLI default. */
  effort: string | null;
}

export function claudeConfig(env: NodeJS.ProcessEnv = process.env): ClaudeConfig {
  return {
    bin: env.CLAUDE_BIN || "claude",
    model: env.CLAUDE_MODEL?.trim() || null,
    effort: env.CLAUDE_EFFORT === undefined ? "medium" : env.CLAUDE_EFFORT.trim() || null,
  };
}

/** The skill name Claude sees: `<wrapper plugin name>:<skill folder>`. */
export const CLAUDE_PLUGIN_NAME = "resume-builder";
export const CLAUDE_SKILL_NAME = `${CLAUDE_PLUGIN_NAME}:instructions`;

/**
 * `<work root>/../claude-plugin/resume-builder`, whose skills/instructions is a
 * symlink to the installed Resume Builder skill folder. Rebuilt whenever the
 * installed plugin moves (e.g. a new version), never copied.
 */
export function ensureClaudeWrapper(plugin: PluginInfo, root = path.join(path.dirname(WORK_DIR), "claude-plugin")): string {
  const dir = path.join(root, CLAUDE_PLUGIN_NAME);
  const link = path.join(dir, "skills", "instructions");
  fs.mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(link), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(dir, ".claude-plugin", "plugin.json"),
    JSON.stringify({
      name: CLAUDE_PLUGIN_NAME,
      version: plugin.version.split("+")[0] || "0.0.0",
      description: `JobManager wrapper around ${plugin.ref} (${plugin.version}); skills are symlinked, not copied.`,
    }, null, 2)
  );
  let current: string | null = null;
  try {
    current = fs.readlinkSync(link);
  } catch {
    // missing
  }
  if (current !== plugin.skillDir) {
    fs.rmSync(link, { force: true, recursive: false });
    fs.symlinkSync(plugin.skillDir, link);
  }
  return dir;
}

/**
 * Settings passed with --settings. --restricted ignores the user's own settings
 * files, so this is the whole policy: an OS sandbox for Bash with no escape
 * hatch (no network, writes only in the working folder), and read denials for
 * secrets and the dashboard's own data that the sandbox would otherwise allow.
 */
export function claudeSettings(): string {
  const home = os.homedir();
  const deny = [
    `${home}/.ssh`, `${home}/.aws`, `${home}/.gnupg`, `${home}/.config`, `${home}/.netrc`,
    // Codex's login and history, not its plugin cache (the skill lives there).
    `${home}/.codex/sessions`, `${home}/.claude`, `${home}/Library/Keychains`, `${home}/Library/Cookies`,
    `${home}/Library/Application Support/Google/Chrome`, `${home}/Library/Application Support/Firefox`,
    `${home}/Library/Safari`,
    // The dashboard's own data, but not work/ (attempt folders can live there).
    ...["documents", "artifacts", "recordings", "backups"].map((d) => path.join(DATA_DIR, d)),
  ].map((p) => `Read(/${p}/**)`); // "//abs/path" = absolute
  deny.push(`Read(/${home}/.codex/auth.json)`, `Read(/${path.join(DATA_DIR, "app.db")}*)`);
  return JSON.stringify({
    sandbox: { enabled: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: true },
    permissions: { deny },
  });
}

export function claudeArgs(input: {
  cfg: ClaudeConfig;
  wrapperDir: string;
  skillDir: string;
  schema: object;
}): string[] {
  return [
    "-p", "--output-format", "stream-json", "--verbose",
    // No user settings/hooks/CLAUDE.md, no MCP servers, file tools confined to the working dirs.
    "--restricted", "--strict-mcp-config", "--no-session-persistence",
    "--plugin-dir", input.wrapperDir,
    "--add-dir", input.skillDir, "--add-dir", input.wrapperDir,
    "--tools", "Read,Write,Edit,Glob,Grep,Bash,Skill",
    // Anything not listed is refused rather than prompted; never bypassPermissions.
    "--permission-mode", "dontAsk",
    "--settings", claudeSettings(),
    "--json-schema", JSON.stringify(input.schema),
    ...(input.cfg.model ? ["--model", input.cfg.model] : []),
    ...(input.cfg.effort ? ["--effort", input.cfg.effort] : []),
    "--allowed-tools", "Read", "Glob", "Grep", "Skill", "Write(./**)", "Edit(./**)", "Bash",
  ];
}

/**
 * `claude -p --output-format stream-json`: system/init, assistant tool_use,
 * user tool_result, result. Tool calls are recorded as command strings so the
 * same resource-evidence check applies to both backends; paths through the
 * wrapper symlink are rewritten to the real skill folder.
 */
export function makeClaudeInterpreter(wrapperSkillDir: string, realSkillDir: string): EventInterpreter {
  const pending = new Map<string, number>();
  const real = (s: string) => s.split(wrapperSkillDir).join(realSkillDir);
  return (event, result) => {
    const type = event.type as string;
    if (type === "system" && event.subtype === "init" && typeof event.session_id === "string") {
      result.sessionId = event.session_id;
    }
    const message = event.message as { content?: unknown } | undefined;
    const content = Array.isArray(message?.content) ? (message!.content as Record<string, unknown>[]) : [];
    if (type === "assistant") {
      for (const c of content) {
        if (c.type !== "tool_use") continue;
        const input = (c.input ?? {}) as Record<string, unknown>;
        const name = String(c.name);
        const detail =
          name === "Bash" ? String(input.command ?? "")
          : name === "Skill" ? String(input.skill ?? "")
          : String(input.file_path ?? input.path ?? input.pattern ?? "");
        pushCommand(result, real(`${name} ${detail}`), null);
        if (typeof c.id === "string") pending.set(c.id, result.commands.length - 1);
      }
    }
    if (type === "user") {
      for (const c of content) {
        if (c.type !== "tool_result" || typeof c.tool_use_id !== "string") continue;
        const idx = pending.get(c.tool_use_id);
        if (idx !== undefined && result.commands[idx]) result.commands[idx].exitCode = c.is_error ? 1 : 0;
      }
    }
    if (type === "result") {
      const usage = { ...((event.usage as Record<string, unknown>) ?? {}) };
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(usage)) if (typeof v === "number") out[k] = v;
      // The CLI's own estimate; recorded as reported, never computed here.
      if (typeof event.total_cost_usd === "number") out.cli_reported_cost_usd = event.total_cost_usd;
      if (typeof event.num_turns === "number") out.num_turns = event.num_turns;
      result.usage = out;
      if (event.structured_output !== undefined) result.finalOutput = event.structured_output;
      if (event.is_error === true || (typeof event.subtype === "string" && event.subtype !== "success")) {
        const msg = typeof event.result === "string" ? event.result : String(event.subtype);
        result.errors.push(msg.slice(0, 500));
      }
    }
  };
}
