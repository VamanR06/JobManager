import "./setup-env";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import { DATA_DIR, DOCUMENTS_DIR, getDb } from "../src/lib/db";
import { setProfileFacts } from "../src/lib/profile";
import { BrowserOwner, hostAllowed } from "../src/lib/apply/browser";
import { Harness } from "../src/lib/apply/harness";
import { accountPassword } from "../src/lib/apply/vault";
import { handleMcpMessage } from "../src/lib/mcp";
import { createDocument, createJob, listEvents, updateJob } from "../src/lib/queries";

process.env.JOBMANAGER_VAULT_KEY = Buffer.alloc(32, 7).toString("base64");
getDb();
fs.mkdirSync(DOCUMENTS_DIR, { recursive: true });

const FORMS = path.join(__dirname, "fixtures", "forms");
let server: http.Server;
let base = "";
let posts = 0;
const browser = new BrowserOwner({ headless: true, allowLocal: true, profileDir: fs.mkdtempSync(path.join(os.tmpdir(), "jm-profile-")) });
const harness = new Harness(browser);

before(async () => {
  server = http.createServer((req, res) => {
    if (req.method === "POST") {
      posts++;
      return res.writeHead(200).end("ok");
    }
    const file = path.join(FORMS, path.basename(req.url ?? "/").split("?")[0]);
    if (!fs.existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(fs.readFileSync(file));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  setProfileFacts({ email: "test.candidate@example.com", first_name: "Test", last_name: "Candidate" });
});
after(async () => {
  await browser.close();
  server.close();
});

async function rpc(method: string, params?: Record<string, unknown>) {
  return (await handleMcpMessage({ jsonrpc: "2.0", id: 1, method, params }, { harness })) as { result?: any; error?: any };
}
async function call(name: string, args: Record<string, unknown>) {
  const r = (await rpc("tools/call", { name, arguments: args })).result;
  return { error: r.isError ? (r.content[0].text as string) : null, data: r.structuredContent, raw: r };
}
const el = (snap: any, re: RegExp, kind?: string) =>
  snap.elements.find((e: any) => re.test(e.label) && (!kind || e.kind === kind)) ?? assert.fail(`no element ${re} in ${JSON.stringify(snap.elements.map((e: any) => e.label))}`);

async function withFlags(flags: Record<string, string>, fn: () => Promise<void>) {
  Object.assign(process.env, flags);
  try {
    await fn();
  } finally {
    for (const k of Object.keys(flags)) delete process.env[k];
  }
}

function newApplication(page: string) {
  const job = createJob({ company: "Acme", title: "Software Intern", url: `${base}/${page}` });
  const file = path.join(DOCUMENTS_DIR, `resume-${job.id}.pdf`);
  fs.writeFileSync(file, "%PDF-1.4 fake");
  const doc = createDocument("resume", "Test_Candidate_Resume.pdf", path.relative(DATA_DIR, file));
  updateJob(job.id, { resume_id: doc.id });
  return job.id;
}

test("ATS domains match their subdomains, not lookalikes", () => {
  const hosts = [".myworkdayjobs.com", "jobs.example.com"];
  assert.ok(hostAllowed(hosts, "acme.wd5.myworkdayjobs.com"));
  assert.ok(hostAllowed(hosts, "myworkdayjobs.com"));
  assert.ok(!hostAllowed(hosts, "evilmyworkdayjobs.com"));
  assert.ok(hostAllowed(hosts, "jobs.example.com"));
  assert.ok(!hostAllowed(hosts, "x.jobs.example.com"));
});

test("browser tools are hidden and refused unless enabled; submit needs its own flag", async () => {
  const names = async () => (await rpc("tools/list")).result.tools.map((t: { name: string }) => t.name);
  assert.ok(!(await names()).includes("browser_open"));
  assert.match((await call("browser_open", { application_id: 1 })).error!, /off/);
  await withFlags({ JOBMANAGER_MCP_BROWSER: "1" }, async () => {
    assert.ok((await names()).includes("browser_open"));
    assert.ok(!(await names()).includes("submit_application"));
    assert.match((await call("submit_application", { application_id: 1, ref: "e1" })).error!, /Submitting is off/);
  });
  await withFlags({ JOBMANAGER_MCP_BROWSER: "1", JOBMANAGER_MCP_SUBMIT: "1" }, async () => {
    assert.ok((await names()).includes("submit_application"));
  });
});

test("sign up, fill, upload and submit an application end to end", async () => {
  await withFlags({ JOBMANAGER_MCP_BROWSER: "1", JOBMANAGER_MCP_SUBMIT: "1" }, async () => {
    const id = newApplication("portal-signup.html");

    let r = await call("browser_open", { application_id: id });
    assert.equal(r.error, null);
    assert.equal(r.data.account_on_file, false);
    let snap = r.data.snapshot;
    assert.match(snap.title, /Create account/);

    // Leaving the employer's site is blocked.
    assert.match((await call("browser_navigate", { application_id: id, url: "https://evil.example.com/" })).error!, /Can't go to evil\.example\.com/);
    r = await call("browser_click", { application_id: id, ref: el(snap, /Partner offers/).ref });
    assert.match(r.data.note, /Blocked navigation to evil\.example\.com/);
    snap = r.data.snapshot;

    // Passwords can't be typed by the model.
    assert.match((await call("browser_type", { application_id: id, ref: el(snap, /^Password$/).ref, text: "hunter2" })).error!, /portal_credentials/);

    r = await call("portal_credentials", { application_id: id, mode: "create" });
    assert.equal(r.error, null, r.error ?? "");
    assert.deepEqual(r.data.account, { host: "127.0.0.1", email: "test.candidate@example.com", created: true });
    const password = accountPassword("127.0.0.1", "test.candidate@example.com")!;
    assert.ok(password.length >= 20);
    assert.ok(!JSON.stringify(r.raw).includes(password), "the password never appears in a tool result");
    const stored = getDb().prepare("SELECT secret_enc FROM portal_accounts").get() as { secret_enc: string };
    assert.ok(!stored.secret_enc.includes(password), "stored encrypted");
    snap = r.data.snapshot;
    assert.equal(el(snap, /Email address/).value, "test.candidate@example.com");
    assert.equal(el(snap, /^Password$/).value, "(filled)");
    assert.match((await call("portal_credentials", { application_id: id, mode: "create" })).error!, /already saved/);

    r = await call("browser_click", { application_id: id, ref: el(snap, /Create Account/).ref });
    snap = r.data.snapshot;
    assert.match(snap.title, /Apply/, "signed up and moved on to the form");
    const page = browser.existingPage(id)!;
    assert.equal(await page.evaluate(() => sessionStorage.getItem("pw")), password, "the site got the saved password");

    // The submit button is marked and can't be clicked through browser_click.
    const submit = el(snap, /Submit Application/);
    assert.equal(submit.submits_application, true);
    assert.match((await call("browser_click", { application_id: id, ref: submit.ref })).error!, /submit_application/);
    assert.equal(posts, 0);

    r = await call("browser_type", { application_id: id, ref: el(snap, /First name/).ref, text: "Test" });
    assert.equal(r.error, null);
    r = await call("browser_choose", { application_id: id, ref: el(r.data.snapshot, /hear about/).ref, option: "career fair" });
    assert.equal(r.error, null, r.error ?? "");
    assert.equal(el(r.data.snapshot, /hear about/).value, "Career fair");

    // Required fields are checked before anything is sent.
    r = await call("submit_application", { application_id: id, ref: submit.ref });
    assert.match(r.error!, /Required fields are still empty: Email, Resume/);
    assert.equal(posts, 0);

    r = await call("browser_type", { application_id: id, ref: el(r.data?.snapshot ?? snap, /^Email$/).ref, text: "test.candidate@example.com" });
    r = await call("browser_upload", { application_id: id, ref: el(r.data.snapshot, /Resume/).ref });
    assert.equal(r.error, null, r.error ?? "");
    assert.equal(el(r.data.snapshot, /Resume/).value, "Test_Candidate_Resume.pdf");

    const shot = await call("browser_screenshot", { application_id: id });
    assert.equal(shot.raw.content[0].type, "image");

    r = await call("submit_application", { application_id: id, ref: submit.ref });
    assert.equal(r.error, null, r.error ?? "");
    assert.equal(r.data.submitted, true);
    assert.equal(posts, 1);
    const job = getDb().prepare("SELECT workflow_state FROM jobs WHERE id = ?").get(id) as { workflow_state: string };
    assert.equal(job.workflow_state, "submitted");
    assert.equal(listEvents(id)[0].status, "applied");
    const payloads = fs.readdirSync(path.join(DATA_DIR, "artifacts", `job-${id}`)).filter((f) => f.startsWith("submission-"));
    assert.equal(payloads.length, 1, "what was sent is saved");
    const payload = fs.readFileSync(path.join(DATA_DIR, "artifacts", `job-${id}`, payloads[0]), "utf8");
    assert.match(payload, /Career fair/);
    assert.ok(!payload.includes(password));

    assert.match((await call("submit_application", { application_id: id, ref: submit.ref })).error!, /already recorded as submitted/);
  });
});

test("autofill fills what the Profile answers and lists the rest", async () => {
  await withFlags({ JOBMANAGER_MCP_BROWSER: "1" }, async () => {
    const id = newApplication("lever.html");
    await call("browser_open", { application_id: id });
    const r = await call("browser_autofill", { application_id: id });
    assert.equal(r.error, null, r.error ?? "");
    const email = r.data.fields.find((f: any) => /^Email/.test(f.label));
    assert.equal(email.status, "filled");
    assert.equal(email.answer, "test.candidate@example.com");
    assert.ok(r.data.fields.some((f: any) => f.status === "unknown"), "questions it can't answer are left for ChatGPT");
  });
});

test("a submit the site doesn't confirm is unknown and can't be retried", async () => {
  await withFlags({ JOBMANAGER_MCP_BROWSER: "1", JOBMANAGER_MCP_SUBMIT: "1" }, async () => {
    const id = newApplication("portal-apply.html");
    let r = await call("browser_open", { application_id: id });
    const page = browser.existingPage(id)!;
    // This site silently swallows the submission: no confirmation, form gone.
    await page.evaluate(() => {
      (window as unknown as { send: () => void }).send = () => { document.body.innerHTML = "<p>Loading…</p>"; };
    });
    let snap = r.data.snapshot;
    for (const [re, text] of [[/First name/, "Test"], [/^Email$/, "t@example.com"]] as const) {
      r = await call("browser_type", { application_id: id, ref: el(snap, re).ref, text });
      snap = r.data.snapshot;
    }
    r = await call("browser_choose", { application_id: id, ref: el(snap, /hear about/).ref, option: "Friend" });
    r = await call("browser_upload", { application_id: id, ref: el(r.data.snapshot, /Resume/).ref });
    snap = r.data.snapshot;
    r = await call("submit_application", { application_id: id, ref: el(snap, /Submit Application/).ref });
    assert.equal(r.error, null, r.error ?? "");
    assert.equal(r.data.state, "submission_unknown");
    assert.match((await call("submit_application", { application_id: id, ref: "e1" })).error!, /may already have gone through/);
  });
});

test("only the most recent applications keep a tab open", async () => {
  const small = new Harness(browser, { maxTabs: 1 });
  const a = newApplication("portal-apply.html");
  const b = newApplication("portal-signup.html");
  await small.open(a);
  assert.ok(browser.existingPage(a));
  await small.open(b);
  assert.equal(browser.existingPage(a), null, "the older tab was closed");
  assert.ok(browser.existingPage(b));
  // Reopening the first one just loads it again.
  const again = await small.open(a);
  assert.match(again.snapshot.title, /Apply/);
  assert.equal(browser.existingPage(b), null);
});

test("checkVisibility stand-in for old Chromium matches what's shown", async () => {
  const { COMPAT_SCRIPT } = await import("../src/lib/apply/browser");
  const id = newApplication("portal-apply.html");
  await harness.open(id);
  const page = browser.existingPage(id)!;
  const seen = await page.evaluate(String.raw`(() => {
    delete Element.prototype.checkVisibility;
    ${COMPAT_SCRIPT};
    document.body.insertAdjacentHTML("beforeend",
      '<div id="gone" style="display:none"><span id="inside">x</span></div><span id="ghost" style="visibility:hidden">y</span><span id="clear" style="opacity:0">z</span>');
    const v = (s, o) => document.querySelector(s).checkVisibility(o);
    return [v("#first"), v("#inside"), v("#ghost"), v("#ghost", { checkVisibilityCSS: true }), v("#clear", { checkOpacity: true })];
  })()`);
  assert.deepEqual(seen, [true, false, true, false, false]);
});

test("browser failures name the tool, the page and the browser", async () => {
  await withFlags({ JOBMANAGER_MCP_BROWSER: "1" }, async () => {
    const id = newApplication("portal-apply.html");
    const r = await call("browser_open", { application_id: id });
    // A text box isn't an upload button: no file picker opens, so Playwright times out.
    const err = (await call("browser_upload", { application_id: id, ref: el(r.data.snapshot, /First name/).ref })).error!;
    assert.match(err, /^Browser error in browser_upload: /);
    assert.match(err, /page http:\/\/127\.0\.0\.1:\d+\/portal-apply\.html/);
    assert.match(err, /HeadlessChrome\/[\d.]+|Chrom(e|ium)\/[\d.]+/);
  });
});
