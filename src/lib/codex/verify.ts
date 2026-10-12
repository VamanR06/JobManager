import { execFile } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import type { ArtifactCheck } from "../workflow-types";
import { toolPath } from "./toolpath";
import type { PluginInfo } from "./preflight";
import type { CommandEvidence } from "./process";
import type { ResumeRunResultJson } from "./schema";

/**
 * Independent checks on what a Resume Builder run produced. A `completed` status
 * or exit code 0 is never taken as proof: the files must exist inside this
 * attempt's output folder, be fresh, parse, compile, and match each other.
 * Only checks that actually ran are reported as passing.
 */

export interface VerifyInput {
  workDir: string;
  /** Files older than this belong to some earlier attempt. */
  runStartedMs: number;
  result: ResumeRunResultJson;
  plugin: PluginInfo;
  commands: CommandEvidence[];
  profile: Record<string, string>;
  /** The skill name the engine exposes (`<plugin>:instructions`); defaults to the Codex name. */
  expectedSkill?: string;
}

export interface VerifyOutcome {
  passed: boolean;
  checks: ArtifactCheck[];
  /** Concrete, actionable failures — fed back to the plugin on a repair run. */
  failures: string[];
  pdfAbs: string | null;
  texAbs: string | null;
  reportAbs: string | null;
  pageCount: number | null;
}

export const EXPECTED_SECTIONS = ["Education", "Experience", "Projects", "Skills"];

function exec(file: string, args: string[], opts: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      file, args,
      { cwd: opts.cwd, timeout: opts.timeoutMs ?? 30_000, env: { ...(opts.env ?? process.env), PATH: toolPath() }, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as NodeJS.ErrnoException).code === "number" ? Number((err as NodeJS.ErrnoException).code) : -1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      }
    );
  });
}

/**
 * Resolves a path the model reported. It must be relative, stay inside
 * `<workDir>/output`, and not be (or pass through) a symlink pointing elsewhere.
 */
export function resolveArtifactPath(workDir: string, rel: string | null, exts: string[]): { ok: true; abs: string } | { ok: false; reason: string } {
  if (!rel) return { ok: false, reason: "no path returned" };
  if (path.isAbsolute(rel)) return { ok: false, reason: `absolute path rejected (${rel})` };
  const outputDir = path.join(workDir, "output");
  const abs = path.resolve(workDir, rel);
  if (!abs.startsWith(outputDir + path.sep)) return { ok: false, reason: `path escapes the output folder (${rel})` };
  if (!exts.includes(path.extname(abs).toLowerCase())) return { ok: false, reason: `unexpected file type (${rel})` };
  let st: fs.Stats;
  try {
    st = fs.lstatSync(abs);
  } catch {
    return { ok: false, reason: `file does not exist (${rel})` };
  }
  if (st.isSymbolicLink()) return { ok: false, reason: `symlink rejected (${rel})` };
  const real = fs.realpathSync(abs);
  if (!real.startsWith(fs.realpathSync(outputDir) + path.sep)) return { ok: false, reason: `path resolves outside the output folder (${rel})` };
  if (!st.isFile()) return { ok: false, reason: `not a regular file (${rel})` };
  return { ok: true, abs: real };
}

export const sha256File = (abs: string) => crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");

const normalizeText = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** Which plugin resources the agent's own commands touched. Self-reporting doesn't count. */
export function resourceEvidence(commands: CommandEvidence[], plugin: PluginInfo) {
  const all = commands.map((c) => c.command).join("\n");
  const inPlugin = (file: string) =>
    commands.some((c) => c.command.includes(file) && (c.command.includes(plugin.skillDir) || c.command.includes(plugin.root)));
  return {
    skill: inPlugin("SKILL.md"),
    knowledgeIndex: inPlugin("knowledge-index.json"),
    spec: inPlugin("tailored_resume_builder_spec.md"),
    exampleTex: inPlugin("Example.tex"),
    contentBank: inPlugin("Resume_Content_Bank") || /Resume_Content_Bank/.test(all),
    compiled: /\b(pdflatex|lualatex|xelatex|latexmk)\b/.test(all),
    renderedInspection: /\b(pdftoppm|pdftocairo|magick|convert|sips)\b/.test(all) || /\bpdftotext\b/.test(all),
  };
}

async function pdfPages(abs: string): Promise<number | null> {
  const info = await exec("pdfinfo", [abs]);
  const m = info.stdout.match(/^Pages:\s+(\d+)/m);
  return m ? Number(m[1]) : null;
}

async function pdfText(abs: string): Promise<string | null> {
  const r = await exec("pdftotext", ["-layout", abs, "-"]);
  return r.code === 0 ? r.stdout : null;
}

/** Rebuilds the PDF from the returned .tex in a scratch copy, shell escape off. */
async function compileTex(texAbs: string): Promise<{ ok: boolean; pdf: string | null; log: string }> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "jm-tex-"));
  try {
    fs.cpSync(path.dirname(texAbs), scratch, { recursive: true, dereference: false, filter: (src) => !fs.lstatSync(src).isSymbolicLink() });
    const name = path.basename(texAbs);
    const r = await exec(
      "pdflatex",
      ["-no-shell-escape", "-interaction=nonstopmode", "-halt-on-error", "-output-directory", scratch, name],
      // kpathsea "paranoid" mode: no reading dotfiles or parent dirs, no writing outside.
      { cwd: scratch, timeoutMs: 120_000, env: { ...process.env, openin_any: "p", openout_any: "p" } }
    );
    const pdf = path.join(scratch, name.replace(/\.tex$/i, ".pdf"));
    if (r.code !== 0 || !fs.existsSync(pdf)) return { ok: false, pdf: null, log: (r.stdout + r.stderr).slice(-1500) };
    const keep = path.join(os.tmpdir(), `jm-recompiled-${process.pid}-${Date.now()}.pdf`);
    fs.copyFileSync(pdf, keep);
    return { ok: true, pdf: keep, log: "" };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

export async function verifyResumeOutput(input: VerifyInput): Promise<VerifyOutcome> {
  const checks: ArtifactCheck[] = [];
  const failures: string[] = [];
  const out: VerifyOutcome = { passed: false, checks, failures, pdfAbs: null, texAbs: null, reportAbs: null, pageCount: null };
  const pass = (name: string, detail: string) => checks.push({ name, status: "pass", detail });
  const skip = (name: string, detail: string) => checks.push({ name, status: "skipped", detail });
  const fail = (name: string, detail: string, feedback?: string) => {
    checks.push({ name, status: "fail", detail });
    failures.push(feedback ?? detail);
  };

  // 1. Plugin identity: the name must match AND the agent must have read the resources.
  const expectedSkill = input.expectedSkill ?? `${input.plugin.ref.split("@")[0]}:instructions`;
  if (input.result.plugin.skill_name !== expectedSkill) {
    fail("plugin_identity", `Result names skill "${input.result.plugin.skill_name}", expected "${expectedSkill}"`);
  }
  const ev = resourceEvidence(input.commands, input.plugin);
  const missingEvidence = (["skill", "spec", "exampleTex", "contentBank"] as const).filter((k) => !ev[k]);
  if (missingEvidence.length) {
    fail(
      "plugin_resources_read",
      `No evidence the run read: ${missingEvidence.join(", ")}`,
      `Load the Resume Builder skill resources before generating (missing: ${missingEvidence.join(", ")}).`
    );
  } else {
    pass("plugin_resources_read", `Read SKILL.md, the full spec, Example.tex and the content bank${ev.knowledgeIndex ? ", and the knowledge index" : ""}`);
  }
  if (ev.compiled) pass("plugin_rendered", "The run compiled LaTeX itself");
  else fail("plugin_rendered", "No LaTeX compilation observed in the run", "Render the LaTeX to PDF and inspect it before returning.");

  if (input.result.status !== "completed") {
    fail("result_status", `Plugin returned status "${input.result.status}"`);
    return out;
  }
  for (const f of input.result.unresolved_failures) fail("plugin_unresolved", f);
  // Truthful omissions: shown for review, never sent back as something to "fix".
  if (input.result.coverage_gaps.length) {
    skip("coverage_gaps", `Not claimed (no support in the content bank): ${input.result.coverage_gaps.join(" ")}`);
  }

  // 2–3. Paths, existence, freshness.
  const pdf = resolveArtifactPath(input.workDir, input.result.pdf_path, [".pdf"]);
  const tex = resolveArtifactPath(input.workDir, input.result.tex_path, [".tex"]);
  if (!pdf.ok) fail("pdf_path", `PDF: ${pdf.reason}`, `PDF rejected: ${pdf.reason}. Save the final PDF under ./output/ and return its relative path.`);
  if (!tex.ok) fail("tex_path", `LaTeX: ${tex.reason}`, `LaTeX rejected: ${tex.reason}. Save the final .tex under ./output/ and return its relative path.`);
  if (!pdf.ok || !tex.ok) return out;
  out.pdfAbs = pdf.abs;
  out.texAbs = tex.abs;
  for (const [label, abs] of [["pdf", pdf.abs], ["tex", tex.abs]] as const) {
    const st = fs.statSync(abs);
    if (st.size === 0) fail(`${label}_nonempty`, `${label.toUpperCase()} file is empty`);
    // Small slack for filesystem timestamp granularity.
    if (st.mtimeMs < input.runStartedMs - 2_000) fail(`${label}_fresh`, `${label.toUpperCase()} predates this attempt (stale output)`);
  }
  if (input.result.validation_report_path) {
    const rep = resolveArtifactPath(input.workDir, input.result.validation_report_path, [".md", ".txt", ".json"]);
    if (rep.ok) out.reportAbs = rep.abs;
    else fail("report_path", `Validation report: ${rep.reason}`);
  }

  // 4. PDF structure, page count, text.
  const head = Buffer.alloc(5);
  const fd = fs.openSync(pdf.abs, "r");
  fs.readSync(fd, head, 0, 5, 0);
  fs.closeSync(fd);
  if (head.toString("latin1") !== "%PDF-") {
    fail("pdf_parse", "File is not a PDF");
    return out;
  }
  out.pageCount = await pdfPages(pdf.abs);
  if (out.pageCount === null) fail("pdf_parse", "pdfinfo could not read the PDF");
  else if (out.pageCount !== 1) fail("one_page", `PDF has ${out.pageCount} pages`, `The PDF is ${out.pageCount} pages; it must be exactly one page.`);
  else pass("one_page", "Exactly one page");

  const text = await pdfText(pdf.abs);
  if (!text?.trim()) {
    fail("ats_text", "No extractable text in the PDF", "The PDF has no extractable text; ATS parsing would fail.");
  } else {
    const norm = normalizeText(text);
    const missing = EXPECTED_SECTIONS.filter((s) => !norm.includes(s.toLowerCase()));
    if (missing.length) fail("ats_sections", `Section headings not found in extracted text: ${missing.join(", ")}`);
    else pass("ats_sections", "Education, Experience, Projects and Skills headings extract as text");
    // Identity facts: only what the user confirmed in the profile. Values are not logged.
    const identity = (["full_name", "email"] as const).filter((k) => input.profile[k]);
    if (!identity.length) skip("identity", "No verified name/email in the profile to compare against");
    else {
      const absent = identity.filter((k) => !norm.includes(normalizeText(input.profile[k])));
      if (absent.length) fail("identity", `Verified ${absent.join(" and ")} not found in the PDF text`, `The resume must show the candidate's verified ${absent.join(" and ")} exactly.`);
      else pass("identity", `Verified ${identity.join(" and ")} present`);
    }
  }

  // 5. LaTeX parses, compiles on its own, and produces this same PDF.
  const texSrc = fs.readFileSync(tex.abs, "utf8");
  if (!/\\documentclass/.test(texSrc) || !/\\begin\{document\}/.test(texSrc) || !/\\end\{document\}/.test(texSrc)) {
    fail("tex_parse", "LaTeX source is missing \\documentclass or the document environment");
  } else {
    const compiled = await compileTex(tex.abs);
    if (!compiled.ok) {
      fail("tex_compiles", "Returned .tex does not compile with shell escape disabled", `The returned .tex fails to compile: ${compiled.log.slice(-400)}`);
    } else {
      const again = await pdfText(compiled.pdf!);
      fs.rmSync(compiled.pdf!, { force: true });
      if (text && again && normalizeText(again) === normalizeText(text)) pass("tex_matches_pdf", "Recompiling the .tex reproduces the PDF's text");
      else fail("tex_matches_pdf", "The PDF's text differs from what the .tex compiles to", "The returned PDF was not built from the returned .tex; return the matching pair.");
    }
  }

  if (out.reportAbs) pass("report_present", "Plugin wrote a validation report");
  else skip("report_present", "No validation report returned");
  // Visual quality (wrapping, whitespace) is judged inside the plugin's own render/inspect loop; we don't claim to check it here.
  skip("visual_review", "Line wrapping and whitespace were checked by the plugin's own rendered-page inspection, not independently");

  out.passed = !checks.some((c) => c.status === "fail");
  return out;
}
