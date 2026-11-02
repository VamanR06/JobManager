import "./setup-env";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import { getDb } from "../src/lib/db";
import { createJob } from "../src/lib/queries";
import { listExperiences, parseExperiences, setExperiences } from "../src/lib/experience";
import { resolveExperienceField } from "../src/lib/apply/answers";
import { BrowserOwner } from "../src/lib/apply/browser";
import { ADD_SECTIONS_SCRIPT, PAGE_FILL_SCRIPT, parseScannedFields, planFill } from "../src/lib/apply/page";
import { SCAN_SCRIPT, type ScanResult, type ScannedField } from "../src/lib/apply/scan";

// Work experience on the Profile fills repeated Work Experience sections (Workday's My Experience), adding
// entries first. Runs on a hand-written Workday-shaped form in a headless browser; nothing is submitted.

getDb();
const FORMS = path.join(__dirname, "fixtures", "forms");
let server: http.Server;
let base = "";
const browser = new BrowserOwner({ headless: true, allowLocal: true, profileDir: fs.mkdtempSync(path.join(os.tmpdir(), "jm-profile-")) });

const JOBS = [
  { title: "Software Engineer Intern", company: "Acme", location: "Ann Arbor, MI", start_month: "2025-05", end_month: null, current: true, description: "Built the thing." },
  { title: "Research Assistant", company: "University of Michigan", location: "", start_month: "2023-09", end_month: "2024-12", current: false, description: "" },
];

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

test("the editor's list is checked, and saved in order", () => {
  assert.equal(parseExperiences([{ title: "", company: "Acme" }]), "Experience 1 needs a job title and a company");
  assert.equal(parseExperiences([{ title: "A", company: "B", start_month: "2024-05", end_month: "2023-01" }]), "Experience 1 ends before it starts");
  const parsed = parseExperiences([{ title: " A ", company: "B", start_month: "May 2024", end_month: "2025-01", current: true }]);
  assert.ok(Array.isArray(parsed));
  assert.deepEqual(parsed[0], { title: "A", company: "B", location: "", start_month: null, end_month: null, current: true, description: "" });

  const saved = setExperiences(parseExperiences(JOBS) as typeof JOBS);
  assert.deepEqual(saved.map((e) => e.company), ["Acme", "University of Michigan"]);
  assert.equal(listExperiences()[0].current, true);
});

test("fields resolve from the job in the same position", () => {
  const field = (label: string, index: number, extra: Partial<ScannedField> = {}): ScannedField => ({
    key: label, kind: "text", inputType: "text", label, required: false, options: [], selector: "#x", value: "", section: { kind: "work", index }, ...extra,
  });
  const jobs = setExperiences(parseExperiences(JOBS) as typeof JOBS);
  const answer = (f: ScannedField) => resolveExperienceField(f, jobs);
  assert.equal(answer(field("Job Title", 2))?.answer, "Research Assistant");
  assert.equal(answer(field("Company", 1))?.answer, "Acme");
  assert.equal(answer(field("From Month", 1))?.answer, "05");
  assert.equal(answer(field("From Year", 2))?.answer, "2023");
  assert.equal(answer(field("To Month", 1))?.status, "skipped", "a current job has no end date");
  assert.equal(answer(field("To", 2))?.answer, "12/2024");
  assert.equal(answer(field("End date", 2, { inputType: "date" }))?.answer, "12/01/2024");
  const months = ["January", "February", "March", "April", "May", "June"].map((label) => ({ label, selector: null, value: null }));
  assert.equal(answer(field("Start date month", 1, { kind: "select", options: months }))?.answer, "May");
  const current = { kind: "checkbox" as const, options: [{ label: "I currently work here", selector: "#c", value: null }] };
  assert.equal(answer(field("I currently work here", 1, current))?.answer, "I currently work here");
  assert.equal(answer(field("I currently work here", 2, current))?.status, "skipped");
  assert.equal(answer(field("Role Description", 1, { kind: "textarea" }))?.answer, "Built the thing.");
  assert.equal(answer(field("Job Title", 3, { required: true }))?.status, "unknown", "more entries on the form than jobs");
  assert.equal(answer(field("Skills", 1)), null, "other fields follow the usual rules");
});

test("a Workday-style My Experience page gets one entry per job, filled from the Profile", async () => {
  setExperiences(parseExperiences(JOBS) as typeof JOBS);
  const job = createJob({ company: "Bigco", title: "Engineer" });
  const page = await browser.pageFor(job.id, `${base}/workday-experience.html`, ["127.0.0.1"]);

  for (let i = 0; i < 5; i++) {
    const r = (await page.evaluate(`(${ADD_SECTIONS_SCRIPT})(${JOBS.length})`)) as { have: number; clicked: boolean };
    if (!r.clicked) break;
  }
  assert.equal(await page.evaluate(`document.querySelectorAll("#work-entries [role=group]").length`), 2);
  assert.deepEqual(await page.evaluate(`(${ADD_SECTIONS_SCRIPT})(2)`), { have: 2, clicked: false }, "enough entries: nothing more is clicked");
  assert.equal(await page.evaluate(`document.querySelectorAll("#school").length`), 1, "Education's Add button is left alone");

  const scan = (await page.evaluate(SCAN_SCRIPT)) as ScanResult;
  const fields = parseScannedFields(JSON.parse(JSON.stringify(scan.fields)))!;
  const byKey = new Map(fields.map((f) => [f.key, f]));
  assert.equal(byKey.get("#we2-from-m")?.label, "From Month");
  assert.equal(byKey.get("#we2-from-m")?.required, true);
  assert.deepEqual(byKey.get("#we2-title")?.section, { kind: "work", index: 2 });
  assert.deepEqual(byKey.get("#school")?.section, { kind: "education", index: 1 });
  assert.equal(byKey.get("#url")?.section, null, "fields after the sections aren't in one");

  const plan = planFill(job.id, fields);
  const results = (await page.evaluate(`(${PAGE_FILL_SCRIPT})(${JSON.stringify(plan.fill)}, {})`)) as { status: string }[];
  assert.ok(results.every((r) => r.status === "filled"), JSON.stringify(results));
  const value = (id: string) => page.evaluate(`document.getElementById(${JSON.stringify(id)}).value`);
  assert.equal(await value("we1-title"), "Software Engineer Intern");
  assert.equal(await value("we1-company"), "Acme");
  assert.equal(await page.evaluate(`document.getElementById("we1-current").checked`), true);
  assert.equal(await value("we1-from-m"), "05");
  assert.equal(await value("we1-from-y"), "2025");
  assert.equal(await value("we1-to-m"), "");
  assert.equal(await value("we1-desc"), "Built the thing.");
  assert.equal(await value("we2-company"), "University of Michigan");
  assert.equal(await page.evaluate(`document.getElementById("we2-current").checked`), false);
  assert.equal(await value("we2-to-m"), "12");
  assert.equal(await value("we2-to-y"), "2024");
});
