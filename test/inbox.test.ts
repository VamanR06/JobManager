import "./setup-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { generateInboxToken, hashPassword, INBOX_PATH, inboxAuthorized } from "../src/lib/auth";
import { importUrls, UNKNOWN_TITLE } from "../src/lib/automation";
import { getDb } from "../src/lib/db";
import { importSharedText, linksInText } from "../src/lib/inbox";
import type { ParsedPosting } from "../src/lib/parser";
import { getJob, getPosting, listJobs } from "../src/lib/queries";
import { proxy } from "../src/proxy";

const TOKEN = generateInboxToken();
process.env.JOBMANAGER_INBOX_TOKEN = TOKEN;

test("inbox token: bearer only, exact match, off when unset", () => {
  assert.equal(inboxAuthorized(`Bearer ${TOKEN}`), true);
  assert.equal(inboxAuthorized(`bearer   ${TOKEN} `), true);
  assert.equal(inboxAuthorized(TOKEN), false, "needs the Bearer scheme");
  assert.equal(inboxAuthorized(`Bearer ${TOKEN}x`), false);
  assert.equal(inboxAuthorized(`Bearer ${TOKEN.slice(1)}`), false);
  assert.equal(inboxAuthorized(null), false);
  assert.equal(inboxAuthorized(`Bearer ${TOKEN}`, null), false, "no token configured = inbox off");
  assert.match(TOKEN, /^[\w-]{43}$/);
});

test("only links are taken from shared text", () => {
  assert.deepEqual(
    linksInText("We're hiring! Apply: https://jobs.lever.co/acme/123 (closes Friday) #jobs"),
    ["https://jobs.lever.co/acme/123"]
  );
  assert.deepEqual(linksInText("no links here, just a caption"), []);
});

const parse = async (): Promise<ParsedPosting> => ({
  title: "Backend Intern", company: "Inbox Co", location: "Remote", description_md: "Build things.",
});
const failParse = async (): Promise<ParsedPosting> => {
  throw new Error("Fetch failed: HTTP 403");
};

test("shared links go on the applications list without queueing automation", async () => {
  const out = await importSharedText("Apply here https://boards.greenhouse.io/inboxco/jobs/77 !", parse);
  assert.equal(out.results[0].outcome, "created");
  assert.equal(out.message, "Added: Inbox Co — Backend Intern");
  const id = out.results[0].job_id!;
  const job = getJob(id)!;
  assert.equal(job.company, "Inbox Co");
  assert.equal(job.title, "Backend Intern");
  const db = getDb();
  const row = db.prepare("SELECT workflow_state FROM jobs WHERE id = ?").get(id) as { workflow_state: string | null };
  assert.equal(row.workflow_state, null, "hand-tracked, not in the pipeline");
  const tasks = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE job_id = ?").get(id) as { n: number };
  assert.equal(tasks.n, 0, "nothing queued");
  assert.equal(getPosting(id)!.description_md, "Build things.");
  assert.equal(listJobs().find((j) => j.id === id)!.latest_event?.status, "to_apply", "marked to apply");

  const again = await importSharedText("https://boards.greenhouse.io/inboxco/jobs/77", parse);
  assert.equal(again.results[0].outcome, "duplicate");
  assert.equal(importUrls(["https://boards.greenhouse.io/inboxco/jobs/77"])[0].outcome, "duplicate", "Import page sees it too");
});

test("an unreadable page still adds the job with placeholders", async () => {
  const out = await importSharedText("https://boards.greenhouse.io/acme-corp/jobs/123", failParse);
  const job = getJob(out.results[0].job_id!)!;
  assert.equal(job.company, "Acme Corp");
  assert.equal(job.title, UNKNOWN_TITLE);
  assert.equal(getPosting(job.id)!.fetch_status, "failed");
});

test("social posts are skipped and captions without links are reported", async () => {
  const ig = await importSharedText("https://www.instagram.com/p/AbC123/?igsh=xyz", parse);
  assert.equal(ig.results[0].outcome, "unsupported");
  assert.match(ig.message, /^Skipped: Social post/);
  assert.equal((await importSharedText("just words", parse)).message, "No link found in what was shared");
});

function req(headers: Record<string, string>, path = INBOX_PATH) {
  return new NextRequest(`https://jobs.example.com${path}`, { method: "POST", headers });
}

test("proxy lets the inbox through on its token alone", () => {
  process.env.JOBMANAGER_PASSWORD_HASH = hashPassword("pw-for-test");
  try {
    // No session cookie, foreign Host, cross-site: all fine with the token.
    const ok = proxy(req({ authorization: `Bearer ${TOKEN}`, host: "jobs.example.com", "sec-fetch-site": "cross-site" }));
    assert.equal(ok.headers.get("x-middleware-next"), "1");
    assert.equal(proxy(req({ host: "jobs.example.com" })).status, 401);
    assert.equal(proxy(req({ authorization: "Bearer wrong", host: "jobs.example.com" })).status, 401);
    // The token doesn't open any other route.
    assert.equal(proxy(req({ authorization: `Bearer ${TOKEN}`, host: "jobs.example.com" }, "/api/import")).status, 401);
  } finally {
    delete process.env.JOBMANAGER_PASSWORD_HASH;
  }
});
