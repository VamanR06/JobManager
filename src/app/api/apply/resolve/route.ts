import { NextRequest, NextResponse } from "next/server";
import { parseScannedFields, planFill } from "@/lib/apply/page";
import { getJob } from "@/lib/queries";

/**
 * Body: { job_id, fields } where fields is SCAN_SCRIPT's output. Returns what to fill (`fill`, for the in-page
 * filler) and every field's status (`fields`: resolved, unknown = needs the person, skipped, unsupported), by the
 * same rules as browser_autofill. Doesn't touch the job or save anything.
 */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const jobId = Number(body.job_id);
  if (!jobId || !getJob(jobId)) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  const fields = parseScannedFields(body.fields);
  if (!fields) return NextResponse.json({ error: "fields must be the form scanner's field list" }, { status: 400 });
  return NextResponse.json(planFill(jobId, fields));
}
