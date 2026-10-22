import { NextRequest, NextResponse } from "next/server";
import { createJob, createEvent, listJobs, updateJob, upsertPosting } from "@/lib/queries";
import { parsePostingUrl } from "@/lib/parser";
import { findDuplicates } from "@/lib/duplicates";
import { STATUSES } from "@/lib/types";

export async function GET() {
  return NextResponse.json(listJobs());
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { company, title, url, notes, posting, initial_status, occurred_at, resume_id, cover_letter_id, allow_duplicate } = body;
  if (!company?.trim() || !title?.trim()) {
    return NextResponse.json({ error: "company and title are required" }, { status: 400 });
  }
  // Already tracked (same posting), or the same company + title under another link: ask before adding.
  if (allow_duplicate !== true) {
    const dupes = findDuplicates({ url, company, title });
    if (dupes.same_posting || dupes.similar.length) {
      return NextResponse.json(
        {
          error: dupes.same_posting ? "You're already tracking this posting" : "You're already tracking a job with this company and title",
          ...dupes,
        },
        { status: 409 }
      );
    }
  }

  let job = createJob({ company: company.trim(), title: title.trim(), url: url || null, notes });
  if (resume_id || cover_letter_id) {
    job = updateJob(job.id, { resume_id: resume_id ?? null, cover_letter_id: cover_letter_id ?? null })!;
  }

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
