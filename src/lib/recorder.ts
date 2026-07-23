import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import { RECORDINGS_DIR } from "./db";
import { createRecording, finishRecording, getRecording } from "./queries";
import type { Recording } from "./types";

const BINARY = path.join(process.cwd(), "bin", "JobRecorder");

interface ActiveRecording {
  recordingId: number;
  eventId: number;
  startedAt: number;
  child: ChildProcess;
  stderr: string;
}

// Survive Next.js dev-server hot reloads.
const g = globalThis as unknown as { __activeRecording?: ActiveRecording | null };

export function activeRecording(): { recordingId: number; eventId: number; startedAt: number } | null {
  const a = g.__activeRecording;
  return a ? { recordingId: a.recordingId, eventId: a.eventId, startedAt: a.startedAt } : null;
}

export function startRecording(eventId: number): Recording {
  if (g.__activeRecording) throw new Error("A recording is already in progress");
  if (!fs.existsSync(BINARY)) {
    throw new Error("Recorder binary not found — run `npm run build:recorder` first");
  }

  const filename = `event${eventId}-${new Date().toISOString().replace(/[:.]/g, "-")}.mov`;
  const filePath = path.join("recordings", filename); // stored relative to data/
  const absPath = path.join(RECORDINGS_DIR, filename);

  const child = spawn(BINARY, [absPath], { stdio: ["ignore", "pipe", "pipe"] });
  const recording = createRecording(eventId, filePath);
  const active: ActiveRecording = { recordingId: recording.id, eventId, startedAt: Date.now(), child, stderr: "" };
  g.__activeRecording = active;

  child.stderr?.on("data", (d) => (active.stderr += d.toString()));
  child.on("exit", (code) => {
    if (g.__activeRecording?.recordingId === recording.id) g.__activeRecording = null;
    // Only mark failed on unexpected exit; normal stop is finalized in stopRecording.
    const row = getRecording(recording.id);
    if (row?.state === "recording") {
      finishRecording(recording.id, code === 0 ? "done" : "failed");
      if (code !== 0) console.error(`JobRecorder exited with code ${code}:\n${active.stderr}`);
    }
  });
  child.on("error", () => {
    g.__activeRecording = null;
    finishRecording(recording.id, "failed");
  });

  return recording;
}

export async function stopRecording(): Promise<Recording | null> {
  const active = g.__activeRecording;
  if (!active) return null;

  const exited = new Promise<number | null>((resolve) => {
    active.child.once("exit", (code) => resolve(code));
  });
  active.child.kill("SIGINT"); // recorder finalizes the .mov, then exits
  const code = await Promise.race([
    exited,
    new Promise<null>((resolve) =>
      setTimeout(() => {
        active.child.kill("SIGKILL");
        resolve(null);
      }, 15_000)
    ),
  ]);

  g.__activeRecording = null;
  return finishRecording(active.recordingId, code === 0 ? "done" : "failed");
}
