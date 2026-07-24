import { NextRequest, NextResponse } from "next/server";
import { createEvent, getJob, listEvents } from "@/lib/queries";
import { STATUSES } from "@/lib/types";

export async function GET(req: NextRequest) {
  const jobId = Number(req.nextUrl.searchParams.get("job_id"));
  if (!jobId) return NextResponse.json({ error: "job_id query param required" }, { status: 400 });
  return NextResponse.json(listEvents(jobId));
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  if (!getJob(Number(body.job_id))) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }
  if (!STATUSES.includes(body.status)) {
    return NextResponse.json({ error: `status must be one of: ${STATUSES.join(", ")}` }, { status: 400 });
  }
  const event = createEvent({
    job_id: Number(body.job_id),
    status: body.status,
    interview_round: body.interview_round != null ? Number(body.interview_round) : null,
    oa_score: body.oa_score ?? null,
    oa_sent_at: body.oa_sent_at || null,
    oa_submitted_at: body.oa_submitted_at || null,
    interview_offered_at: body.interview_offered_at || null,
    interview_held_at: body.interview_held_at || null,
    pre_notes: body.pre_notes ?? "",
    post_notes: body.post_notes ?? "",
    occurred_at: body.occurred_at || null,
  });
  return NextResponse.json(event, { status: 201 });
}
