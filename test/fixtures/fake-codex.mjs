#!/usr/bin/env node
/**
 * Stand-in for `codex exec` in tests. Reads the task prompt from stdin like the
 * real CLI, emits JSONL events, and writes artifacts/result files. Its behaviour
 * is picked by a `FAKE_MODE: <mode>` marker in ./job_description.md, because the
 * runner deliberately passes Codex a stripped environment.
 */
import { execFileSync, spawn } from "child_process";
import fs from "fs";
import path from "path";

const args = process.argv.slice(2);
fs.writeFileSync("argv.json", JSON.stringify(args));
const outFile = args[args.indexOf("-o") + 1];

const prompt = fs.readFileSync(0, "utf8");
const skillDir = prompt.match(/Its files are in: (.+)/)?.[1]?.trim() ?? "";
const mode = fs.readFileSync("job_description.md", "utf8").match(/FAKE_MODE: (\w+)/)?.[1] ?? "success";

const emit = (e) => process.stdout.write(JSON.stringify(e) + "\n");
const cmd = (command, exit_code = 0) =>
  emit({ type: "item.completed", item: { id: `i${Math.random()}`, type: "command_execution", command, aggregated_output: "", exit_code, status: "completed" } });

emit({ type: "thread.started", thread_id: "fake-thread-0001" });
emit({ type: "turn.started" });
// Progress messages that look like a final result: must never be taken as one.
emit({ type: "item.completed", item: { id: "m0", type: "agent_message", text: JSON.stringify({ status: "completed", pdf_path: null }) } });

if (mode === "auth_error") {
  process.stderr.write("ERROR: unexpected status 401 Unauthorized: token has expired\n");
  process.exit(1);
}
if (mode === "quota") {
  emit({ type: "turn.failed", error: { message: "You've hit your usage limit. Try again later." } });
  process.exit(1);
}
if (mode === "nonzero_exit") {
  process.stderr.write("thread panicked\n");
  process.exit(3);
}
if (mode === "hang") {
  // A grandchild in the same process group: must die with us on timeout/cancel.
  const child = spawn("sleep", ["1000"], { stdio: "ignore" });
  fs.writeFileSync("grandchild.pid", String(child.pid));
  setInterval(() => {}, 1000);
} else {
  run();
}

function tex(name, pages = 1) {
  const extra = pages > 1 ? "\\newpage Second page\n" : "";
  return `\\documentclass{article}
\\begin{document}
${name} \\\\ test.candidate@example.com
\\section*{Education} University of Somewhere
\\section*{Experience} Built things
\\section*{Projects} A project
\\section*{Technical Skills} TypeScript
${extra}\\end{document}
`;
}

function compile(file) {
  execFileSync("pdflatex", ["-no-shell-escape", "-interaction=nonstopmode", "-halt-on-error", "-output-directory", "output", file], { stdio: "ignore" });
  cmd(`/bin/zsh -lc "pdflatex -no-shell-escape ${file}"`);
}

function result(overrides = {}) {
  return {
    status: "completed",
    pdf_path: "output/resume.pdf",
    tex_path: "output/resume.tex",
    validation_report_path: "output/validation.md",
    validation_summary: "One page, all checks passed.",
    plugin: { skill_name: "gpt-fake:instructions", version: "0.0.1", skill_file: `${skillDir}/SKILL.md` },
    resources_loaded: ["SKILL.md", "tailored_resume_builder_spec.md"],
    revision_count: 1,
    unresolved_failures: [],
    coverage_gaps: ["No Kubernetes experience in the content bank"],
    blockers: [],
    ...overrides,
  };
}

function run() {
  if (mode !== "no_evidence") {
    for (const f of ["SKILL.md", "lookup/knowledge-index.json", "references/tailored_resume_builder_spec.md", "references/Example.tex"]) {
      cmd(`/bin/zsh -lc "sed -n '1,200p' '${skillDir}/${f}'"`);
    }
    cmd(`/bin/zsh -lc "unzip -o '${skillDir}/references/Vaman_Rajagopal_Resume_Content_Bank.zip' -d work"`);
  }
  if (mode === "malformed_jsonl") {
    process.stdout.write("this is not json\n{\"broken\": \n");
  }

  fs.mkdirSync("output", { recursive: true });
  if (mode === "needs_input") {
    fs.writeFileSync(outFile, JSON.stringify(result({
      status: "needs_input", pdf_path: null, tex_path: null, validation_report_path: null,
      blockers: [{ code: "description_incomplete", message: "The description has no responsibilities section." }],
    })));
    return done();
  }
  if (mode === "plugin_failed") {
    fs.writeFileSync(outFile, JSON.stringify(result({
      status: "failed", pdf_path: null, tex_path: null, validation_report_path: null,
      blockers: [{ code: "plugin_unavailable", message: "Skill gpt-fake:instructions is not available." }],
    })));
    return done();
  }
  if (mode === "no_result") return done();
  if (mode === "invalid_result") {
    fs.writeFileSync(outFile, JSON.stringify({ status: "completed", pdf: "output/resume.pdf", extra: true }));
    return done();
  }
  if (mode === "missing_artifacts") {
    fs.writeFileSync(outFile, JSON.stringify(result()));
    return done();
  }

  fs.writeFileSync("output/resume.tex", tex("Test Candidate", mode === "two_pages" ? 2 : 1));
  compile("output/resume.tex");
  fs.writeFileSync("output/validation.md", "# Validation\n- one page\n");

  if (mode === "mismatched") {
    // PDF from a different .tex than the one returned.
    fs.writeFileSync("output/other.tex", tex("Someone Else"));
    compile("output/other.tex");
    fs.renameSync("output/other.pdf", "output/resume.pdf");
  }
  if (mode === "stale_outputs") {
    const old = new Date(Date.now() - 3600_000);
    fs.utimesSync("output/resume.pdf", old, old);
    fs.utimesSync("output/resume.tex", old, old);
  }
  if (mode === "symlink_escape") {
    fs.rmSync("output/resume.pdf");
    fs.symlinkSync("/etc/hosts", "output/resume.pdf");
  }
  const overrides =
    mode === "escape_path" ? { pdf_path: "../../../../etc/passwd.pdf" }
    : mode === "absolute_path" ? { pdf_path: path.resolve("output/resume.pdf") }
    : {};
  fs.writeFileSync(outFile, JSON.stringify(result(overrides)));
  done();
}

function done() {
  emit({ type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 10, output_tokens: 200 } });
  process.exit(0);
}
