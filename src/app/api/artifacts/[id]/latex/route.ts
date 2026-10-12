import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { ARTIFACTS_DIR, DATA_DIR, getDb } from "@/lib/db";
import { createArtifact, getArtifact, getProfileMap, nextArtifactVersion } from "@/lib/automation";
import { compileLatex } from "@/lib/latex";
import { logEvent } from "@/lib/queue";
import { EXPECTED_SECTIONS } from "@/lib/codex/verify";
import type { ArtifactCheck } from "@/lib/workflow-types";

type Params = { params: Promise<{ id: string }> };

const sha = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");
const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Hand edits to a resume's LaTeX, compiled locally (no model involved).
 *   { action: "render", tex }          → PDF preview (base64) + page count + errors
 *   { action: "save", tex, note? }     → a new pending-review version; earlier versions untouched
 */
export async function POST(req: NextRequest, { params }: Params) {
  const base = getArtifact(Number((await params).id));
  if (!base) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { action, tex, note } = await req.json();
  if (typeof tex !== "string" || !tex.trim()) return NextResponse.json({ error: "tex is required" }, { status: 400 });

  const result = await compileLatex(tex);
  if (!result.ok || !result.pdf) {
    return NextResponse.json({ ok: false, errors: result.errors }, { status: action === "save" ? 422 : 200 });
  }
  if (action === "render") {
    return NextResponse.json({ ok: true, pages: result.pages, pdf: result.pdf.toString("base64") });
  }
  if (action !== "save") return NextResponse.json({ error: "Unknown action" }, { status: 400 });

  // The same content checks a generated version gets, where they still apply.
  const checks: ArtifactCheck[] = [];
  checks.push(result.pages === 1
    ? { name: "one_page", status: "pass", detail: "Exactly one page" }
    : { name: "one_page", status: "fail", detail: `PDF has ${result.pages} pages` });
  const text = norm(result.text ?? "");
  const missing = EXPECTED_SECTIONS.filter((sec) => !text.includes(sec.toLowerCase()));
  checks.push(missing.length
    ? { name: "ats_sections", status: "fail", detail: `Section headings not found in extracted text: ${missing.join(", ")}` }
    : { name: "ats_sections", status: "pass", detail: "Education, Experience, Projects and Skills headings extract as text" });
  const profile = getProfileMap();
  const identity = (["full_name", "email"] as const).filter((k) => profile[k]);
  if (!identity.length) checks.push({ name: "identity", status: "skipped", detail: "No verified name/email in the profile to compare against" });
  else {
    const absent = identity.filter((k) => !text.includes(norm(profile[k])));
    checks.push(absent.length
      ? { name: "identity", status: "fail", detail: `Verified ${absent.join(" and ")} not found in the PDF text` }
      : { name: "identity", status: "pass", detail: `Verified ${identity.join(" and ")} present` });
  }
  checks.push({ name: "tex_matches_pdf", status: "pass", detail: "PDF compiled here from exactly this .tex" });
  checks.push({ name: "edited_by_hand", status: "skipped", detail: `Hand edit of v${base.version}; not re-checked by Resume Builder` });

  const version = nextArtifactVersion(base.job_id);
  const dir = path.join(ARTIFACTS_DIR, `job-${base.job_id}`, `v${version}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const write = (name: string, body: Buffer | string) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, body, { mode: 0o400, flag: "wx" });
    return path.relative(DATA_DIR, file);
  };
  const pdfRel = write("resume.pdf", result.pdf);
  const texRel = write("resume.tex", tex);
  write("checks.json", JSON.stringify(checks, null, 2));
  const artifact = createArtifact({
    job_id: base.job_id, codex_run_id: null, snapshot_id: base.snapshot_id, version,
    pdf_path: pdfRel, tex_path: texRel, report_path: null, pdf_sha256: sha(result.pdf), tex_sha256: sha(tex),
    page_count: result.pages, plugin_version: base.plugin_version, plugin_resource_hash: base.plugin_resource_hash,
    checks: JSON.stringify(checks), summary: `Hand-edited from v${base.version}`,
    feedback: typeof note === "string" && note.trim() ? note.trim().slice(0, 1000) : null, engine: "manual",
  });
  // The edit replaces the version it came from (if that was still awaiting review) and any
  // earlier unreviewed hand edit. An approved original stays linked until the edit is approved.
  getDb()
    .prepare(
      `UPDATE resume_artifacts SET status = 'superseded'
       WHERE job_id = ? AND id != ? AND status = 'pending_review' AND (id = ? OR engine = 'manual')`
    )
    .run(base.job_id, artifact.id, base.id);
  logEvent(base.job_id, "resume:edited", `v${version} hand-edited from v${base.version}`);
  return NextResponse.json({ ok: true, artifact }, { status: 201 });
}
