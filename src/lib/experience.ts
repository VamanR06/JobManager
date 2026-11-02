import { getDb } from "./db";
import type { WorkExperience, WorkExperienceInput } from "./workflow-types";

/** Work experience on the Profile page, most recent first: what fills Work Experience 1, 2, … on a form. */

type Row = Omit<WorkExperience, "current"> & { current: number };

export function listExperiences(): WorkExperience[] {
  return (getDb()
    .prepare("SELECT id, title, company, location, start_month, end_month, current, description FROM work_experiences ORDER BY position, id")
    .all() as Row[]).map((r) => ({ ...r, current: r.current === 1 }));
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Checks and tidies what the editor sent: the clean list, or a message about the first problem. */
export function parseExperiences(value: unknown): WorkExperienceInput[] | string {
  if (!Array.isArray(value) || value.length > 30) return "experiences must be a list";
  const out: WorkExperienceInput[] = [];
  for (const [i, raw] of value.entries()) {
    if (!raw || typeof raw !== "object") return "experiences must be a list";
    const e = raw as Record<string, unknown>;
    const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
    const month = (v: unknown) => (typeof v === "string" && MONTH.test(v.trim()) ? v.trim() : null);
    const current = e.current === true;
    const entry: WorkExperienceInput = {
      title: text(e.title, 200),
      company: text(e.company, 200),
      location: text(e.location, 200),
      start_month: month(e.start_month),
      end_month: current ? null : month(e.end_month),
      current,
      description: text(e.description, 5000),
    };
    if (!entry.title || !entry.company) return `Experience ${i + 1} needs a job title and a company`;
    if (entry.start_month && entry.end_month && entry.end_month < entry.start_month) {
      return `Experience ${i + 1} ends before it starts`;
    }
    out.push(entry);
  }
  return out;
}

/** Replaces the whole list, in the order given. Saving through the editor is the user confirming it. */
export function setExperiences(list: WorkExperienceInput[]): WorkExperience[] {
  const db = getDb();
  db.transaction(() => {
    db.prepare("DELETE FROM work_experiences").run();
    const insert = db.prepare(
      `INSERT INTO work_experiences (position, title, company, location, start_month, end_month, current, description)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    list.forEach((e, i) =>
      insert.run(i, e.title, e.company, e.location, e.start_month, e.current ? null : e.end_month, e.current ? 1 : 0, e.description)
    );
  })();
  return listExperiences();
}
