import os from "os";
import path from "path";
import { toolPath } from "./toolpath";

/** Every Codex knob comes from the environment (.env.local), with safe defaults. */
export interface CodexConfig {
  /** Executable path or name looked up on PATH. */
  bin: string;
  /** `<plugin name>@<marketplace>` of the installed Resume Builder. */
  pluginRef: string;
  pluginName: string;
  marketplace: string;
  /** Codex's state dir; plugin caches and login live here. */
  codexHome: string;
  timeoutMs: number;
  /** Outer repair runs after the first, when verification finds concrete failures. */
  repairLimit: number;
  /** Optional; omitted means the CLI's configured default. Never guessed here. */
  model: string | null;
  /**
   * Reasoning effort for resume runs only (`-c model_reasoning_effort=…`), so a
   * global "high" in ~/.codex/config.toml doesn't make every resume slow.
   * Empty string = inherit the CLI config.
   */
  reasoningEffort: string | null;
  /** Soft time budget stated in the prompt; the hard stop is timeoutMs. */
  targetMinutes: number;
}

export function codexConfig(env: NodeJS.ProcessEnv = process.env): CodexConfig {
  const pluginRef = env.RESUME_PLUGIN_REF?.trim() || "";
  const [pluginName, marketplace = ""] = pluginRef.split("@");
  return {
    bin: env.CODEX_BIN || "codex",
    pluginRef,
    pluginName,
    marketplace,
    codexHome: env.CODEX_HOME || path.join(os.homedir(), ".codex"),
    timeoutMs: Number(env.CODEX_TIMEOUT_MS) > 0 ? Number(env.CODEX_TIMEOUT_MS) : 15 * 60_000,
    repairLimit: env.RESUME_REPAIR_LIMIT !== undefined && Number(env.RESUME_REPAIR_LIMIT) >= 0 ? Number(env.RESUME_REPAIR_LIMIT) : 3,
    model: env.CODEX_MODEL?.trim() || null,
    reasoningEffort: env.CODEX_REASONING_EFFORT === undefined ? "medium" : env.CODEX_REASONING_EFFORT.trim() || null,
    targetMinutes: Number(env.RESUME_TARGET_MINUTES) > 0 ? Number(env.RESUME_TARGET_MINUTES) : 7,
  };
}

/**
 * The environment Codex runs with: enough to find its login and tools, and
 * nothing else — no dashboard tokens, gateway secrets, or unrelated API keys.
 */
export function codexEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keep = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "CODEX_HOME"];
  const out: Record<string, string> = { TERM: "dumb", NO_COLOR: "1" };
  for (const k of keep) if (env[k]) out[k] = env[k]!;
  out.PATH = toolPath(env.PATH);
  return out as NodeJS.ProcessEnv;
}
