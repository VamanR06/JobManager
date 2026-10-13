import "./setup-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleMcpMessage } from "../src/lib/mcp";
import { createDocument, createEvent, createJob, getJob, listEvents, setDocumentArchived } from "../src/lib/queries";

function rpc(method: string, params?: Record<string, unknown>) {
  return (handleMcpMessage({ jsonrpc: "2.0", id: 1, method, params }) as { result?: any; error?: any })!;
}
const call = (name: string, args: Record<string, unknown>) => rpc("tools/call", { name, arguments: args }).result;
const toolNames = () => rpc("tools/list").result.tools.map((t: { name: string }) => t.name);

const WRITE_TOOLS = ["update_application", "add_status_update", "update_status_update"];

const job = createJob({ company: "Write Co", title: "SWE Intern", notes: "first note" });
createEvent({ job_id: job.id, status: "applied", occurred_at: "2026-09-01T12:00:00.000Z" });
const resume = createDocument("resume", "Write Co resume", "/tmp/r.pdf");
const oldResume = createDocument("resume", "Old resume", "/tmp/o.pdf");
setDocumentArchived(oldResume.id, true);
const letter = createDocument("cover_letter", "Write Co letter", "/tmp/c.pdf");

function withWrite(fn: () => void) {
  process.env.JOBMANAGER_MCP_WRITE = "1";
  try {
    fn();
  } finally {
    delete process.env.JOBMANAGER_MCP_WRITE;
  }
}

test("write tools are hidden and refused unless JOBMANAGER_MCP_WRITE is on", () => {
  assert.ok(!toolNames().some((n: string) => WRITE_TOOLS.includes(n)));
  assert.ok(toolNames().includes("list_documents"), "reading documents is always on");
  const res = call("update_application", { id: job.id, notes: "nope" });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /turned off/);
  assert.equal(getJob(job.id)!.notes, "first note");
  withWrite(() => {
    for (const n of WRITE_TOOLS) assert.ok(toolNames().includes(n), n);
    const tools = rpc("tools/list").result.tools;
    assert.ok(tools.filter((t: any) => WRITE_TOOLS.includes(t.name)).every((t: any) => t.annotations.readOnlyHint === false));
  });
});

test("list_documents searches names and skips archived ones by default", () => {
  const ids = (args: Record<string, unknown>) => call("list_documents", args).structuredContent.documents.map((d: { id: number }) => d.id);
  assert.deepEqual(ids({ kind: "resume", query: "write" }), [resume.id]);
  assert.deepEqual(ids({ query: "write co" }).sort(), [resume.id, letter.id].sort());
  assert.ok(!ids({ kind: "resume" }).includes(oldResume.id));
  assert.ok(ids({ kind: "resume", include_archived: true }).includes(oldResume.id));
  assert.equal(call("list_documents", { kind: "memo" }).isError, true);
});

test("update_application changes only what's passed, appends notes and links documents", () => {
  withWrite(() => {
    let app = call("update_application", { id: job.id, append_notes: "  recruiter: Jo  " }).structuredContent;
    assert.equal(app.notes, "first note\n\nrecruiter: Jo");
    assert.equal(app.company, "Write Co", "untouched");

    app = call("update_application", { id: job.id, title: " Backend Intern ", resume_id: resume.id, cover_letter_id: letter.id }).structuredContent;
    assert.equal(app.title, "Backend Intern");
    assert.deepEqual(app.resume, { id: resume.id, name: "Write Co resume", version: 1 });
    assert.equal(app.cover_letter.id, letter.id);
    assert.equal(app.notes, "first note\n\nrecruiter: Jo");

    app = call("update_application", { id: job.id, notes: "replaced", url: "https://x.example/job", cover_letter_id: null }).structuredContent;
    assert.equal(app.notes, "replaced");
    assert.equal(app.url, "https://x.example/job");
    assert.equal(app.cover_letter, null);
    assert.equal(app.resume.id, resume.id);

    const bad = (args: Record<string, unknown>, re: RegExp) => {
      const res = call("update_application", { id: job.id, ...args });
      assert.equal(res.isError, true, JSON.stringify(args));
      assert.match(res.content[0].text, re);
    };
    bad({ company: "  " }, /can't be blank/);
    bad({ resume_id: letter.id }, /isn't a resume/);
    bad({ notes: "a", append_notes: "b" }, /not both/);
    bad({}, /Nothing to change/);
    bad({ status: "applied" }, /Unknown field/);
    assert.equal(call("update_application", { id: 999_999, notes: "x" }).isError, true);
    assert.equal(getJob(job.id)!.company, "Write Co", "failed calls changed nothing");
  });
});

test("add_status_update records a new current status with its fields", () => {
  withWrite(() => {
    const app = call("add_status_update", {
      application_id: job.id,
      status: "interview",
      occurred_at: "2026-10-01T10:00:00-04:00",
      interview_round: 2,
      interview_held_at: "2026-10-03T15:30:00-04:00",
      pre_notes: "system design",
    }).structuredContent;
    assert.equal(app.status, "Interview R2");
    const ev = app.history[0];
    assert.equal(ev.occurred_at, "2026-10-01T14:00:00.000Z", "stored as UTC");
    assert.equal(ev.interview_held_at, "2026-10-03T19:30:00.000Z");
    assert.equal(ev.pre_notes, "system design");

    const bad = (args: Record<string, unknown>, re: RegExp) => {
      const res = call("add_status_update", { application_id: job.id, status: "oa", ...args });
      assert.equal(res.isError, true, JSON.stringify(args));
      assert.match(res.content[0].text, re);
    };
    bad({ status: "ghosted" }, /status must be one of/);
    bad({ oa_deadline_at: "2026-10-20T17:00" }, /timezone/);
    bad({ oa_deadline_at: "next friday" }, /timezone/);
    bad({ interview_round: 0 }, /1 or more/);
    bad({ occurred_at: null }, /can't be cleared/);
    assert.equal(listEvents(job.id).length, 2, "rejected calls added nothing");
  });
});

test("update_status_update edits one event; null clears a field", () => {
  withWrite(() => {
    const [interview, applied] = listEvents(job.id);
    let app = call("update_status_update", { id: interview.id, post_notes: "went well", interview_link: "https://meet.example/x" }).structuredContent;
    let ev = app.history.find((h: { id: number }) => h.id === interview.id);
    assert.equal(ev.post_notes, "went well");
    assert.equal(ev.interview_link, "https://meet.example/x");
    assert.equal(ev.pre_notes, "system design", "untouched");

    app = call("update_status_update", { id: interview.id, interview_link: null, pre_notes: null }).structuredContent;
    ev = app.history.find((h: { id: number }) => h.id === interview.id);
    assert.equal(ev.interview_link, null);
    assert.equal(ev.pre_notes, "");

    app = call("update_status_update", { id: applied.id, status: "oa", oa_score: "3/4" }).structuredContent;
    ev = app.history.find((h: { id: number }) => h.id === applied.id);
    assert.equal(ev.label, "OA (3/4)");
    assert.equal(app.status, "Interview R2", "the newer interview is still current");

    assert.equal(call("update_status_update", { id: 999_999, oa_score: "1" }).isError, true);
    assert.equal(call("update_status_update", { id: interview.id }).isError, true);
  });
});
