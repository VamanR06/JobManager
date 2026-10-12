import "./setup-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseResumeResult, RESUME_RESULT_SCHEMA } from "../src/lib/codex/schema";

const valid = {
  status: "completed", pdf_path: "output/resume.pdf", tex_path: "output/resume.tex", validation_report_path: null,
  validation_summary: "ok", plugin: { skill_name: "x:instructions", version: null, skill_file: null },
  resources_loaded: ["SKILL.md"], revision_count: 2, unresolved_failures: [], coverage_gaps: [], blockers: [],
};

test("schema lists every property as required and forbids extras (structured-output rules)", () => {
  const check = (s: { properties?: Record<string, unknown>; required?: readonly string[]; additionalProperties?: boolean; items?: unknown }) => {
    if (s.properties) {
      assert.deepEqual([...(s.required ?? [])].sort(), Object.keys(s.properties).sort());
      assert.equal(s.additionalProperties, false);
      Object.values(s.properties).forEach((p) => check(p as never));
    }
    if (s.items) check(s.items as never);
  };
  check(RESUME_RESULT_SCHEMA as never);
});

test("valid result parses", () => {
  const r = parseResumeResult(JSON.stringify(valid));
  assert.ok(r.ok);
});

test("invalid results are rejected with reasons", () => {
  const cases: [unknown, RegExp][] = [
    [{ ...valid, status: "done" }, /status: not one of/],
    [{ ...valid, extra: 1 }, /unexpected property/],
    [(({ blockers, ...rest }) => rest)(valid), /blockers: required/],
    [{ ...valid, pdf_path: 7 }, /pdf_path: expected string or null/],
    [{ ...valid, revision_count: 1.5 }, /revision_count: expected integer/],
    [{ ...valid, blockers: [{ code: "nope", message: "x" }] }, /code: not one of/],
    [{ ...valid, plugin: { skill_name: "x" } }, /plugin.version: required/],
  ];
  for (const [value, re] of cases) {
    const r = parseResumeResult(JSON.stringify(value));
    assert.ok(!r.ok && r.errors.some((e) => re.test(e)), `${re} in ${JSON.stringify(!r.ok && r.errors)}`);
  }
  const bad = parseResumeResult("{not json");
  assert.ok(!bad.ok && /not valid JSON/.test(bad.errors[0]));
});
