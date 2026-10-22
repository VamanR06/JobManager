import "./setup-env";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import type { Browser } from "playwright";
import { getDb } from "../src/lib/db";
import { bookmarklet, EXTRACT_SCRIPT } from "../src/lib/bookmarklet";
import { importFromBrowser } from "../src/lib/browser-import";
import { handleMcpMessage } from "../src/lib/mcp";
import { createJob, getPosting, listEvents } from "../src/lib/queries";
import { POST } from "../src/app/api/import/posting/route";

getDb();
let browser: Browser;
before(async () => {
  const { chromium } = await import("playwright");
  browser = await chromium.launch({ headless: true });
});
after(async () => browser?.close());

const DESC = "<p>Build machine learning systems for memory chips. You will work with the data science team on models.</p>";
const WD = "https://acme.wd5.myworkdayjobs.com/en-US/External/job/Boise-ID/ML-Intern_JR100";

/** Runs the bookmarklet's extractor on a page; requests to the given URLs are answered locally. */
async function extract(url: string, routes: Record<string, { body: string; type: string; status?: number }>) {
  const page = await browser.newPage();
  await page.route("**/*", (route) => {
    const hit = routes[route.request().url()];
    return hit ? route.fulfill({ status: hit.status ?? 200, contentType: hit.type, body: hit.body }) : route.abort();
  });
  await page.goto(url);
  const out = await page.evaluate(`(${EXTRACT_SCRIPT})()`);
  await page.close();
  return out as Record<string, string | null>;
}

test("the bookmarklet reads a Workday posting through Workday's own API, from the page", async () => {
  const out = await extract(WD, {
    [WD]: { body: "<html><body><div id=root>Loading…</div></body></html>", type: "text/html" },
    "https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/External/job/Boise-ID/ML-Intern_JR100": {
      type: "application/json",
      body: JSON.stringify({ jobPostingInfo: { title: "ML Intern", location: "Boise, ID", jobDescription: DESC }, hiringOrganization: { name: "Acme Inc." } }),
    },
  });
  assert.deepEqual(out, { title: "ML Intern", company: "Acme Inc.", location: "Boise, ID", description_html: DESC, url: WD });
});

test("elsewhere it reads the page's JobPosting data, or its main text", async () => {
  const ld = JSON.stringify({ "@context": "https://schema.org", "@type": "JobPosting", title: "Data Intern", description: DESC,
    hiringOrganization: { "@type": "Organization", name: "Example Co" }, jobLocation: { address: { addressLocality: "Austin", addressRegion: "TX" } } });
  const a = await extract("https://careers.example.com/jobs/1", {
    "https://careers.example.com/jobs/1": { type: "text/html", body: `<html><head><script type="application/ld+json">${ld}</script></head><body>x</body></html>` },
  });
  assert.equal(a.title, "Data Intern");
  assert.equal(a.company, "Example Co");
  assert.equal(a.location, "Austin, TX");
  const b = await extract("https://careers.example.com/jobs/2", {
    "https://careers.example.com/jobs/2": { type: "text/html", body: "<html><head><title>Role</title></head><body><h1>Platform Intern</h1><main>We build platforms. Responsibilities include on-call.</main></body></html>" },
  });
  assert.equal(b.title, "Platform Intern");
  assert.match(b.description_text!, /We build platforms/);
});

test("the bookmarklet is a valid javascript: link that opens this JobManager's /save page", () => {
  const link = bookmarklet("https://jobs.example.com/");
  assert.ok(link.startsWith("javascript:"));
  const src = decodeURIComponent(link.slice("javascript:".length));
  assert.doesNotThrow(() => new Function(src), "parses");
  assert.match(src, /"https:\/\/jobs\.example\.com\/save#"/);
});

test("saving from the browser adds the job, or fills in one the server couldn't fetch", () => {
  const made = importFromBrowser({ url: `${WD}?source=LinkedIn`, title: "ML Intern", company: "Acme Inc.", location: "Boise, ID", description_html: DESC });
  assert.equal(made.outcome, "created");
  const id = (made as { job_id: number }).job_id;
  assert.match(getPosting(id)!.description_md, /machine learning systems/);
  assert.equal(listEvents(id)[0].status, "to_apply");

  // The same posting again: offered as a duplicate instead of added.
  const again = importFromBrowser({ url: WD, title: "ML Intern", company: "Acme", description_html: DESC });
  assert.equal(again.outcome, "duplicate");
  assert.equal((again as { same_posting: { id: number } }).same_posting.id, id);

  // An application whose fetch failed gets its description filled in.
  const blocked = createJob({ company: "Micron", title: "Intern - Machine Learning Engineering", url: "https://micron.wd1.myworkdayjobs.com/en-US/External/job/Richardson-TX/Intern---Machine-Learning-Engineering_JR114750" });
  const filled = importFromBrowser({ url: blocked.url!, title: "Intern - Machine Learning Engineering", company: "Micron", description_html: DESC }, { jobId: blocked.id });
  assert.deepEqual(filled, { outcome: "updated", job_id: blocked.id });
  assert.equal(getPosting(blocked.id)!.fetch_status, "ok");

  assert.throws(() => importFromBrowser({ url: WD, title: "x", company: "y", description_text: "too short" }), /didn't have a job description/);
});

test("the save route answers created / duplicate / bad input", async () => {
  const post = async (body: unknown) => (await POST(new NextRequest("http://localhost/api/import/posting", { method: "POST", body: JSON.stringify(body) }))).status;
  const posting = { url: "https://jobs.lever.co/beta/11111111-2222-3333-4444-555555555555", title: "Beta Intern", company: "Beta", description_html: DESC };
  assert.equal(await post({ posting }), 201);
  assert.equal(await post({ posting }), 409);
  assert.equal(await post({ posting, allow_duplicate: true }), 201);
  assert.equal(await post({ posting: { ...posting, url: "not a url" } }), 400);
  assert.equal(await post({}), 400);
});

test("add_application with a description doesn't fetch the page", async () => {
  process.env.JOBMANAGER_MCP_WRITE = "1";
  try {
    let fetched = false;
    const r = (await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "add_application", arguments: {
      url: "https://micron.wd1.myworkdayjobs.com/en-US/External/job/Boise-ID/Other-Intern_JR999", company: "Micron", title: "Other Intern", location: "Boise, ID", description: DESC,
    } } }, { parse: async () => { fetched = true; throw new Error("blocked"); } })) as { result: { structuredContent: any } };
    const out = r.result.structuredContent;
    assert.equal(out.added, true);
    assert.equal(fetched, false);
    assert.match(out.application.posting.description_md, /machine learning systems/);
    assert.equal(out.application.posting.location, "Boise, ID");
  } finally {
    delete process.env.JOBMANAGER_MCP_WRITE;
  }
});
