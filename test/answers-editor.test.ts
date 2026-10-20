import "./setup-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { getDb } from "../src/lib/db";
import { createJob } from "../src/lib/queries";
import { addGlobalAnswer, deleteAnswer, listAnswers, lookupAnswer, saveAnswer, updateAnswerText } from "../src/lib/apply/answers";

getDb();

test("an answer added on the Profile page is found for any company's form", () => {
  addGlobalAnswer("How did you hear about {company}?", "LinkedIn");
  const ctx = { company: "Acme Robotics", jobId: 1 };
  assert.equal(lookupAnswer("How did you hear about Acme Robotics? *", ["LinkedIn", "Friend"], ctx)?.answer, "LinkedIn");
  assert.equal(lookupAnswer("How did you hear about Globex?", [], { company: "Globex", jobId: 2 })?.answer, "LinkedIn");

  // Adding the same question again replaces the answer rather than duplicating it.
  addGlobalAnswer("How did you hear about {COMPANY}?", "Career fair");
  assert.equal(listAnswers().filter((r) => r.scope === "global").length, 1);
  assert.equal(lookupAnswer("How did you hear about Acme Robotics?", [], ctx)?.answer, "Career fair");
});

test("saved answers list with their scope, and can be edited and deleted", () => {
  const job = createJob({ company: "Initech", title: "Intern" });
  saveAnswer({ label: "Why Initech?", options: [], answer: "Staplers", scope: "job", company: "Initech", jobId: job.id });
  const row = listAnswers().find((r) => r.scope === "job")!;
  assert.equal(row.job_label, "Initech — Intern");

  assert.ok(updateAnswerText(row.id, "TPS reports"));
  assert.equal(lookupAnswer("Why Initech?", [], { company: "Initech", jobId: job.id })?.answer, "TPS reports");

  assert.ok(deleteAnswer(row.id));
  assert.equal(lookupAnswer("Why Initech?", [], { company: "Initech", jobId: job.id }), null);
  assert.equal(updateAnswerText(row.id, "x"), false);
});
