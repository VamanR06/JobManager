import { execFileSync, spawn } from "child_process";

/**
 * Runs one agent CLI (`codex exec` or `claude -p`) as its own process group so a
 * timeout or cancel can stop it and everything it spawned (pdflatex, shells)
 * without touching any other session. Arguments are an array and no shell is
 * involved; the task prompt goes through stdin, so job text never reaches a
 * command line. Each CLI's JSONL dialect is read by an EventInterpreter.
 */

export interface CommandEvidence {
  command: string;
  exitCode: number | null;
}

export interface CodexProcessResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  /** Codex's thread id, from the `thread.started` event. */
  sessionId: string | null;
  eventCount: number;
  malformedLines: number;
  /** Commands the agent ran — the evidence that plugin resources were actually read. */
  commands: CommandEvidence[];
  /** Messages from `error` / `turn.failed` events. */
  errors: string[];
  usage: Record<string, number> | null;
  /** A final structured result carried in the event stream (Claude's `structured_output`). */
  finalOutput: unknown;
  /** Last few KB of stderr, for diagnosing launch failures. */
  stderrTail: string;
  spawnError: string | null;
}

/** Folds one well-formed JSONL event into the result. */
export type EventInterpreter = (event: Record<string, unknown>, result: CodexProcessResult) => void;

const MAX_COMMANDS = 400;
const MAX_COMMAND_CHARS = 2000;

export function pushCommand(result: CodexProcessResult, command: string, exitCode: number | null): void {
  if (result.commands.length < MAX_COMMANDS) result.commands.push({ command: command.slice(0, MAX_COMMAND_CHARS), exitCode });
}

function numbers(obj: unknown): Record<string, number> | null {
  if (!obj || typeof obj !== "object") return null;
  return Object.fromEntries(Object.entries(obj as Record<string, unknown>).filter(([, v]) => typeof v === "number")) as Record<string, number>;
}

/** `codex exec --json`: thread.started, item.completed(command_execution), turn.completed/failed, error. */
export const interpretCodexEvent: EventInterpreter = (event, result) => {
  const type = event.type as string;
  if (type === "thread.started" && typeof event.thread_id === "string") result.sessionId = event.thread_id;
  if (type === "turn.completed") result.usage = numbers(event.usage) ?? result.usage;
  if (type === "error" && typeof event.message === "string") result.errors.push(event.message.slice(0, 500));
  if (type === "turn.failed") {
    const msg = (event.error as { message?: string } | undefined)?.message;
    result.errors.push((msg ?? "turn failed").slice(0, 500));
  }
  const item = event.item as Record<string, unknown> | undefined;
  if (type === "item.completed" && item?.type === "command_execution" && typeof item.command === "string") {
    pushCommand(result, item.command, typeof item.exit_code === "number" ? item.exit_code : null);
  }
};

export interface CodexProcessOptions {
  bin: string;
  args: string[];
  cwd: string;
  stdin: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Called once the child exists, so its identity can be persisted before we wait. */
  onSpawn?: (info: { pid: number; procStart: string | null }) => void;
  /** Called for each well-formed event (after parsing, before retention limits). */
  onEvent?: (event: Record<string, unknown>) => void;
  killGraceMs?: number;
  /** Defaults to the Codex dialect. */
  interpret?: EventInterpreter;
}

const MAX_LINE_BYTES = 2 * 1024 * 1024;
const STDERR_TAIL = 8 * 1024;

/** `ps` start time: with the pid, identifies this exact process across pid reuse. */
export function processStartTime(pid: number): string | null {
  try {
    return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

/** True only if `pid` is still the very process we started (same start time). */
export function isSameProcess(pid: number, procStart: string | null): boolean {
  if (!procStart) return false;
  return processStartTime(pid) === procStart;
}

export function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}

export function runCodexProcess(opts: CodexProcessOptions): Promise<CodexProcessResult> {
  const result: CodexProcessResult = {
    exitCode: null, signal: null, timedOut: false, cancelled: false, sessionId: null, eventCount: 0,
    malformedLines: 0, commands: [], errors: [], usage: null, finalOutput: null, stderrTail: "", spawnError: null,
  };
  const interpret = opts.interpret ?? interpretCodexEvent;

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(opts.bin, opts.args, {
        cwd: opts.cwd,
        env: opts.env,
        detached: true, // own process group → kill(-pid) reaches descendants only
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      });
    } catch (err) {
      result.spawnError = err instanceof Error ? err.message : String(err);
      resolve(result);
      return;
    }

    let settled = false;
    let killTimer: NodeJS.Timeout | null = null;
    const stop = (why: "timeout" | "cancel") => {
      if (settled || !child.pid) return;
      if (why === "timeout") result.timedOut = true;
      else result.cancelled = true;
      killGroup(child.pid, "SIGTERM");
      killTimer = setTimeout(() => child.pid && killGroup(child.pid, "SIGKILL"), opts.killGraceMs ?? 5_000);
    };
    const timer = setTimeout(() => stop("timeout"), opts.timeoutMs);
    const onAbort = () => stop("cancel");
    if (opts.signal?.aborted) queueMicrotask(onAbort);
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("spawn", () => {
      opts.onSpawn?.({ pid: child.pid!, procStart: processStartTime(child.pid!) });
    });

    let buffer = "";
    const handleLine = (line: string) => {
      if (!line.trim()) return;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line);
        if (!event || typeof event !== "object" || typeof event.type !== "string") throw new Error("not an event");
      } catch {
        result.malformedLines++;
        return;
      }
      result.eventCount++;
      interpret(event, result);
      try {
        opts.onEvent?.(event);
      } catch {
        // Observers must not break the run.
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        handleLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
      // A runaway line without a newline is dropped rather than buffered forever.
      if (buffer.length > MAX_LINE_BYTES) {
        result.malformedLines++;
        buffer = "";
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      result.stderrTail = (result.stderrTail + chunk).slice(-STDERR_TAIL);
    });

    child.stdin.on("error", () => {
      // Child exited before reading the prompt; the exit code tells the story.
    });
    child.stdin.end(opts.stdin);

    child.on("error", (err) => {
      result.spawnError = err.message;
    });
    child.on("close", (code, signal) => {
      if (buffer) handleLine(buffer);
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      // Stragglers in the group (e.g. a pdflatex the agent backgrounded).
      if (child.pid) killGroup(child.pid, "SIGKILL");
      result.exitCode = code;
      result.signal = signal;
      resolve(result);
    });
  });
}
