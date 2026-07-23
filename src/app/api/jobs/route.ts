import { NextRequest, NextResponse } from "next/server";
import { createJob, createEvent, listJobs, upsertPosting } from "@/lib/queries";
import { parsePostingUrl } from "@/lib/parser";
import { STATUSES } from "@/lib/types";

export async function GET() {
  return NextResponse.json(listJobs());
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { company, title, url, notes, posting, initial_status, occurred_at } = body;
  if (!company?.trim() || !title?.trim()) {
    return NextResponse.json({ error: "company and title are required" }, { status: 400 });
  }

  const job = createJob({ company: company.trim(), title: title.trim(), url: url || null, notes });

  if (initial_status && STATUSES.includes(initial_status)) {
    createEvent({ job_id: job.id, status: initial_status, occurred_at: occurred_at || null });
  }

  // Posting snapshot: reuse a parse the client already did, else try fetching now.
  if (posting?.description_md) {
    upsertPosting({ job_id: job.id, ...posting, source: "parsed", fetch_status: "ok" });
  } else if (job.url) {
    try {
      const parsed = await parsePostingUrl(job.url);
      upsertPosting({ job_id: job.id, ...parsed, source: "parsed", fetch_status: "ok" });
    } catch {
      upsertPosting({ job_id: job.id, description_md: "", source: "parsed", fetch_status: "failed" });
    }
  }

  return NextResponse.json(job, { status: 201 });
}
