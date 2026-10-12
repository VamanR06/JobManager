import "./setup-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { compileLatex } from "../src/lib/latex";

const doc = (body: string) => `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;

test("a hand edit compiles to a one-page PDF with extractable text", async () => {
  const r = await compileLatex(doc("Test Candidate \\textbf{bold words} here"));
  assert.equal(r.ok, true);
  assert.equal(r.pages, 1);
  assert.match(r.text ?? "", /bold words/);
});

test("mistakes come back as readable errors with the line number", async () => {
  const r = await compileLatex(doc("Hello \\textbff{oops}"));
  assert.equal(r.ok, false);
  assert.match(r.errors.join("\n"), /Undefined control sequence.*line 3/);
});

test("shell escape is off and files outside the scratch folder can't be read", async () => {
  const shell = await compileLatex(doc("\\immediate\\write18{touch /tmp/jm-pwned-latex}done"));
  assert.ok(!fs.existsSync("/tmp/jm-pwned-latex"));
  void shell;
  const read = await compileLatex(doc("\\input{/etc/hosts}"));
  assert.equal(read.ok, false, "absolute paths are refused in paranoid mode");
});

const real = path.join(process.cwd(), "data", "artifacts", "job-196", "v3", "resume.tex");
test("the real Resume Builder template compiles through this path", { skip: !fs.existsSync(real) }, async () => {
  const r = await compileLatex(fs.readFileSync(real, "utf8"));
  assert.equal(r.ok, true, r.errors.join("; "));
  assert.equal(r.pages, 1);
});
