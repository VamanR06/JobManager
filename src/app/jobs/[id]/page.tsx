import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getDocument, getJob, getPosting, listDocuments, listEvents, listRecordings, pendingAfter,
} from "@/lib/queries";
import { formatElapsed } from "@/lib/format";
import { stageWindow } from "@/lib/types";
import JobHeader from "@/components/JobHeader";
import PostingSection from "@/components/PostingSection";
import ResumePreview from "@/components/ResumePreview";
import AddEventForm from "@/components/AddEventForm";
import EventCard from "@/components/EventCard";
import SubmissionBanner from "@/components/SubmissionBanner";
import { serverHarness } from "@/lib/apply/harness";
import TakeOverPanel from "@/components/TakeOverPanel";
import { getDb } from "@/lib/db";
import type { WorkflowState } from "@/lib/workflow-types";

export const dynamic = "force-dynamic";

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  const job = getJob(id);
  if (!job) notFound();

  const events = listEvents(id); // newest first
  const workflow = getDb()
    .prepare("SELECT workflow_state, workflow_detail FROM jobs WHERE id = ?")
    .get(id) as { workflow_state: WorkflowState | null; workflow_detail: string | null };
  const posting = getPosting(id);
  // ChatGPT has this application open in the server's browser (codes can be entered then).
  const tabOpen = serverHarness().hasTab(id);
  // Only generated resumes can be previewed/revised — uploads have no conversation.
  const linkedResume = job.resume_id ? getDocument(job.resume_id) : null;
  const generatedResume = linkedResume?.generated ? linkedResume : null;
  const nextRound = events
    .filter((e) => e.status === "interview")
    .reduce((max, e) => Math.max(max, e.interview_round ?? 0), 0) + 1;

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-8 space-y-6">
      <Link href="/" className="text-sm text-zinc-500 hover:underline">
        ← All applications
      </Link>

      <JobHeader job={job} resumes={listDocuments("resume")} coverLetters={listDocuments("cover_letter")} />
      {(workflow.workflow_state || tabOpen) && (
        <SubmissionBanner jobId={id} state={workflow.workflow_state} detail={workflow.workflow_detail} tabOpen={tabOpen} />
      )}
      {tabOpen && <TakeOverPanel jobId={id} />}
      <PostingSection jobId={id} posting={posting} hasUrl={!!job.url} />
      {generatedResume && <ResumePreview document={generatedResume} />}

      <section className="space-y-1">
        <h2 className="text-sm font-semibold">Status timeline</h2>
        <AddEventForm jobId={id} nextRound={nextRound} />
      </section>

      <section className="space-y-0">
        {events.map((event, i) => {
          const next = events[i + 1]; // chronologically previous event
          return (
            <div key={event.id}>
              <EventCard
                event={event}
                pendingAfter={pendingAfter(event)}
                recordings={listRecordings(event.id)}
              />
              {next && (
                <div className="flex items-center gap-2 py-1 pl-6 text-xs text-zinc-400">
                  <span>↑</span>
                  <span>
                    {formatElapsed(stageWindow(next).end, stageWindow(event).start)} later
                  </span>
                </div>
              )}
            </div>
          );
        })}
        {events.length === 0 && (
          <p className="rounded-xl border border-dashed border-zinc-300 px-4 py-8 text-center text-sm text-zinc-400 dark:border-zinc-700">
            No status updates yet — add the first one above.
          </p>
        )}
      </section>
    </main>
  );
}
