/**
 * Automation maintenance commands (never starts the server):
 *
 *   npm run db:migrate            back up data/app.db, then apply pending migrations
 *   npm run db:migrate -- --check migrate a VACUUM INTO copy first and compare row counts
 *   npm run codex:doctor          Codex / login / plugin / LaTeX diagnostics
 *   npm run codex:smoke           one real Resume Builder run against a synthetic posting,
 *                                 in a throwaway data dir (spends usage); add `-- --engine claude`
 *                                 to run it through Claude Code instead of Codex
 */
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";

process.env.JOBMANAGER_ROLE ??= "cli";

const LEGACY_TABLES = ["jobs", "status_events", "recordings", "documents", "generations", "postings"];

function counts(db: Database.Database): Record<string, number> {
  return Object.fromEntries(
    LEGACY_TABLES.map((t) => [t, (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n])
  );
}

async function migrate(check: boolean) {
  const live = path.join(process.cwd(), "data", "app.db");
  if (check) {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "jm-migrate-check-"));
    const copy = new Database(live, { readonly: true });
    const before = counts(copy);
    copy.prepare("VACUUM INTO ?").run(path.join(scratch, "app.db"));
    copy.close();
    process.env.JOBMANAGER_DATA_DIR = scratch;
    const { getDb, SCHEMA_VERSION } = await import("../src/lib/db");
    const after = counts(getDb());
    const ok = LEGACY_TABLES.every((t) => before[t] === after[t]);
    console.log(`Migrated a copy to v${SCHEMA_VERSION}: ${ok ? "all existing rows preserved" : "ROW COUNT MISMATCH"}`);
    console.table(LEGACY_TABLES.map((t) => ({ table: t, before: before[t], after: after[t] })));
    fs.rmSync(scratch, { recursive: true, force: true });
    process.exit(ok ? 0 : 1);
  }
  const { getDb, SCHEMA_VERSION, BACKUPS_DIR } = await import("../src/lib/db");
  const db = getDb();
  console.log(`Schema at v${db.pragma("user_version", { simple: true })} (latest v${SCHEMA_VERSION}). Backups: ${BACKUPS_DIR}`);
  console.table([counts(db)]);
}

async function doctor() {
  const { preflight } = await import("../src/lib/codex/preflight");
  const { codexConfig } = await import("../src/lib/codex/config");
  const { claudeConfig } = await import("../src/lib/codex/claude");
  const cfg = codexConfig();
  const codex = await preflight(cfg, "codex");
  const claude = await preflight(cfg, "claude");
  const cc = claudeConfig();
  console.log(`Codex CLI:      ${codex.cliVersion ?? "NOT FOUND"} (${cfg.bin}), ${codex.loggedIn ? "logged in" : "NOT logged in"}`);
  console.log(`Claude CLI:     ${claude.cliVersion ?? "NOT FOUND"} (${cc.bin}), ${claude.loggedIn ? "logged in" : "NOT logged in"}`);
  const r = codex;
  console.log(`Plugin:         ${r.plugin ? `${r.plugin.ref} @ ${r.plugin.version}` : "NOT AVAILABLE"}`);
  if (r.plugin) {
    console.log(`Skill folder:   ${r.plugin.skillDir}`);
    console.log(`Resource hash:  ${r.plugin.resourceHash} (${r.plugin.files.length} files)`);
  }
  for (const [k, v] of Object.entries(r.tools)) console.log(`${k.padEnd(15)} ${v ?? "MISSING"}`);
  console.log(`Codex runs:     effort ${cfg.reasoningEffort ?? "(CLI default)"}, model ${cfg.model ?? "(CLI default)"}`);
  console.log(`Claude runs:    effort ${cc.effort ?? "(CLI default)"}, model ${cc.model ?? "(CLI default)"}`);
  console.log(`Limits:         ${cfg.timeoutMs / 60000} min hard stop, ~${cfg.targetMinutes} min target, repair limit ${cfg.repairLimit}`);
  let failed = false;
  for (const [name, res] of [["Codex", codex], ["Claude", claude]] as const) {
    if (res.blockers.length) {
      failed = true;
      console.log(`\n${name} blockers:`);
      for (const b of res.blockers) console.log(`  - [${b.code}] ${b.message}`);
    } else {
      console.log(`\n${name}: all checks passed.`);
    }
  }
  process.exit(failed ? 1 : 0);
}

async function smoke() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "jm-smoke-"));
  process.env.JOBMANAGER_DATA_DIR = scratch;
  const { getDb } = await import("../src/lib/db");
  const { createJob } = await import("../src/lib/queries");
  const { saveSnapshot } = await import("../src/lib/automation");
  const { preflight } = await import("../src/lib/codex/preflight");
  const { runResumeBuilder } = await import("../src/lib/codex/resume");
  getDb();
  const engine = process.argv.includes("claude") ? "claude" : "codex";
  const pf = await preflight(undefined, engine);
  if (!pf.ok) {
    console.error("Preflight failed:", pf.blockers);
    process.exit(1);
  }
  const job = createJob({ company: "Example Robotics", title: "Software Engineer Intern", url: "https://example.com/jobs/1" });
  const description = fs.readFileSync(path.join(__dirname, "smoke-posting.md"), "utf8");
  const snapshot = saveSnapshot(job.id, "https://example.com/jobs/1", {
    title: "Software Engineer Intern, Backend Platform", company: "Example Robotics", location: "Ann Arbor, MI",
    employment_type: "Internship", posting_id: "1", description_md: description, final_url: "https://example.com/jobs/1",
    canonical_url: null, application_url: null, method: "html",
  });
  console.log(`Running Resume Builder via ${engine} in ${scratch} (this takes several minutes)…`);
  const started = Date.now();
  const r = await runResumeBuilder({ jobId: job.id, taskId: null, attempt: 1, owner: "smoke", snapshot, profile: {}, preflight: pf, engine });
  console.log(`Engine run took ${((Date.now() - started) / 60000).toFixed(1)} min; usage ${JSON.stringify(r.process.usage)}`);
  console.log(`Outcome: ${r.outcome}\n${r.message}`);
  for (const c of r.verification?.checks ?? []) console.log(`  ${c.status.padEnd(7)} ${c.name}: ${c.detail}`);
  console.log(`Work dir kept for inspection: ${r.workDir}`);
  process.exit(r.outcome === "verified" ? 0 : 1);
}

const [cmd, ...rest] = process.argv.slice(2);
const run = cmd === "migrate" ? migrate(rest.includes("--check")) : cmd === "doctor" ? doctor() : cmd === "smoke" ? smoke() : null;
if (!run) {
  console.error("Usage: automation-cli.ts migrate [--check] | doctor | smoke");
  process.exit(2);
}
run.catch((err) => {
  console.error(err);
  process.exit(1);
});
