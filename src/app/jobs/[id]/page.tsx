import Link from "next/link";
import { notFound } from "next/navigation";
import { getJob, getPosting, listEvents, listRecordings, pendingAfter } from "@/lib/queries";
import { formatElapsed } from "@/lib/format";
import JobHeader from "@/components/JobHeader";
import PostingSection from "@/components/PostingSection";
import AddEventForm from "@/components/AddEventForm";
import EventCard from "@/components/EventCard";

export const dynamic = "force-dynamic";

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  const job = getJob(id);
  if (!job) notFound();

  const events = listEvents(id); // newest first
  const posting = getPosting(id);
  const nextRound = events
    .filter((e) => e.status === "interview")
    .reduce((max, e) => Math.max(max, e.interview_round ?? 0), 0) + 1;

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-8 space-y-6">
      <Link href="/" className="text-sm text-zinc-500 hover:underline">
        ← All applications
      </Link>

      <JobHeader job={job} />
      <PostingSection jobId={id} posting={posting} hasUrl={!!job.url} />

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
                  <span>{formatElapsed(next.occurred_at, event.occurred_at)} later</span>
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
