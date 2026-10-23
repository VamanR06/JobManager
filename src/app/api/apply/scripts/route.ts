import { NextResponse } from "next/server";
import { ATS_FRAMES_SCRIPT, PAGE_FILL_SCRIPT } from "@/lib/apply/page";
import { SCAN_SCRIPT } from "@/lib/apply/scan";

/**
 * The in-page scripts for filling an application in the person's own browser: `scan` reads the form (the same
 * reader as browser_autofill), `fill` takes the plan from /api/apply/resolve, `frames` finds forms embedded from
 * an ATS in a cross-origin iframe.
 */
export async function GET() {
  return NextResponse.json({ scan: SCAN_SCRIPT, fill: PAGE_FILL_SCRIPT, frames: ATS_FRAMES_SCRIPT });
}
