import "./setup-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { getDb } from "../src/lib/db";
import { importFromBrowser } from "../src/lib/browser-import";
import { addUrlsManually } from "../src/lib/inbox";
import { createJob, getJob, getPosting } from "../src/lib/queries";

getDb();
const DESC = "<p>Design and train machine learning models for memory manufacturing, working with process engineers.</p>";
const URL = "https://micron.wd1.myworkdayjobs.com/en-US/External/job/Richardson-TX/Intern---Machine-Learning-Engineering_JR114750";

test("filling in an existing job sets its title (and a placeholder company) along with the description", async () => {
  // Added from the share sheet while the server couldn't read Workday: placeholder company and title.
  const [added] = await addUrlsManually([URL], async () => {
    throw new Error("fetch failed");
  });
  const before = getJob(added.job_id!)!;
  assert.equal(before.title, "(title unknown)");
  assert.equal(before.company, "Micron", "the placeholder taken from the link");

  importFromBrowser({ url: URL, title: "Intern - Machine Learning Engineering", company: "1000 Micron Technology, Inc.", description_html: DESC }, { jobId: before.id });
  const after = getJob(before.id)!;
  assert.equal(after.title, "Intern - Machine Learning Engineering");
  assert.equal(after.company, "1000 Micron Technology, Inc.");
  assert.match(getPosting(before.id)!.description_md, /machine learning models/);
});

test("the title and company shown on /save (possibly edited) replace the job's", () => {
  const job = createJob({ company: "Micron Technology", title: "ML intern?", url: "https://micron.wd1.myworkdayjobs.com/en-US/External/job/Boise-ID/ML-Intern_JR2" });
  importFromBrowser(
    { url: "https://micron.wd1.myworkdayjobs.com/en-US/External/job/Boise-ID/ML-Intern_JR2", title: "ML Intern (Summer 2027)", company: "Micron", description_html: DESC },
    { jobId: job.id }
  );
  const after = getJob(job.id)!;
  assert.equal(after.title, "ML Intern (Summer 2027)");
  assert.equal(after.company, "Micron");
});

test("a blank title or company leaves the job's own value", () => {
  const job = createJob({ company: "Acme", title: "Platform Intern", url: "https://careers.acme.com/jobs/9" });
  importFromBrowser({ url: "https://careers.acme.com/jobs/9", title: "  ", company: "", description_text: "We build the platform everyone uses. Responsibilities include on-call and reviews." }, { jobId: job.id });
  const after = getJob(job.id)!;
  assert.equal(after.title, "Platform Intern");
  assert.equal(after.company, "Acme");
});
