import "./setup-env";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { getDb } from "../src/lib/db";
import { createJob, updateJob } from "../src/lib/queries";
import { saveUploadedDocument } from "../src/lib/documents";
import { parseExperiences, setExperiences } from "../src/lib/experience";
import { experiencesForJob, matchExperiences } from "../src/lib/resume-experience";
import { BrowserOwner } from "../src/lib/apply/browser";
import type { WorkExperience, WorkExperienceInput } from "../src/lib/workflow-types";

// Work Experience sections get the Profile jobs the job's resume mentions, in the resume's order.

getDb();
const browser = new BrowserOwner({ headless: true, allowLocal: true, profileDir: fs.mkdtempSync(path.join(os.tmpdir(), "jm-profile-")) });
after(() => browser.close());

const job = (title: string, company: string, i: number): WorkExperience => ({
  id: i, title, company, location: "", start_month: null, end_month: null, current: false, description: "",
});
const PROFILE = [
  job("Software Engineer Intern", "Acme Inc.", 1),
  job("Research Assistant", "University of Michigan", 2),
  job("Teaching Assistant", "University of Michigan", 3),
  job("Barista", "Blue Bottle Coffee", 4),
  job("Engineer", "Initech", 5),
];

const RESUME = `Test Candidate · test@example.com
EXPERIENCE
Teaching Assistant — University of Michigan, Ann Arbor, MI    Jan 2025 – Present
• Led discussion sections
Acme — Software Engineer Intern    May 2024 – Aug 2024
• Built the thing
Initech — Engineer
EDUCATION
University of Michigan, B.S.E. Computer Science`;

test("only the jobs the resume names, in its order", () => {
  const picked = matchExperiences(PROFILE, RESUME).map((e) => `${e.title} @ ${e.company}`);
  assert.deepEqual(picked, [
    "Teaching Assistant @ University of Michigan",  // shares a company, so placed (and kept) by its title
    "Software Engineer Intern @ Acme Inc.",         // "Inc." left off on the resume
    "Engineer @ Initech",
  ]);
});

test("a company has to appear as whole words", () => {
  assert.deepEqual(matchExperiences([job("Dev", "Meta", 1)], "Worked on metadata pipelines"), []);
  assert.equal(matchExperiences([job("Dev", "Meta", 1)], "Meta, Menlo Park — Dev").length, 1);
});

test("the job's resume decides, with every Profile job as the fallback", async () => {
  setExperiences(parseExperiences(PROFILE.map(({ id: _, ...e }) => e)) as WorkExperienceInput[]);

  const noResume = createJob({ company: "Bigco", title: "Engineer" });
  const none = await experiencesForJob(noResume.id);
  assert.equal(none.experiences.length, 5);
  assert.match(none.fallback ?? "", /No resume/);

  const page = await browser.pageFor(noResume.id, "about:blank", []);
  await page.setContent(`<pre style="font: 12px sans-serif">${RESUME}</pre>`);
  const pdf = await page.pdf();
  const withPdf = createJob({ company: "Bigco", title: "Engineer 2" });
  updateJob(withPdf.id, { resume_id: saveUploadedDocument("resume", "Candidate_Resume.pdf", pdf).doc.id });
  const fromPdf = await experiencesForJob(withPdf.id);
  assert.equal(fromPdf.fallback, null);
  assert.deepEqual(fromPdf.experiences.map((e) => e.company), ["University of Michigan", "Acme Inc.", "Initech"]);

  const unrelated = createJob({ company: "Bigco", title: "Engineer 3" });
  updateJob(unrelated.id, { resume_id: saveUploadedDocument("resume", "Other.txt", Buffer.from("Nothing here")).doc.id });
  const other = await experiencesForJob(unrelated.id);
  assert.equal(other.experiences.length, 5);
  assert.match(other.fallback ?? "", /doesn't name any/);
});
