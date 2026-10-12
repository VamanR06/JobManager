#!/usr/bin/env node
/** Stand-in engine for AI matching: returns one good match and several bad ones. */
import fs from "fs";
const args = process.argv.slice(2);
fs.readFileSync(0, "utf8");
const qs = JSON.parse(fs.readFileSync("questions.json", "utf8"));
fs.writeFileSync("seen.json", JSON.stringify(qs.map((q) => q.question)));
const facts = JSON.parse(fs.readFileSync("facts.json", "utf8"));
const school = facts.find((f) => f.id === "profile:school");
const pick = (re) => qs.find((q) => re.test(q.question));
const matches = [];
const s = pick(/^School/);
if (s) matches.push({ field_key: s.field_key, fact_id: school.id, value: "University of Michigan - Ann Arbor", kind: "direct", reason: "Profile school is University of Michigan; Ann Arbor is its main campus listed" });
const pay = pick(/pay/);
if (pay) matches.push({ field_key: pay.field_key, fact_id: "profile:work_authorized_us", value: "Absolutely", kind: "direct", reason: "invented option" });
const hear = pick(/hear about/);
if (hear) matches.push({ field_key: hear.field_key, fact_id: "profile:email", value: "a friend told me", kind: "direct", reason: "altered free text" });
const office = pick(/office/);
if (office) matches.push({ field_key: office.field_key, fact_id: "profile:does_not_exist", value: "Yes", kind: "direct", reason: "made-up fact" });
const raikes = pick(/Raikes/);
if (raikes) matches.push({ field_key: raikes.field_key, fact_id: school.id, value: "No", kind: "implied", reason: "Candidate attends the University of Michigan" });
const result = { matches };
if (args[0] === "exec") fs.writeFileSync(args[args.indexOf("-o") + 1], JSON.stringify(result));
else process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, usage: {}, structured_output: result }) + "\n");
process.exit(0);
