import "./setup-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { getDb } from "../src/lib/db";
import { saveSnapshot, setProfileFacts } from "../src/lib/automation";
import { createJob } from "../src/lib/queries";
import { runResumeBuilder } from "../src/lib/codex/resume";
import { fakeConfig, fakePreflight } from "./helpers";

getDb();
const preflight = { ...fakePreflight(), engine: "claude" as const };
const FAKE_CLAUDE = path.join(__dirname, "fixtures", "fake-claude.mjs");
setProfileFacts({ full_name: "Test Candidate", email: "test.candidate@example.com" });

async function run(mode: string) {
  const job = createJob({ company: "Acme", title: "SWE", url: "https://jobs.example.com/1" });
  const snapshot = saveSnapshot(job.id, "https://jobs.example.com/1", {
    title: "SWE", company: "Acme", location: null, employment_type: null, posting_id: null,
    description_md: `FAKE_MODE: ${mode}\nsecret-marker $(whoami)`, final_url: "https://jobs.example.com/1",
    canonical_url: null, application_url: null, method: "html",
  });
  return runResumeBuilder({
    jobId: job.id, taskId: null, attempt: 1, owner: "test", snapshot,
    profile: { full_name: "Test Candidate", email: "test.candidate@example.com" },
    preflight, config: fakeConfig(), engine: "claude",
    claude: { bin: FAKE_CLAUDE, model: null, effort: "medium" },
  });
}

test("a Claude run through the wrapper plugin is verified like a Codex run", async () => {
  const r = await run("success");
  assert.equal(r.outcome, "verified", r.message);
  const row = getDb().prepare("SELECT * FROM codex_runs WHERE id = ?").get(r.runId) as Record<string, unknown>;
  assert.equal(row.engine, "claude");
  assert.equal(row.session_id, "fake-claude-session");
  assert.equal(JSON.parse(row.usage as string).cli_reported_cost_usd, 0.42);
  // Reads through the wrapper symlink count as reads of the real skill folder.
  assert.ok(r.verification!.checks.some((c) => c.name === "plugin_resources_read" && c.status === "pass"));
  // The wrapper points at the installed skill folder rather than a copy.
  const wrapper = r.process && JSON.parse(fs.readFileSync(path.join(r.workDir, "argv.json"), "utf8")) as string[];
  const pluginDir = wrapper[wrapper.indexOf("--plugin-dir") + 1];
  assert.equal(fs.readlinkSync(path.join(pluginDir, "skills", "instructions")), preflight.plugin!.skillDir);
});

test("Claude is launched locked down, with no job text on the command line", async () => {
  const r = await run("success");
  const argv = JSON.parse(fs.readFileSync(path.join(r.workDir, "argv.json"), "utf8")) as string[];
  for (const flag of ["--restricted", "--strict-mcp-config", "--no-session-persistence"]) assert.ok(argv.includes(flag), flag);
  assert.equal(argv[argv.indexOf("--permission-mode") + 1], "dontAsk");
  assert.ok(!argv.some((a) => /bypassPermissions|dangerously/.test(a)));
  const settings = JSON.parse(argv[argv.indexOf("--settings") + 1]);
  assert.equal(settings.sandbox.enabled, true);
  assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
  assert.ok(settings.permissions.deny.some((d: string) => d.includes("/.ssh/")));
  assert.ok(settings.permissions.deny.some((d: string) => d.includes("app.db")));
  // The attempt folder itself must stay readable even when it sits under the data dir.
  assert.ok(!settings.permissions.deny.some((d: string) => r.workDir.startsWith(d.replace(/^Read\(\/|\/\*\*\)$|\*?\)$/g, ""))));
  assert.ok(!argv.join(" ").includes("secret-marker"));
});

test("Claude login problems block with a Claude-specific message", async () => {
  const r = await run("auth_error");
  assert.equal(r.outcome, "blocked");
  assert.match(r.message, /claude auth login/);
});

test("Claude output without evidence of reading the skill is rejected", async () => {
  const r = await run("no_evidence");
  assert.equal(r.outcome, "verification_failed");
  assert.match(r.message, /Load the Resume Builder skill resources/);
});

test("Claude naming a different skill is rejected", async () => {
  const r = await run("wrong_skill");
  assert.equal(r.outcome, "verification_failed");
  assert.match(r.message, /expected "resume-builder:instructions"/);
});
