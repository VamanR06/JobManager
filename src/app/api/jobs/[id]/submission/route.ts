import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getJob } from "@/lib/queries";
import { markSubmitted, setWorkflow } from "@/lib/submission";

type Params = { params: Promise<{ id: string }> };

/**
 * Settles an application's submission state by hand:
 *   mark_submitted — you submitted it (adds an Applied status)
 *   not_submitted — after "submission unknown": you checked, and it didn't go through
 *   clear — back to tracked by hand (not while a submission is in flight or unknown)
 */
export async function POST(req: NextRequest, { params }: Params) {
  const id = Number((await params).id);
  if (!getJob(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { action } = await req.json();
  const state = (getDb().prepare("SELECT workflow_state FROM jobs WHERE id = ?").get(id) as { workflow_state: string | null }).workflow_state;

  switch (action) {
    case "mark_submitted":
      if (!markSubmitted(id, { how: "manual", detail: "Marked submitted on the job page" })) {
        return NextResponse.json({ error: "Already marked submitted" }, { status: 409 });
      }
      break;
    case "not_submitted":
      if (state !== "submission_unknown") return NextResponse.json({ error: "Only for a submission whose outcome is unknown" }, { status: 409 });
      setWorkflow(id, "ready_to_submit", "You checked: the submission didn't go through. It can be submitted again.");
      break;
    case "clear":
      if (state === "submitted" || state === "submitting" || state === "submission_unknown") {
        return NextResponse.json({ error: "Settle the submission first" }, { status: 409 });
      }
      setWorkflow(id, null);
      break;
    default:
      return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
