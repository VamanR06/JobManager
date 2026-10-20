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
import { categorize, matchOption, questionKey, resolveField, saveAnswer } from "../src/lib/apply/answers";
import { BrowserOwner } from "../src/lib/apply/browser";
import { prepareApplication, type FieldReport } from "../src/lib/apply/fill";
import { CONFIRM_SCRIPT, type ConfirmationCheck } from "../src/lib/apply/confirm";
import { markSubmitted } from "../src/lib/submission";
import { listEvents } from "../src/lib/queries";
import type { ScannedField } from "../src/lib/apply/scan";

getDb();
const newJob = (company: string) => createJob({ company, title: "Intern" }).id;
const FORMS = path.join(__dirname, "fixtures", "forms");
let server: http.Server;
let base = "";
let submits = 0;
const browser = new BrowserOwner({ headless: true, allowLocal: true, profileDir: fs.mkdtempSync(path.join(os.tmpdir(), "jm-profile-")) });

const resume = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "jm-up-")), "Test_Candidate_Resume_Acme.pdf");
fs.writeFileSync(resume, "%PDF-1.4 fake");

const profile: Record<string, string> = {
  full_name: "Test Candidate", first_name: "Test", last_name: "Candidate", email: "test.candidate@example.com",
  phone: "555-123-4567", location: "Ann Arbor, MI", current_company: "University of Michigan",
  school: "University of Michigan", website: "https://vamanr.com", degree: "Bachelor of Science in Engineering", linkedin: "https://linkedin.com/in/test",
  demographic_policy: "Decline to answer", work_authorized_us: "yes", needs_sponsorship_future: "no",
  earliest_start: "June 1, 2027",
};

before(async () => {
  server = http.createServer((req, res) => {
    if (req.method === "POST") submits++;
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

async function prepare(jobId: number, form: string, company: string) {
  const page = await browser.pageFor(jobId, `${base}/${form}`, ["127.0.0.1"]);
  return prepareApplication({
    page, resumeFileName: path.basename(resume), stopRequested: () => false, parserWaitMs: 300,
    url: `${base}/${form}`, formWaitMs: 1_500,
    adoptPage: (p) => browser.adopt(jobId, p, ["127.0.0.1"]),
    ctx: { profile, company, jobId, resumePath: resume, coverLetterPath: null },
  });
}
const byLabel = (reports: FieldReport[], re: RegExp) => reports.find((r) => re.test(r.field.label))!;
const unknowns = (reports: FieldReport[]) => reports.filter((r) => r.status === "unknown").map((r) => r.field.label);

// ---------- pure logic ----------

test("options are matched only when the answer clearly picks one", () => {
  assert.equal(matchOption("yes", ["Yes", "No"]), "Yes");
  assert.equal(matchOption("No", ["Yes, I will", "No, I will not"]), "No, I will not");
  assert.equal(matchOption("Bachelor's Degree", ["Associate's Degree", "Bachelor's Degree"]), "Bachelor's Degree");
  assert.equal(matchOption("Bachelor of Science in Engineering", ["Associate's Degree", "Bachelor's Degree", "Master's Degree"]), null);
  assert.equal(matchOption("Degree", ["Associate's Degree", "Bachelor's Degree"]), null, "ambiguous → ask");
});

test("questions are classified per the plan's categories", () => {
  const f = (label: string, kind: ScannedField["kind"] = "text", options: string[] = []): ScannedField => ({
    key: label, kind, inputType: kind, label, required: true, selector: "#x", value: "",
    options: options.map((o) => ({ label: o, selector: null, value: null })),
  });
  assert.equal(categorize(f("Email")), "fact");
  assert.equal(categorize(f("Are you legally authorized to work in the United States?", "select")), "eligibility");
  assert.equal(categorize(f("Will you now or in the future require sponsorship?", "radio")), "eligibility");
  assert.equal(categorize(f("Gender", "select")), "demographic");
  assert.equal(categorize(f("I certify that the information above is accurate", "checkbox", ["I certify"])), "attestation");
  assert.equal(categorize(f("Why do you want to work here?", "textarea")), "narrative");
  assert.equal(categorize(f("Resume/CV", "file")), "file");
  // Authorization and sponsorship are separate facts.
  const auth = resolveField(f("Are you legally authorized to work in the US?", "select", ["Yes", "No"]), { profile, company: "X", jobId: 1, resumePath: null, coverLetterPath: null });
  const spons = resolveField(f("Will you now or in the future require sponsorship?", "select", ["Yes", "No"]), { profile, company: "X", jobId: 1, resumePath: null, coverLetterPath: null });
  assert.equal(auth.answer, "Yes");
  assert.equal(spons.answer, "No");
  // Unknown eligibility is asked, never guessed.
  const noProfile = resolveField(f("Are you legally authorized to work in the US?", "select", ["Yes", "No"]), { profile: {}, company: "X", jobId: 1, resumePath: null, coverLetterPath: null });
  assert.equal(noProfile.status, "unknown");
});

test("answer scopes: global reuse across companies, company and job answers stay put, attestations never global", () => {
  assert.equal(questionKey("How did you hear about Acme?", "Acme"), "how did you hear about {company}");
  const ctx = (company: string, jobId: number) => ({ profile: {}, company, jobId, resumePath: null, coverLetterPath: null });
  const q = (label: string, kind: ScannedField["kind"] = "text", options: string[] = []): ScannedField => ({
    key: label, kind, inputType: kind, label, required: true, selector: "#x", value: "", options: options.map((o) => ({ label: o, selector: null, value: null })),
  });
  saveAnswer({ label: "How did you hear about Acme?", options: [], answer: "Job board", scope: "global", company: "Acme", jobId: 101 });
  assert.equal(resolveField(q("How did you hear about Globex?"), ctx("Globex", 102)).answer, "Job board");
  saveAnswer({ label: "Preferred office", options: [], answer: "Seattle", scope: "company", company: "Acme", jobId: 101 });
  assert.equal(resolveField(q("Preferred office"), ctx("Acme", 103)).answer, "Seattle");
  assert.equal(resolveField(q("Preferred office"), ctx("Globex", 104)).status, "unknown");
  saveAnswer({ label: "I certify the above is true", options: ["I certify the above is true"], answer: "yes", scope: "global", company: "Acme", jobId: newJob("Acme") });
  assert.equal(resolveField(q("I certify the above is true", "checkbox", ["I certify the above is true"]), ctx("Acme", 105)).status, "unknown");
});

// ---------- real browser, local fixture forms ----------

test("Lever-style form: unknowns pause, answers resume, parser overwrite is caught, nothing is submitted", async () => {
  const id = newJob("Xcimer");
  const first = await prepare(id, "lever.html", "Xcimer");
  assert.equal(first.kind, "needs_input");
  assert.deepEqual(unknowns(first.reports).sort(), [
    "I certify that the information above is accurate", "Why do you want to work at Xcimer?",
  ].sort());
  // The global "How did you hear about {company}?" answer saved earlier is reused here.
  assert.equal(byLabel(first.reports, /^How did you hear/).resolution.answer, "Job board");
  assert.equal(byLabel(first.reports, /^Gender/).resolution.answer, "Decline to self-identify");
  assert.equal(byLabel(first.reports, /^Email/).status, "filled", "known fields are filled even while questions remain open");
  assert.equal(byLabel(first.reports, /^Email/).readback, "test.candidate@example.com");
  assert.match(first.message, /^Filled \d+ fields; 2 questions still need your answer/);
  // The resume went in on this first pass, and the parser's overwrite was caught and undone.
  assert.equal(byLabel(first.reports, /^Full name/).readback, "Test Candidate");
  assert.match(byLabel(first.reports, /^Full name/).note ?? "", /re-entered/);
  assert.equal(byLabel(first.reports, /^Age range/).status, "skipped", "no decline option on an optional question → left blank");
  assert.equal(byLabel(first.reports, /^Twitter/).status, "skipped");

  saveAnswer({ label: "How did you hear about Xcimer?", options: ["Job board", "Career fair", "Referral"], answer: "Career fair", scope: "global", company: "Xcimer", jobId: id });
  saveAnswer({ label: "Why do you want to work at Xcimer?", options: [], answer: "Fusion energy is the problem I want to work on.", scope: "job", company: "Xcimer", jobId: id });
  saveAnswer({ label: "I certify that the information above is accurate", options: ["I certify that the information above is accurate"], answer: "yes", scope: "job", company: "Xcimer", jobId: id });

  const second = await prepare(id, "lever.html", "Xcimer");
  assert.equal(second.kind, "filled", second.message);
  assert.equal(byLabel(second.reports, /^Full name/).readback, "Test Candidate");
  assert.match(byLabel(second.reports, /^Resume/).readback ?? "", /Test_Candidate_Resume_Acme\.pdf/);
  // An answer saved for this exact option list beats the generic free-text one.
  assert.equal(byLabel(second.reports, /^How did you hear/).readback, "Career fair");
  assert.equal(byLabel(second.reports, /^I certify/).status, "filled");
  assert.equal(submits, 0, "the form was never submitted");
});

test("Greenhouse-style comboboxes: options are read, unclear matches are asked, decline is chosen", async () => {
  const id = newJob("Tanium");
  const first = await prepare(id, "greenhouse.html", "Tanium");
  assert.equal(first.kind, "needs_input");
  assert.deepEqual(unknowns(first.reports), [
    "Degree", "School", "Please confirm receipt of the above linked Global Data Privacy Notice",
    "Which of the following best describes how you use AI tools today?",
  ], "profile degree text doesn't clearly match an option");
  assert.equal(byLabel(first.reports, /best describes/).resolution.category, "other", "a dropdown is a choice, not a written answer");
  assert.equal(byLabel(first.reports, /Privacy Notice/).resolution.category, "attestation");
  // The school list's first page doesn't contain it, so it was searched: real results are offered.
  assert.deepEqual(byLabel(first.reports, /^School/).field.options.map((o) => o.label), [
    "University of Michigan - Ann Arbor", "University of Michigan - Dearborn", "University of Michigan - Flint",
  ]);
  assert.match(byLabel(first.reports, /^School/).note ?? "", /Several results/);
  assert.equal(byLabel(first.reports, /^First Name/).readback, "Test", "filled while other questions are open");
  assert.deepEqual(byLabel(first.reports, /^Degree/).field.options.map((o) => o.label), ["Associate's Degree", "Bachelor's Degree", "Master's Degree", "Doctorate"]);
  // Reused from the Lever answer? No — that one was a select with different options; this is free text.
  assert.equal(byLabel(first.reports, /^How did you hear about Tanium/).resolution.answer, "Job board", "global answer reused across companies");

  saveAnswer({ label: "Degree", options: ["Associate's Degree", "Bachelor's Degree", "Master's Degree", "Doctorate"], answer: "Bachelor's Degree", scope: "global", company: "Tanium", jobId: id });
  saveAnswer({ label: "Please confirm receipt of the above linked Global Data Privacy Notice", options: ["I acknowledge"], answer: "yes", scope: "job", company: "Tanium", jobId: id });
  saveAnswer({ label: "Which of the following best describes how you use AI tools today?", options: ["I use them daily", "Occasionally", "I don't use AI tools"], answer: "Occasionally", scope: "global", company: "Tanium", jobId: id });
  saveAnswer({ label: "School", options: ["University of Michigan - Ann Arbor", "University of Michigan - Dearborn", "University of Michigan - Flint"], answer: "University of Michigan - Ann Arbor", scope: "global", company: "Tanium", jobId: id });
  const second = await prepare(id, "greenhouse.html", "Tanium");
  assert.equal(second.kind, "filled", second.message);
  assert.equal(byLabel(second.reports, /^Degree/).readback, "Bachelor's Degree");
  assert.equal(byLabel(second.reports, /^School/).readback, "University of Michigan - Ann Arbor", "typed, waited for results, picked");
  assert.equal(byLabel(second.reports, /^Gender/).readback, "Decline To Self Identify", "dropdown values read back from the displayed value, not the input");
  assert.equal(byLabel(second.reports, /Privacy Notice/).readback, "I acknowledge", "a yes to a single-option confirmation picks that option");
  assert.equal(byLabel(second.reports, /best describes/).readback, "Occasionally");
  assert.ok(!second.reports.some((r) => r.status === "mismatch"), "no false 'check it' fields");
  assert.equal(byLabel(second.reports, /legally authorized/).readback, "Yes");
  const upload = byLabel(second.reports, /^Resume\/CV/);
  assert.ok(upload && upload.field.required, "upload labelled by its group, not the 'Attach' button");
  assert.match(upload.readback ?? "", /Test_Candidate_Resume_Acme\.pdf/);
  assert.equal(submits, 0);
});

test("Ashby-style radios: conditional follow-up questions are found and filled", async () => {
  const id = newJob("Persona");
  saveAnswer({ label: "Are you currently a student?", options: ["Yes", "No"], answer: "Yes", scope: "global", company: "Persona", jobId: id });
  const r = await prepare(id, "ashby.html", "Persona");
  assert.equal(r.kind, "filled", r.message);
  assert.equal(byLabel(r.reports, /sponsorship/).readback, "No");
  const school = byLabel(r.reports, /^School/);
  assert.ok(school, "follow-up question revealed by 'Yes' was picked up");
  assert.equal(school.readback, "University of Michigan");
  assert.equal(byLabel(r.reports, /^Portfolio Password/).status, "skipped", "a password field is never filled from the profile");
  assert.equal(submits, 0);
});

test("login walls block with a handoff; navigation off the allowed host is refused", async () => {
  const r = await prepare(newJob("Acme"), "login.html", "Acme");
  assert.equal(r.kind, "blocked");
  assert.match(r.message, /sign in/);
  const page = await browser.pageFor(newJob("Acme"), `${base}/ashby.html`, ["127.0.0.1"]);
  const other = base.replace("127.0.0.1", "localhost");
  await assert.rejects(page.goto(`${other}/lever.html`));
  assert.ok(browser.blockedNavigations.some((u) => u.startsWith(other)));
});

test("Ashby's real markup: search box and date picker without ids, Yes/No buttons, checkbox groups, required-by-class", async () => {
  const id = newJob("OpenAI");
  const first = await prepare(id, "ashby-openai.html", "OpenAI");
  const labels = first.reports.map((r) => r.field.label);
  for (const q of ["Where are you currently located?", "When can you start a new role?", "Are you authorized to work in the country where the job is located?",
    "Are you able to work from our US office three days per week?", "Please select all office locations of interest.", "Applicant Arbitration Agreement Acknowledgement"]) {
    assert.ok(labels.includes(q), `found: ${q}`);
  }
  assert.ok(!labels.some((l) => ["San Francisco", "Mountain View", "Seattle"].includes(l)), "options aren't separate questions");
  const offices = byLabel(first.reports, /office locations/);
  assert.equal(offices.field.kind, "checkbox");
  assert.deepEqual(offices.field.options.map((o) => o.label), ["San Francisco", "Mountain View", "Seattle"]);
  assert.ok(offices.field.required && byLabel(first.reports, /Arbitration/).field.required, "required marked by CSS class is detected");
  assert.equal(byLabel(first.reports, /authorized to work/).field.kind, "buttons");
  assert.equal(byLabel(first.reports, /authorized to work/).resolution.answer, "Yes");
  assert.equal(byLabel(first.reports, /Arbitration/).resolution.category, "attestation");
  assert.deepEqual(unknowns(first.reports).sort(), [
    "Applicant Arbitration Agreement Acknowledgement", "Are you able to work from our US office three days per week?", "Please select all office locations of interest.",
  ]);

  saveAnswer({ label: "Are you able to work from our US office three days per week?", options: ["Yes", "No"], answer: "Yes", scope: "global", company: "OpenAI", jobId: id });
  saveAnswer({ label: "Please select all office locations of interest.", options: ["San Francisco", "Mountain View", "Seattle"], answer: "San Francisco; Seattle", scope: "job", company: "OpenAI", jobId: id });
  saveAnswer({ label: "Applicant Arbitration Agreement Acknowledgement", options: ["I acknowledge that I have opened, read, and understood the Arbitration Agreement."], answer: "yes", scope: "job", company: "OpenAI", jobId: id });

  const second = await prepare(id, "ashby-openai.html", "OpenAI");
  assert.equal(second.kind, "filled", second.message + " :: " + JSON.stringify(second.reports.filter((r) => r.status === "mismatch").map((r) => [r.field.label, r.note])));
  assert.equal(byLabel(second.reports, /currently located/).readback, "Ann Arbor, Michigan, United States", "not the Charter Township suggestion");
  assert.equal(byLabel(second.reports, /start a new role/).readback, "06/01/2027");
  assert.equal(byLabel(second.reports, /authorized to work/).readback, "Yes");
  assert.equal(byLabel(second.reports, /three days/).readback, "Yes");
  assert.equal(byLabel(second.reports, /office locations/).readback, "San Francisco; Seattle");
  assert.equal(byLabel(second.reports, /Arbitration/).status, "filled");
  assert.equal(submits, 0);
});

test("submission is recognised from the site's confirmation, not from a click; warnings are surfaced", async () => {
  const id = newJob("Acme");
  const page = await browser.pageFor(id, `${base}/thanks.html`, ["127.0.0.1"]);
  const ok = (await page.evaluate(CONFIRM_SCRIPT)) as ConfirmationCheck;
  assert.equal(ok.confirmed, true);
  const flagged = await browser.pageFor(newJob("Acme"), `${base}/flagged.html`, ["127.0.0.1"]);
  const bad = (await flagged.evaluate(CONFIRM_SCRIPT)) as ConfirmationCheck;
  assert.equal(bad.confirmed, false, "'thank you for your interest' with the form still there isn't a confirmation");
  assert.match(bad.warning ?? "", /VPN/);
  const form = await browser.pageFor(newJob("Acme"), `${base}/lever.html`, ["127.0.0.1"]);
  assert.equal(((await form.evaluate(CONFIRM_SCRIPT)) as ConfirmationCheck).confirmed, false);

  assert.equal(markSubmitted(id, { how: "confirmation_page", detail: "thanks" }), true);
  assert.equal(markSubmitted(id, { how: "manual", detail: "again" }), false, "idempotent");
  assert.deepEqual(listEvents(id).map((e) => e.status), ["applied"], "one Applied entry in the tracker");
  assert.equal((getDb().prepare("SELECT workflow_state FROM jobs WHERE id = ?").get(id) as { workflow_state: string }).workflow_state, "submitted");
});

test("a reused tab that drifted off the form is reloaded; one on the thank-you page counts as submitted", async () => {
  const id = newJob("Persona");
  const page = await browser.pageFor(id, `${base}/ashby.html`, ["127.0.0.1"]);
  await page.goto(`${base}/empty.html`); // e.g. the person clicked away in that tab
  const r = await prepare(id, "ashby.html", "Persona");
  assert.notEqual(r.kind, "blocked", r.message);
  assert.ok(r.reports.some((x) => x.status === "filled"), "reloaded the form and filled it");

  const done = newJob("Acme");
  const tab = await browser.pageFor(done, `${base}/lever.html`, ["127.0.0.1"]);
  await tab.goto(`${base}/thanks.html`);
  const s = await prepare(done, "lever.html", "Acme");
  assert.equal(s.kind, "already_submitted");
});

test("links that open new tabs don't crash the guard: same-site allowed, elsewhere blocked", async () => {
  const page = await browser.pageFor(newJob("Acme"), `${base}/popup.html`, ["127.0.0.1"]);
  const [okPopup] = await Promise.all([page.waitForEvent("popup"), page.click("#ok")]);
  await okPopup.waitForLoadState("domcontentloaded").catch(() => {});
  assert.match(await okPopup.content(), /Thank you for applying/);
  const before = browser.blockedNavigations.length;
  const [badPopup] = await Promise.all([page.waitForEvent("popup"), page.click("#bad")]);
  await badPopup.waitForLoadState("domcontentloaded").catch(() => {});
  assert.ok(browser.blockedNavigations.length > before, "the off-site popup was blocked");
  assert.ok(!(await badPopup.content()).includes("application-form"));
});

test("an Apply button that opens the form in a new tab is followed, and that tab becomes the job's tab", async () => {
  const id = newJob("Persona");
  const r = await prepare(id, "careers.html", "Persona");
  assert.notEqual(r.kind, "blocked", r.message);
  assert.equal(byLabel(r.reports, /^Email/).readback, "test.candidate@example.com", "filled in the new tab");
  const tab = browser.openPages().find(([jobId]) => jobId === id)?.[1];
  assert.ok(tab && tab.url().endsWith("/ashby.html"), "the watcher now follows the form tab");
  assert.equal(submits, 0);
});
