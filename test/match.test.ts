import "./setup-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { getDb } from "../src/lib/db";
import { saveApplicationFields, setProfileFacts } from "../src/lib/automation";
import { lookupAnswer } from "../src/lib/apply/answers";
import { aiMatch } from "../src/lib/apply/match";
import { createJob } from "../src/lib/queries";
import { fakePreflight } from "./helpers";

getDb();
const FAKE = path.join(__dirname, "fixtures", "fake-matcher.mjs");
setProfileFacts({ school: "University of Michigan", email: "t@example.com", work_authorized_us: "yes", demographic_policy: "decline" });

const field = (field_key: string, label: string, kind: string, category: string, options: string[] = []) => ({
  field_key, label, kind, required: true, options, category, answer: null, answer_source: null, status: "unknown", note: null, readback: null,
});

test("only verifiable matches are accepted; written, attestation and demographic questions are never sent", async () => {
  const id = createJob({ company: "Hudl", title: "Intern" }).id;
  saveApplicationFields(id, [
    field("#school", "School", "combobox", "fact", ["University of Michigan - Ann Arbor", "University of Michigan - Dearborn", "University of Michigan - Flint"]),
    field("#pay", "This internship pays $30/hour. Are you comfortable with that?", "combobox", "other", ["Yes", "No"]),
    field("#hear", "How did you hear about this job?", "text", "other"),
    field("#office", "Can you work on-site at our office?", "buttons", "other", ["Yes", "No"]),
    field("#raikes", "Are you currently a UNL Raikes School student?", "combobox", "other", ["Yes", "No"]),
    field("#why", "Why Hudl?", "textarea", "narrative"),
    field("#ack", "I certify the above", "checkbox", "attestation", ["I certify the above"]),
    field("#race", "Please indicate your race", "combobox", "demographic", ["Asian", "White", "I don't wish to answer"]),
  ]);
  const r = await aiMatch({ jobId: id, engine: "codex", preflight: fakePreflight(), bin: FAKE });

  assert.deepEqual(r.matched.map((m) => [m.label, m.value]), [["School", "University of Michigan - Ann Arbor"]]);
  assert.deepEqual(r.suggested.map((m) => [m.label, m.value]), [["Are you currently a UNL Raikes School student?", "No"]]);
  assert.equal(lookupAnswer("Are you currently a UNL Raikes School student?", ["Yes", "No"], { company: "Hudl", jobId: id }), null, "implied answers aren't saved until you confirm");
  assert.deepEqual(r.rejected.map((x) => x.why).sort(), [
    "\"Absolutely\" isn't one of the options",
    "cited a fact that doesn't exist (profile:does_not_exist)",
    "free text must be your saved value word for word",
  ].sort());

  const run = getDb().prepare("SELECT work_dir FROM codex_runs WHERE purpose = 'match_fields' ORDER BY id DESC LIMIT 1").get() as { work_dir: string };
  const seen = JSON.parse(fs.readFileSync(path.join(run.work_dir, "seen.json"), "utf8")) as string[];
  assert.ok(!seen.some((q) => /Why Hudl|certify|race/.test(q)), "those stay with you");
  const facts = JSON.parse(fs.readFileSync(path.join(run.work_dir, "facts.json"), "utf8")) as { id: string }[];
  assert.ok(!facts.some((f) => f.id === "profile:demographic_policy"));

  // The accepted match is saved for this application only.
  assert.deepEqual(lookupAnswer("School", ["University of Michigan - Ann Arbor", "University of Michigan - Dearborn", "University of Michigan - Flint"], { company: "Hudl", jobId: id }),
    { answer: "University of Michigan - Ann Arbor", scope: "job" });
  const other = createJob({ company: "Hudl", title: "Other" }).id;
  assert.equal(lookupAnswer("School", ["University of Michigan - Ann Arbor", "University of Michigan - Dearborn", "University of Michigan - Flint"], { company: "Hudl", jobId: other }), null);
});
