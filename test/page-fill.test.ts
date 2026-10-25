import "./setup-env";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import { getDb } from "../src/lib/db";
import { createJob, updateJob } from "../src/lib/queries";
import { saveUploadedDocument } from "../src/lib/documents";
import { setProfileFacts } from "../src/lib/profile";
import { BrowserOwner } from "../src/lib/apply/browser";
import { jobForPage, PAGE_FILL_SCRIPT, pageInfo, parseScannedFields, planFill } from "../src/lib/apply/page";
import { SCAN_SCRIPT, type ScanResult } from "../src/lib/apply/scan";

// NotchMan's path: scan in the person's browser → /api/apply/resolve → fill in the same browser. Runs on local
// copies of real forms in a headless browser; nothing is submitted.

getDb();
const FORMS = path.join(__dirname, "fixtures", "forms");
let server: http.Server;
let base = "";
const browser = new BrowserOwner({ headless: true, allowLocal: true, profileDir: fs.mkdtempSync(path.join(os.tmpdir(), "jm-profile-")) });

setProfileFacts({
  full_name: "Test Candidate", first_name: "Test", last_name: "Candidate", email: "test.candidate@example.com",
  phone: "555-123-4567", location: "Ann Arbor, MI", current_company: "University of Michigan",
  linkedin: "https://linkedin.com/in/test", demographic_policy: "Decline to answer",
});

before(async () => {
  server = http.createServer((req, res) => {
    const file = path.join(FORMS, path.basename(req.url ?? "/").split("?")[0] || "index.html");
    if (!fs.existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(fs.readFileSync(file));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await browser.close();
  server.close();
});

test("a posting or its application form finds the tracked job, with its resume", () => {
  const job = createJob({ company: "Xcimer", title: "Engineer", url: "https://jobs.lever.co/xcimer/0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d" });
  const { doc } = saveUploadedDocument("resume", "Test_Resume_Xcimer.pdf", Buffer.from("%PDF-1.4 fake"));
  updateJob(job.id, { resume_id: doc.id });

  assert.equal(jobForPage("https://jobs.lever.co/xcimer/0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d")?.id, job.id);
  assert.equal(jobForPage("https://jobs.lever.co/xcimer/0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d/apply?lever-source=x")?.id, job.id);
  assert.equal(jobForPage("https://jobs.lever.co/xcimer/ffffffff-4e5f-6a7b-8c9d-0e1f2a3b4c5d"), null);
  assert.equal(jobForPage("not a url"), null);

  const info = pageInfo("https://jobs.lever.co/xcimer/0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d/apply");
  assert.equal(info.job?.company, "Xcimer");
  assert.deepEqual(info.resume, { id: doc.id, name: "Test_Resume_Xcimer.pdf" });
  assert.equal(info.cover_letter, null);
});

test("scanned fields are shape-checked before resolving", () => {
  assert.equal(parseScannedFields("nope"), null);
  assert.equal(parseScannedFields([{ key: "a", selector: "#a", kind: "rocket" }]), null);
  const ok = parseScannedFields([{ key: "a", selector: "#a", kind: "text", label: "Email", required: true, options: [{ label: "x" }, 5] }]);
  assert.equal(ok?.[0].label, "Email");
  assert.equal(ok?.[0].options.length, 1);
});

test("the in-page filler fills a Lever form from the plan and attaches the resume", async () => {
  const job = createJob({ company: "Xcimer", title: "Engineer 2" });
  const { doc } = saveUploadedDocument("resume", "Candidate_Resume.pdf", Buffer.from("%PDF-1.4 other"));
  updateJob(job.id, { resume_id: doc.id });

  const page = await browser.pageFor(job.id, `${base}/lever.html`, ["127.0.0.1"]);
  const scan = (await page.evaluate(SCAN_SCRIPT)) as ScanResult;
  // What NotchMan sends goes through the same JSON round trip.
  const fields = parseScannedFields(JSON.parse(JSON.stringify(scan.fields)))!;
  const plan = planFill(job.id, fields);

  const resumeStep = plan.fill[0];
  assert.equal(resumeStep.kind, "file", "files go first");
  assert.equal(resumeStep.upload, "resume");
  assert.equal(resumeStep.answer, null, "no server path leaks to the browser");
  const status = (re: RegExp) => plan.fields.find((f) => re.test(f.label))?.status;
  assert.equal(status(/^Email/), "resolved");
  assert.equal(status(/Why do you want/), "unknown", "narrative answers are left for the person");
  assert.equal(status(/certify/), "unknown", "attestations are never ticked for them");

  const files = { resume: { name: "Candidate_Resume.pdf", type: "application/pdf", base64: Buffer.from("%PDF-1.4 other").toString("base64") } };
  const results = (await page.evaluate(`(${PAGE_FILL_SCRIPT})(${JSON.stringify(plan.fill)}, ${JSON.stringify(files)})`)) as
    { key: string; status: string }[];
  assert.ok(results.every((r) => r.status === "filled"), JSON.stringify(results));

  const after = new Map(((await page.evaluate(SCAN_SCRIPT)) as ScanResult).fields.map((f) => [f.label, f.value]));
  assert.equal(after.get("Email"), "test.candidate@example.com");
  assert.equal(after.get("Full name"), "Test Candidate");
  assert.equal(after.get("Current company"), "University of Michigan");
  assert.equal(after.get("Gender"), "Decline to self-identify");
  assert.equal(await page.evaluate(`document.getElementById("resume-upload-input").files[0].name`), "Candidate_Resume.pdf");
  assert.equal(await page.evaluate(`document.querySelector("[name=consent]").checked`), false);
  assert.equal(await page.evaluate(`document.querySelector("textarea").value`), "");
});
