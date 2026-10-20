/**
 * Database migrations (never starts the server):
 *
 *   npm run db:migrate            back up data/app.db, then apply pending migrations
 *   npm run db:migrate -- --check migrate a VACUUM INTO copy first and compare row counts
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
    // Migrations only add rows (e.g. documents for old generated resumes), never remove them.
    const ok = LEGACY_TABLES.every((t) => after[t] >= before[t]);
    console.log(`Migrated a copy to v${SCHEMA_VERSION}: ${ok ? "all existing rows preserved" : "ROWS LOST"}`);
    console.table(LEGACY_TABLES.map((t) => ({ table: t, before: before[t], after: after[t] })));
    fs.rmSync(scratch, { recursive: true, force: true });
    process.exit(ok ? 0 : 1);
  }
  const { getDb, SCHEMA_VERSION, BACKUPS_DIR } = await import("../src/lib/db");
  const db = getDb();
  console.log(`Schema at v${db.pragma("user_version", { simple: true })} (latest v${SCHEMA_VERSION}). Backups: ${BACKUPS_DIR}`);
  console.table([counts(db)]);
}

migrate(process.argv.includes("--check")).catch((err) => {
  console.error(err);
  process.exit(1);
});
