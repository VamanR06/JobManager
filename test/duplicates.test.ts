import "./setup-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { backfillPostingKeys, getDb } from "../src/lib/db";
import { findDuplicates } from "../src/lib/duplicates";
import { importSharedText } from "../src/lib/inbox";
import { createJob, getJob, updateJob } from "../src/lib/queries";
import { POST } from "../src/app/api/jobs/route";

getDb();
const key = (id: number) => (getDb().prepare("SELECT posting_key, ats, posting_id FROM jobs WHERE id = ?").get(id) as { posting_key: string | null; ats: string | null; posting_id: string | null });

const add = async (body: Record<string, unknown>) => {
  const res = await POST(new NextRequest("http://localhost/api/jobs", {
    method: "POST",
    body: JSON.stringify({ posting: { description_md: "Build things." }, ...body }),
  }));
  return { status: res.status, data: await res.json() };
};

test("different links to the same posting are recognised", () => {
  const job = createJob({ company: "Stripe", title: "SWE Intern", url: "https://boards.greenhouse.io/stripe/jobs/7001?gh_src=abc" });
  assert.deepEqual(key(job.id), { posting_key: "greenhouse:7001", ats: "greenhouse", posting_id: "7001" });
  for (const link of [
    "https://job-boards.greenhouse.io/embed/job_app?for=stripe&token=7001",
    "https://stripe.com/jobs/listing/swe-intern/7001?gh_jid=7001&utm_source=linkedin",
    "https://boards.greenhouse.io/stripe/jobs/7001/",
  ]) {
    assert.equal(findDuplicates({ url: link }).same_posting?.id, job.id, link);
  }
  assert.equal(findDuplicates({ url: "https://boards.greenhouse.io/stripe/jobs/7002" }).same_posting, null);
});

test("the Add form asks before adding something already tracked, and can add it anyway", async () => {
  const first = await add({ company: "SpaceX", title: "Software Engineering Intern", url: "https://boards.greenhouse.io/spacex/jobs/8001" });
  assert.equal(first.status, 201);

  const again = await add({ company: "SpaceX", title: "Software Engineering Intern", url: "https://www.spacex.com/careers/detail?gh_jid=8001&utm_campaign=x" });
  assert.equal(again.status, 409);
  assert.equal(again.data.same_posting.id, first.data.id);
  assert.match(again.data.error, /already tracking this posting/);

  const anyway = await add({ company: "SpaceX", title: "Software Engineering Intern", url: "https://www.spacex.com/careers/detail?gh_jid=8001", allow_duplicate: true });
  assert.equal(anyway.status, 201);
  assert.notEqual(anyway.data.id, first.data.id);
});

test("same company and title under another link is a softer warning", async () => {
  const first = await add({ company: "Datadog, Inc.", title: "Software Engineering Intern (Summer)", url: "https://careers.datadoghq.com/detail/9001" });
  const other = await add({ company: "datadog", title: "software engineering intern - summer", url: "https://careers.datadoghq.com/detail/9002" });
  assert.equal(other.status, 409);
  assert.equal(other.data.same_posting, null);
  assert.equal(other.data.similar[0].id, first.data.id);
  assert.match(other.data.error, /company and title/);
  // A different role at the same company is fine.
  assert.equal((await add({ company: "Datadog", title: "Data Science Intern", url: "https://careers.datadoghq.com/detail/9003" })).status, 201);
});

test("changing a job's link updates its key; other edits leave it alone", () => {
  const job = createJob({ company: "Lever Co", title: "Intern", url: "https://jobs.lever.co/leverco/11111111-2222-3333-4444-555555555555" });
  updateJob(job.id, { notes: "hello" });
  assert.equal(key(job.id).posting_key, "lever:11111111-2222-3333-4444-555555555555");
  updateJob(job.id, { url: "https://jobs.ashbyhq.com/leverco/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" });
  assert.deepEqual(key(job.id), { posting_key: "ashby:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", ats: "ashby", posting_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" });
  updateJob(job.id, { url: null });
  assert.equal(key(job.id).posting_key, null);
});

test("missing keys are backfilled, keeping ATS details an import recorded", () => {
  const db = getDb();
  const a = createJob({ company: "Old", title: "Intern", url: "https://boards.greenhouse.io/old/jobs/12345" });
  const b = createJob({ company: "Older", title: "Intern", url: "https://example.com/careers/role?utm_source=x&id=7" });
  db.prepare("UPDATE jobs SET posting_key = NULL WHERE id IN (?, ?)").run(a.id, b.id);
  db.prepare("UPDATE jobs SET ats = 'workday' WHERE id = ?").run(b.id); // e.g. learned from a redirect
  assert.ok(backfillPostingKeys(db) >= 2);
  assert.equal(key(a.id).posting_key, "greenhouse:12345");
  assert.equal(key(b.id).posting_key, "url:example.com/careers/role?id=7");
  assert.equal(key(b.id).ats, "workday", "kept");
});

test("the share-sheet inbox now sees jobs added through the Add form", async () => {
  const added = await add({ company: "NVIDIA", title: "Autonomous Vehicles Intern", url: "https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/AV-Intern_JR2001234" });
  assert.equal(added.status, 201);
  const shared = await importSharedText(
    "check this https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/AV-Intern_JR2001234?source=LinkedIn",
    async () => { throw new Error("no network in tests"); }
  );
  assert.equal(shared.results[0].outcome, "duplicate");
  assert.equal(shared.results[0].job_id, added.data.id);
  assert.ok(getJob(added.data.id));
});
