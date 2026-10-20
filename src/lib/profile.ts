import { getDb } from "./db";
import type { ProfileFact } from "./workflow-types";

/** The Profile: verified facts the form filler (apply/answers.ts) answers from. */

export function listProfile(): ProfileFact[] {
  return getDb().prepare("SELECT * FROM profile_facts ORDER BY key").all() as ProfileFact[];
}

export function getProfileMap(): Record<string, string> {
  return Object.fromEntries(listProfile().map((f) => [f.key, f.value]));
}

/** Saving through the editor is the user confirming the value. Blank deletes it. */
export function setProfileFacts(values: Record<string, string>): void {
  const db = getDb();
  db.transaction(() => {
    for (const [key, raw] of Object.entries(values)) {
      const value = raw.trim();
      if (!value) {
        db.prepare("DELETE FROM profile_facts WHERE key = ?").run(key);
        continue;
      }
      db.prepare(
        `INSERT INTO profile_facts (key, value, verified_at, updated_at)
         VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value, updated_at = excluded.updated_at,
           verified_at = CASE WHEN profile_facts.value = excluded.value THEN profile_facts.verified_at ELSE excluded.verified_at END`
      ).run(key, value);
    }
  })();
}
