#!/usr/bin/env node
/** Stand-in for codex/claude when drafting answers. Mode via FAKE_MODE in job_description.md. */
import fs from "fs";
const args = process.argv.slice(2);
fs.writeFileSync("argv.json", JSON.stringify(args));
fs.readFileSync(0, "utf8");
const mode = fs.readFileSync("job_description.md", "utf8").match(/FAKE_MODE: (\w+)/)?.[1] ?? "ok";
const qs = JSON.parse(fs.readFileSync("questions.json", "utf8"));
const drafts = qs.map((q) => ({
  field_key: q.field_key,
  answer: q.max_length ? "x".repeat(q.max_length + 10) : `I built FastAPI services at Everstory, which matches ${q.question.length} chars.`,
  sources: ["work/content_bank/experiences/10_Everstory_Backend_Developer.tex"],
  unknown_facts: /why/i.test(q.question) ? ["Your personal reason for choosing this company"] : [],
}));
drafts.push({ field_key: "not-asked", answer: "sneaky", sources: [], unknown_facts: [] });
const result = mode === "malformed" ? { drafts: [{ answer: "missing key" }] } : { drafts };
if (args[0] === "exec") {
  fs.writeFileSync(args[args.indexOf("-o") + 1], JSON.stringify(result));
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "t" }) + "\n");
} else {
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "s" }) + "\n");
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, usage: {}, structured_output: result }) + "\n");
}
process.exit(0);
