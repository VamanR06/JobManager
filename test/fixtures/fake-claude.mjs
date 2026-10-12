#!/usr/bin/env node
/**
 * Stand-in for `claude -p --output-format stream-json` in tests. Mode comes from
 * a `FAKE_MODE: <mode>` marker in ./job_description.md.
 */
import { execFileSync } from "child_process";
import fs from "fs";

const args = process.argv.slice(2);
fs.writeFileSync("argv.json", JSON.stringify(args));
const prompt = fs.readFileSync(0, "utf8");
const skillDir = prompt.match(/Its files are in: (.+)/)?.[1]?.trim() ?? "";
const pluginDir = args[args.indexOf("--plugin-dir") + 1];
const mode = fs.readFileSync("job_description.md", "utf8").match(/FAKE_MODE: (\w+)/)?.[1] ?? "success";

const emit = (e) => process.stdout.write(JSON.stringify(e) + "\n");
let n = 0;
const tool = (name, input) => {
  const id = `t${n++}`;
  emit({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
  emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
};

emit({ type: "system", subtype: "init", session_id: "fake-claude-session", model: "fake", permissionMode: "dontAsk" });

if (mode === "auth_error") {
  emit({ type: "result", subtype: "success", is_error: true, result: "Invalid API key · Please run /login", usage: {} });
  process.exit(1);
}

if (mode !== "no_evidence") {
  tool("Skill", { skill: "resume-builder:instructions" });
  // Reads through the wrapper symlink, as the real CLI does.
  for (const f of ["SKILL.md", "lookup/knowledge-index.json", "references/tailored_resume_builder_spec.md", "references/Example.tex"]) {
    tool("Read", { file_path: `${pluginDir}/skills/instructions/${f}` });
  }
  tool("Read", { file_path: "./work/content_bank/Vaman_Rajagopal_Resume_Content_Bank_Expanded/README.md" });
}

fs.mkdirSync("output", { recursive: true });
fs.writeFileSync("output/resume.tex", `\\documentclass{article}
\\begin{document}
Test Candidate \\\\ test.candidate@example.com
\\section*{Education} U
\\section*{Experience} E
\\section*{Projects} P
\\section*{Technical Skills} S
\\end{document}
`);
execFileSync("pdflatex", ["-no-shell-escape", "-interaction=nonstopmode", "-halt-on-error", "-output-directory", "output", "output/resume.tex"], { stdio: "ignore" });
tool("Bash", { command: "pdflatex -no-shell-escape -output-directory output output/resume.tex" });
fs.writeFileSync("output/validation.md", "# ok\n");

emit({
  type: "result", subtype: "success", is_error: false, num_turns: 9, total_cost_usd: 0.42,
  usage: { input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 50 },
  structured_output: {
    status: "completed", pdf_path: "output/resume.pdf", tex_path: "output/resume.tex",
    validation_report_path: "output/validation.md", validation_summary: "ok",
    plugin: { skill_name: mode === "wrong_skill" ? "gpt-fake:instructions" : "resume-builder:instructions", version: null, skill_file: null },
    resources_loaded: [], revision_count: 1, unresolved_failures: [], coverage_gaps: [], blockers: [],
  },
});
process.exit(0);
