import "./setup-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeUrl, splitPastedUrls } from "../src/lib/urls";

function key(u: string) {
  const r = analyzeUrl(u);
  assert.ok(r.ok, `expected ${u} to parse`);
  return r.key;
}

test("equivalent Greenhouse links share one key", () => {
  const k = key("https://boards.greenhouse.io/acme/jobs/4012345");
  assert.equal(k, "greenhouse:4012345");
  assert.equal(key("https://job-boards.greenhouse.io/acme/jobs/4012345?gh_src=abc&utm_source=linkedin"), k);
  assert.equal(key("https://www.acme.com/careers/open-roles?gh_jid=4012345"), k);
  assert.equal(key("https://boards.greenhouse.io/embed/job_app?for=acme&token=4012345"), k);
});

test("Lever, Ashby, Workday, SmartRecruiters, iCIMS, LinkedIn, Indeed identities", () => {
  assert.equal(key("https://jobs.lever.co/acme/0f6a1a5e-2c3b-4d5e-8f90-1234567890ab/apply?lever-source=LinkedIn"), "lever:0f6a1a5e-2c3b-4d5e-8f90-1234567890ab");
  assert.equal(key("https://jobs.ashbyhq.com/acme/0F6A1A5E-2C3B-4D5E-8F90-1234567890AB/application"), "ashby:0f6a1a5e-2c3b-4d5e-8f90-1234567890ab");
  assert.equal(key("https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Software-Intern_JR1990000"), "workday:nvidia:jr1990000");
  assert.equal(key("https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/Remote/Software-Intern_JR1990000?source=x"), "workday:nvidia:jr1990000");
  assert.equal(key("https://jobs.smartrecruiters.com/Acme/743999912345678-software-engineer"), "smartrecruiters:743999912345678");
  assert.equal(key("https://careers-acme.icims.com/jobs/12345/software-engineer/job?hub=7"), "icims:acme:12345");
  assert.equal(key("https://www.linkedin.com/jobs/view/3912345678/?trk=abc"), "linkedin:3912345678");
  assert.equal(key("https://www.linkedin.com/jobs/collections/recommended/?currentJobId=3912345678"), "linkedin:3912345678");
  assert.equal(key("https://www.indeed.com/viewjob?jk=abcdef1234567890&from=serp"), "indeed:abcdef1234567890");
});

test("generic URLs drop tracking but keep job-identifying params", () => {
  const a = key("https://Careers.Example.com/job/?id=77&utm_campaign=x&ref=home#apply");
  const b = key("https://careers.example.com/job?ref=twitter&id=77");
  assert.equal(a, b);
  assert.notEqual(key("https://careers.example.com/job?id=77"), key("https://careers.example.com/job?id=78"));
  assert.notEqual(key("https://example.com/#/jobs/1"), key("https://example.com/#/jobs/2"));
});

test("invalid and unsupported links are reported individually", () => {
  assert.deepEqual(analyzeUrl("ftp://example.com/x").ok, false);
  assert.deepEqual(analyzeUrl("not a url").ok, false);
  const creds = analyzeUrl("https://user:pw@example.com/job");
  assert.ok(!creds.ok && creds.reason === "invalid");
  for (const local of ["http://127.0.0.1:8000/v1/chat", "http://localhost/api/jobs", "http://[::1]/", "http://192.168.1.10/", "https://example.com:8443/job"]) {
    const r = analyzeUrl(local);
    assert.ok(!r.ok && r.reason === "unsupported", local);
  }
  const search = analyzeUrl("https://www.linkedin.com/jobs/search/?keywords=swe");
  assert.ok(!search.ok && search.reason === "unsupported");
});

test("Oracle and Workable postings are recognised", () => {
  assert.equal(key("https://hcgn.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/49286?utm_source=Simplify"), "oracle:hcgn.fa.us2.oraclecloud.com:49286");
  assert.equal(key("https://apply.workable.com/twgai/j/772CD136FF/?utm_id=97760"), "workable:twgai:772CD136FF");
  assert.equal(key("https://apply.workable.com/twgai/j/772cd136ff/apply/"), "workable:twgai:772CD136FF");
});

test("links pasted with no separator are split; nested URL parameters are not", () => {
  assert.deepEqual(
    splitPastedUrls("https://job-boards.greenhouse.io/tanium/jobs/8181017?ref=Simplifyhttps://jobs.lever.co/xcimer/fee9965c-8040-4614-8fd1-10bddfe3b911/apply"),
    ["https://job-boards.greenhouse.io/tanium/jobs/8181017?ref=Simplify", "https://jobs.lever.co/xcimer/fee9965c-8040-4614-8fd1-10bddfe3b911/apply"]
  );
  assert.deepEqual(splitPastedUrls("https://example.com/go?url=https://jobs.example.com/1"), ["https://example.com/go?url=https://jobs.example.com/1"]);
});

test("pasted text splits into unique links", () => {
  assert.deepEqual(
    splitPastedUrls("https://a.com/1\n  https://a.com/1 <https://b.com/2>, https://c.com/3.\n"),
    ["https://a.com/1", "https://b.com/2", "https://c.com/3"]
  );
});
