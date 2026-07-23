import { NextRequest, NextResponse } from "next/server";
import { getJob, getPosting, upsertPosting } from "@/lib/queries";
import { parsePostingUrl } from "@/lib/parser";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const posting = getPosting(Number((await params).id));
  return NextResponse.json(posting);
}

/** Re-fetch from the job's URL (`{action:"refetch"}`) or save a manual description (`{description_md}`). */
export async function POST(req: NextRequest, { params }: Params) {
  const jobId = Number((await params).id);
  const job = getJob(jobId);
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json();

  if (body.action === "refetch") {
    if (!job.url) return NextResponse.json({ error: "Job has no URL" }, { status: 400 });
    try {
      const parsed = await parsePostingUrl(job.url);
      return NextResponse.json(
        upsertPosting({ job_id: jobId, ...parsed, source: "parsed", fetch_status: "ok" })
      );
    } catch (err) {
      const existing = getPosting(jobId);
      // Don't clobber a good snapshot with a failed refetch.
      if (!existing?.description_md) {
        upsertPosting({ job_id: jobId, description_md: "", source: "parsed", fetch_status: "failed" });
      }
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Fetch failed" },
        { status: 422 }
      );
    }
  }

  if (typeof body.description_md === "string") {
    return NextResponse.json(
      upsertPosting({
        job_id: jobId,
        title: body.title ?? null,
        company: body.company ?? null,
        location: body.location ?? null,
        description_md: body.description_md,
        source: "manual",
        fetch_status: "ok",
      })
    );
  }

  return NextResponse.json({ error: "Expected {action:'refetch'} or {description_md}" }, { status: 400 });
}
