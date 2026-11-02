import { NextRequest, NextResponse } from "next/server";
import { ADD_SECTIONS_SCRIPT, ATS_FRAMES_SCRIPT, PAGE_FILL_SCRIPT } from "@/lib/apply/page";
import { SCAN_SCRIPT } from "@/lib/apply/scan";
import { experiencesForJob } from "@/lib/resume-experience";

/**
 * The in-page scripts for filling an application in the person's own browser: `scan` reads the form (the same
 * reader as browser_autofill), `fill` takes the plan from /api/apply/resolve, `frames` finds forms embedded from
 * an ATS in a cross-origin iframe, and `add_sections` adds Work Experience entries until the page has
 * `sections.work` of them: one per Profile job that `?job_id`'s resume mentions (every Profile job without one).
 * `experience` says which jobs those are, and why it fell back to all of them if it did.
 */
export async function GET(req: NextRequest) {
  const jobId = Number(req.nextUrl.searchParams.get("job_id")) || null;
  const match = await experiencesForJob(jobId);
  return NextResponse.json({
    scan: SCAN_SCRIPT,
    fill: PAGE_FILL_SCRIPT,
    frames: ATS_FRAMES_SCRIPT,
    add_sections: ADD_SECTIONS_SCRIPT,
    sections: { work: match.experiences.length },
    experience: {
      companies: match.experiences.map((e) => e.company),
      from_resume: match.fallback === null,
      note: match.fallback,
    },
  });
}
