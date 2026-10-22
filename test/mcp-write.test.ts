import "./setup-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { DOCUMENTS_DIR } from "../src/lib/db";
import { handleMcpMessage, type McpDeps } from "../src/lib/mcp";
import type { FileDownloader } from "../src/lib/mcp-write";
import { createDocument, createEvent, createJob, getDocument, getJob, listEvents, setDocumentArchived } from "../src/lib/queries";

async function rpc(method: string, params?: Record<string, unknown>, deps?: McpDeps) {
  return (await handleMcpMessage({ jsonrpc: "2.0", id: 1, method, params }, deps)) as { result?: any; error?: any };
}
const call = async (name: string, args: Record<string, unknown>, deps?: McpDeps) =>
  (await rpc("tools/call", { name, arguments: args }, deps)).result;
const listTools = async () => (await rpc("tools/list")).result.tools;
const toolNames = async () => (await listTools()).map((t: { name: string }) => t.name);

const WRITE_TOOLS = ["update_application", "add_status_update", "update_status_update", "upload_document", "add_application"];

const job = createJob({ company: "Write Co", title: "SWE Intern", notes: "first note" });
createEvent({ job_id: job.id, status: "applied", occurred_at: "2026-09-01T12:00:00.000Z" });
const resume = createDocument("resume", "Write Co resume", "/tmp/r.pdf");
const oldResume = createDocument("resume", "Old resume", "/tmp/o.pdf");
setDocumentArchived(oldResume.id, true);
const letter = createDocument("cover_letter", "Write Co letter", "/tmp/c.pdf");

async function withWrite(fn: () => Promise<void>) {
  process.env.JOBMANAGER_MCP_WRITE = "1";
  try {
    await fn();
  } finally {
    delete process.env.JOBMANAGER_MCP_WRITE;
  }
}

test("write tools are hidden and refused unless JOBMANAGER_MCP_WRITE is on", async () => {
  assert.ok(!(await toolNames()).some((n: string) => WRITE_TOOLS.includes(n)));
  assert.ok((await toolNames()).includes("list_documents"), "reading documents is always on");
  const res = await call("update_application", { id: job.id, notes: "nope" });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /turned off/);
  assert.equal(getJob(job.id)!.notes, "first note");
  await withWrite(async () => {
    for (const n of WRITE_TOOLS) assert.ok((await toolNames()).includes(n), n);
    const tools = await listTools();
    assert.ok(tools.filter((t: any) => WRITE_TOOLS.includes(t.name)).every((t: any) => t.annotations.readOnlyHint === false));
  });
});

test("list_documents searches names and skips archived ones by default", async () => {
  const ids = async (args: Record<string, unknown>) =>
    (await call("list_documents", args)).structuredContent.documents.map((d: { id: number }) => d.id);
  assert.deepEqual(await ids({ kind: "resume", query: "write" }), [resume.id]);
  assert.deepEqual((await ids({ query: "write co" })).sort(), [resume.id, letter.id].sort());
  assert.ok(!(await ids({ kind: "resume" })).includes(oldResume.id));
  assert.ok((await ids({ kind: "resume", include_archived: true })).includes(oldResume.id));
  assert.equal((await call("list_documents", { kind: "memo" })).isError, true);
});

test("update_application changes only what's passed, appends notes and links documents", async () => {
  await withWrite(async () => {
    let app = (await call("update_application", { id: job.id, append_notes: "  recruiter: Jo  " })).structuredContent;
    assert.equal(app.notes, "first note\n\nrecruiter: Jo");
    assert.equal(app.company, "Write Co", "untouched");

    app = (await call("update_application", { id: job.id, title: " Backend Intern ", resume_id: resume.id, cover_letter_id: letter.id })).structuredContent;
    assert.equal(app.title, "Backend Intern");
    assert.deepEqual(app.resume, { id: resume.id, name: "Write Co resume", version: 1 });
    assert.equal(app.cover_letter.id, letter.id);
    assert.equal(app.notes, "first note\n\nrecruiter: Jo");

    app = (await call("update_application", { id: job.id, notes: "replaced", url: "https://x.example/job", cover_letter_id: null })).structuredContent;
    assert.equal(app.notes, "replaced");
    assert.equal(app.url, "https://x.example/job");
    assert.equal(app.cover_letter, null);
    assert.equal(app.resume.id, resume.id);

    const bad = async (args: Record<string, unknown>, re: RegExp) => {
      const res = await call("update_application", { id: job.id, ...args });
      assert.equal(res.isError, true, JSON.stringify(args));
      assert.match(res.content[0].text, re);
    };
    await bad({ company: "  " }, /can't be blank/);
    await bad({ resume_id: letter.id }, /isn't a resume/);
    await bad({ notes: "a", append_notes: "b" }, /not both/);
    await bad({}, /Nothing to change/);
    await bad({ status: "applied" }, /Unknown field/);
    assert.equal((await call("update_application", { id: 999_999, notes: "x" })).isError, true);
    assert.equal(getJob(job.id)!.company, "Write Co", "failed calls changed nothing");
  });
});

test("add_status_update records a new current status with its fields", async () => {
  await withWrite(async () => {
    const app = (await call("add_status_update", {
      application_id: job.id,
      status: "interview",
      occurred_at: "2026-10-01T10:00:00-04:00",
      interview_round: 2,
      interview_held_at: "2026-10-03T15:30:00-04:00",
      pre_notes: "system design",
    })).structuredContent;
    assert.equal(app.status, "Interview R2");
    const ev = app.history[0];
    assert.equal(ev.occurred_at, "2026-10-01T14:00:00.000Z", "stored as UTC");
    assert.equal(ev.interview_held_at, "2026-10-03T19:30:00.000Z");
    assert.equal(ev.pre_notes, "system design");

    const bad = async (args: Record<string, unknown>, re: RegExp) => {
      const res = await call("add_status_update", { application_id: job.id, status: "oa", ...args });
      assert.equal(res.isError, true, JSON.stringify(args));
      assert.match(res.content[0].text, re);
    };
    await bad({ status: "ghosted" }, /status must be one of/);
    await bad({ oa_deadline_at: "2026-10-20T17:00" }, /timezone/);
    await bad({ oa_deadline_at: "next friday" }, /timezone/);
    await bad({ interview_round: 0 }, /1 or more/);
    await bad({ occurred_at: null }, /can't be cleared/);
    assert.equal(listEvents(job.id).length, 2, "rejected calls added nothing");
  });
});

test("update_status_update edits one event; null clears a field", async () => {
  await withWrite(async () => {
    const [interview, applied] = listEvents(job.id);
    let app = (await call("update_status_update", { id: interview.id, post_notes: "went well", interview_link: "https://meet.example/x" })).structuredContent;
    let ev = app.history.find((h: { id: number }) => h.id === interview.id);
    assert.equal(ev.post_notes, "went well");
    assert.equal(ev.interview_link, "https://meet.example/x");
    assert.equal(ev.pre_notes, "system design", "untouched");

    app = (await call("update_status_update", { id: interview.id, interview_link: null, pre_notes: null })).structuredContent;
    ev = app.history.find((h: { id: number }) => h.id === interview.id);
    assert.equal(ev.interview_link, null);
    assert.equal(ev.pre_notes, "");

    app = (await call("update_status_update", { id: applied.id, status: "oa", oa_score: "3/4" })).structuredContent;
    ev = app.history.find((h: { id: number }) => h.id === applied.id);
    assert.equal(ev.label, "OA (3/4)");
    assert.equal(app.status, "Interview R2", "the newer interview is still current");

    assert.equal((await call("update_status_update", { id: 999_999, oa_score: "1" })).isError, true);
    assert.equal((await call("update_status_update", { id: interview.id })).isError, true);
  });
});

// ---------- upload_document ----------

const PDF = Buffer.from("%PDF-1.7\nfake resume v1\n%%EOF");
const PDF2 = Buffer.from("%PDF-1.7\nfake resume v2\n%%EOF");
const DOCX = Buffer.from("PK\u0003\u0004fake docx");

/** A downloader that serves `bytes` and counts calls. */
function serve(bytes: Buffer, status = 200) {
  const calls: string[] = [];
  const download: FileDownloader = async (url) => {
    calls.push(url);
    return { ok: status >= 200 && status < 300, status, bytes };
  };
  return { deps: { download }, calls };
}

const attached = (file_name?: string, mime_type?: string) => ({
  download_url: "https://files.example.com/abc?sig=1",
  file_id: "file-abc",
  ...(file_name && { file_name }),
  ...(mime_type && { mime_type }),
});

test("upload_document declares its file param for ChatGPT", async () => {
  await withWrite(async () => {
    const tool = (await listTools()).find((t: { name: string }) => t.name === "upload_document");
    assert.deepEqual(tool._meta, { "openai/fileParams": ["file"] });
    assert.deepEqual(tool.inputSchema.properties.file.required, ["download_url", "file_id"]);
  });
  const res = await call("upload_document", { file: attached("a.pdf") }, serve(PDF).deps);
  assert.match(res.content[0].text, /turned off/);
});

test("upload_document saves the file, versions by name, and links it to an application", async () => {
  await withWrite(async () => {
    const target = createJob({ company: "Upload Co", title: "SWE" });
    const first = serve(PDF);
    let out = (await call("upload_document", { file: attached("Vaman Resume.pdf", "application/pdf"), application_id: target.id }, first.deps)).structuredContent;
    assert.deepEqual(first.calls, ["https://files.example.com/abc?sig=1"]);
    assert.equal(out.document.name, "Vaman Resume.pdf");
    assert.equal(out.document.kind, "resume");
    assert.equal(out.document.version, 1);
    assert.equal(out.document.duplicate, false);
    assert.equal(out.application.resume.id, out.document.id);
    const stored = getDocument(out.document.id)!;
    assert.deepEqual(fs.readFileSync(path.join(DOCUMENTS_DIR, path.basename(stored.file_path))), PDF);
    const firstId = out.document.id;

    out = (await call("upload_document", { file: attached("Vaman Resume.pdf") }, serve(PDF).deps)).structuredContent;
    assert.equal(out.document.id, firstId, "identical re-upload is reused");
    assert.equal(out.document.duplicate, true);
    assert.equal(out.application, undefined, "no application_id, nothing linked");

    out = (await call("upload_document", { file: attached("Vaman Resume.pdf") }, serve(PDF2).deps)).structuredContent;
    assert.equal(out.document.version, 2, "same name, new content");

    out = (await call("upload_document", { file: attached("x.docx"), name: "Stripe resume", kind: "resume" }, serve(DOCX).deps)).structuredContent;
    assert.equal(out.document.name, "Stripe resume.docx", "extension taken from the attachment");

    out = (await call("upload_document", { file: attached(undefined, "application/pdf"), kind: "cover_letter", application_id: target.id }, serve(PDF).deps)).structuredContent;
    assert.equal(out.document.name, "Cover letter.pdf", "named from kind + MIME type");
    assert.equal(out.application.cover_letter.id, out.document.id);
    assert.equal(out.application.resume.id, firstId, "resume link untouched");
  });
});

test("upload_document rejects bad input before or after downloading", async () => {
  await withWrite(async () => {
    const bad = async (args: Record<string, unknown>, bytes: Buffer, re: RegExp, status = 200) => {
      const s = serve(bytes, status);
      const res = await call("upload_document", args, s.deps);
      assert.equal(res.isError, true, JSON.stringify(args));
      assert.match(res.content[0].text, re);
      return s.calls.length;
    };
    assert.equal(await bad({}, PDF, /attached/), 0);
    assert.equal(await bad({ file: { download_url: "http://files.example.com/x", file_id: "f" } }, PDF, /https/), 0);
    assert.equal(await bad({ file: attached("a.pdf"), application_id: 999_999 }, PDF, /No application/), 0);
    assert.equal(await bad({ file: attached("photo.png", "image/png") }, PDF, /Only \.pdf/), 0);
    assert.equal(await bad({ file: attached("a.pdf"), kind: "memo" }, PDF, /kind must be/), 0);
    assert.equal(await bad({ file: attached("a.pdf"), extra: 1 }, PDF, /Unknown field/), 0);
    await bad({ file: attached("a.pdf") }, Buffer.from("<html>not a pdf"), /isn't a valid PDF/);
    await bad({ file: attached("a.docx") }, PDF, /isn't a valid \.docx/);
    await bad({ file: attached("a.pdf") }, Buffer.alloc(0), /empty/);
    await bad({ file: attached("a.pdf") }, PDF, /expired/, 403);

    const tooBig: FileDownloader = async () => {
      throw new Error("Response too large");
    };
    const res = await call("upload_document", { file: attached("a.pdf") }, { download: tooBig });
    assert.match(res.content[0].text, /over 10 MB/);
  });
});
