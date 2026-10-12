import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { ARTIFACTS_DIR, DATA_DIR } from "@/lib/db";
import { getArtifact } from "@/lib/automation";
import { getJob } from "@/lib/queries";
import { artifactDownloadName } from "@/lib/steps";

type Params = { params: Promise<{ id: string }> };

const KINDS = {
  pdf: { col: "pdf_path", type: "application/pdf", ext: ".pdf", inline: true },
  tex: { col: "tex_path", type: "text/plain; charset=utf-8", ext: ".tex", inline: true },
  report: { col: "report_path", type: "text/markdown; charset=utf-8", ext: ".md", inline: true },
} as const;

/** Serves an artifact file by id only — never by a client-supplied path. */
export async function GET(req: NextRequest, { params }: Params) {
  const artifact = getArtifact(Number((await params).id));
  if (!artifact) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const kind = (req.nextUrl.searchParams.get("kind") ?? "pdf") as keyof typeof KINDS;
  const spec = KINDS[kind];
  if (!spec) return NextResponse.json({ error: "kind must be pdf, tex or report" }, { status: 400 });
  const rel = artifact[spec.col];
  if (!rel) return NextResponse.json({ error: "Not available" }, { status: 404 });

  // Defence in depth: the stored path must still resolve inside the artifact store.
  const abs = path.resolve(DATA_DIR, rel);
  if (!abs.startsWith(ARTIFACTS_DIR + path.sep) || !fs.existsSync(abs)) {
    return NextResponse.json({ error: "File missing" }, { status: 404 });
  }
  const company = getJob(artifact.job_id)?.company ?? "Company";
  const name = `${artifactDownloadName(company)}_v${artifact.version}${spec.ext}`;
  const download = req.nextUrl.searchParams.get("download") === "1";
  return new NextResponse(new Uint8Array(fs.readFileSync(abs)), {
    headers: {
      "Content-Type": spec.type,
      "Content-Disposition": `${download || !spec.inline ? "attachment" : "inline"}; filename="${name.replace(/"/g, "")}"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  });
}
