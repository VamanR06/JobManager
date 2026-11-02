import { NextResponse } from "next/server";
import { listExperiences } from "@/lib/experience";
import { ADD_SECTIONS_SCRIPT, ATS_FRAMES_SCRIPT, PAGE_FILL_SCRIPT } from "@/lib/apply/page";
import { SCAN_SCRIPT } from "@/lib/apply/scan";

/**
 * The in-page scripts for filling an application in the person's own browser: `scan` reads the form (the same
 * reader as browser_autofill), `fill` takes the plan from /api/apply/resolve, `frames` finds forms embedded from
 * an ATS in a cross-origin iframe, and `add_sections` adds Work Experience entries until the page has
 * `sections.work` of them (one per job on the Profile).
 */
export async function GET() {
  return NextResponse.json({
    scan: SCAN_SCRIPT,
    fill: PAGE_FILL_SCRIPT,
    frames: ATS_FRAMES_SCRIPT,
    add_sections: ADD_SECTIONS_SCRIPT,
    sections: { work: listExperiences().length },
  });
}
