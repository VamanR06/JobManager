import "./setup-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePostingUrl, workdayApiUrl, type Fetcher } from "../src/lib/parser";
import type { SafeResponse } from "../src/lib/netguard";

const reply = (status: number, body: string, url = "https://x/"): SafeResponse => ({
  status, ok: status >= 200 && status < 300, finalUrl: url, chain: [url], contentType: "", body,
});
/** Answers by URL; records what was asked for. */
function fake(routes: Record<string, SafeResponse>) {
  const asked: string[] = [];
  const fetcher: Fetcher = async (url) => {
    asked.push(url);
    const hit = Object.entries(routes).find(([k]) => url.startsWith(k));
    return hit ? hit[1] : reply(404, "not found", url);
  };
  return { fetcher, asked };
}

const GM = "https://generalmotors.wd5.myworkdayjobs.com/en-US/Careers_GM/job/Detroit/Software-Intern_JR-1";
const GM_API = "https://generalmotors.wd5.myworkdayjobs.com/wday/cxs/generalmotors/Careers_GM/job/Detroit/Software-Intern_JR-1";
const SHELL = "<!doctype html><html><head><title>Workday</title></head><body><div id='root'></div></body></html>";

test("Workday links map to the JSON API, including myworkdaysite and apply links", () => {
  assert.equal(workdayApiUrl(GM), GM_API);
  assert.equal(workdayApiUrl(`${GM}/apply/autofillWithResume?source=LinkedIn`), GM_API);
  assert.equal(
    workdayApiUrl("https://wd1.myworkdaysite.com/en-US/recruiting/wf/WellsFargoJobs/job/Paris/M-A-Intern_R-578899"),
    "https://wd1.myworkdaysite.com/wday/cxs/wf/WellsFargoJobs/job/Paris/M-A-Intern_R-578899"
  );
  assert.equal(workdayApiUrl("https://boards.greenhouse.io/acme/jobs/1"), null);
  assert.equal(workdayApiUrl("https://acme.wd1.myworkdayjobs.com/en-US/Careers/login"), null);
});

test("a Workday posting comes from its API, with entities decoded", async () => {
  const { fetcher, asked } = fake({
    [GM_API]: reply(200, JSON.stringify({
      jobPostingInfo: { title: "Software Intern &amp; Co-op", location: "Detroit, MI", jobDescription: "<p>Build <b>cars</b>.</p>", jobReqId: "JR-1", timeType: "Full time", canApply: true },
      hiringOrganization: { name: "General Motors LLC" },
    })),
  });
  const p = await parsePostingUrl(GM, fetcher);
  assert.equal(p.title, "Software Intern & Co-op");
  assert.equal(p.company, "General Motors LLC");
  assert.equal(p.posting_id, "JR-1");
  assert.match(p.description_md, /Build \*\*cars\*\*/);
  assert.deepEqual(asked, [GM_API], "the page itself isn't fetched when the API answers");
});

test("a closed Workday posting says so instead of a generic failure", async () => {
  for (const api of [reply(403, JSON.stringify({ errorCode: "S22", httpStatus: 403, message: "permission denied" })), reply(404, "{}"),
    reply(200, JSON.stringify({ jobPostingInfo: { canApply: false, jobDescription: "<p>x</p>" } }))]) {
    const { fetcher } = fake({ [GM_API]: api, [GM]: reply(200, SHELL, GM) });
    await assert.rejects(parsePostingUrl(GM, fetcher), /closed or no longer public/);
  }
});

test("if Workday's API is unavailable, the page's own JSON-LD still works", async () => {
  const page = `<html><head><script type="application/ld+json">${JSON.stringify({
    "@type": "JobPosting", title: "AT&amp;T Intern", description: "<p>Answer phones</p>", hiringOrganization: { name: "AT&amp;T Services, Inc." },
  })}</script></head><body></body></html>`;
  const { fetcher } = fake({ [GM_API]: reply(500, "oops"), [GM]: reply(200, page, GM) });
  const p = await parsePostingUrl(GM, fetcher);
  assert.equal(p.title, "AT&T Intern");
  assert.equal(p.company, "AT&T Services, Inc.");
});

test("a blocked server gets a reason, not just 'could not extract'", async () => {
  const { fetcher } = fake({ [GM_API]: reply(403, "<html>Access denied</html>"), [GM]: reply(403, "<html>Access denied</html>", GM) });
  await assert.rejects(parsePostingUrl(GM, fetcher), /Could not extract posting content \(Workday API HTTP 403 \(an HTML page, not data: probably a bot check\); page HTTP 403\)/);
  // Other sites keep the plain error.
  const other = fake({});
  await assert.rejects(parsePostingUrl("https://example.com/job", other.fetcher), /Fetch failed: HTTP 404/);
});
