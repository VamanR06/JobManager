import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { toolPath } from "./codex/toolpath";

/**
 * Compiles a hand-edited resume .tex locally: no shell escape, kpathsea
 * "paranoid" file access (no dotfiles, parent dirs or absolute paths outside
 * the scratch dir), a time limit, and a throwaway directory per compile.
 */

export interface LatexResult {
  ok: boolean;
  pdf: Buffer | null;
  pages: number | null;
  /** Readable TeX errors ("! Undefined control sequence." + the offending line). */
  errors: string[];
  /** Extracted PDF text, for content checks. */
  text: string | null;
}

function run(file: string, args: string[], cwd: string, timeoutMs: number) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      file, args,
      { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, PATH: toolPath(), openin_any: "p", openout_any: "p" } },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as NodeJS.ErrnoException).code === "number" ? Number((err as NodeJS.ErrnoException).code) : -1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      }
    );
  });
}

/** Pulls "! message" blocks and their "l.<n> …" line out of a TeX log. */
export function texErrors(log: string): string[] {
  const lines = log.split("\n");
  const out: string[] = [];
  lines.forEach((line, i) => {
    if (!line.startsWith("!")) return;
    const where = lines.slice(i + 1, i + 8).find((l) => /^l\.\d+/.test(l));
    out.push(where ? `${line.slice(2).trim()} (line ${where.match(/^l\.(\d+)/)![1]}: ${where.replace(/^l\.\d+\s*/, "").trim().slice(0, 80)})` : line.slice(2).trim());
  });
  return [...new Set(out)].slice(0, 8);
}

export async function compileLatex(source: string, timeoutMs = 60_000): Promise<LatexResult> {
  if (source.length > 500_000) return { ok: false, pdf: null, pages: null, errors: ["The .tex is too large"], text: null };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jm-edit-"));
  try {
    fs.writeFileSync(path.join(dir, "resume.tex"), source);
    // Twice, like the plugin does, so references and layout settle.
    let r = { code: 0, stdout: "", stderr: "" };
    for (let pass = 0; pass < 2; pass++) {
      r = await run("pdflatex", ["-no-shell-escape", "-interaction=nonstopmode", "-halt-on-error", "resume.tex"], dir, timeoutMs);
      if (r.code !== 0) break;
    }
    const pdfPath = path.join(dir, "resume.pdf");
    if (r.code !== 0 || !fs.existsSync(pdfPath)) {
      const log = fs.existsSync(path.join(dir, "resume.log")) ? fs.readFileSync(path.join(dir, "resume.log"), "utf8") : r.stdout;
      const errors = texErrors(log);
      return { ok: false, pdf: null, pages: null, errors: errors.length ? errors : ["LaTeX failed to compile"], text: null };
    }
    const info = await run("pdfinfo", [pdfPath], dir, 15_000);
    const pages = Number(info.stdout.match(/^Pages:\s+(\d+)/m)?.[1] ?? NaN);
    const txt = await run("pdftotext", ["-layout", pdfPath, "-"], dir, 15_000);
    return { ok: true, pdf: fs.readFileSync(pdfPath), pages: Number.isNaN(pages) ? null : pages, errors: [], text: txt.code === 0 ? txt.stdout : null };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
