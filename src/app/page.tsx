import { listJobs } from "@/lib/queries";
import { getDb } from "@/lib/db";
import AddJobForm from "@/components/AddJobForm";
import JobTable from "@/components/JobTable";

export const dynamic = "force-dynamic";

export default function Dashboard() {
  const jobs = listJobs();

  // Next interview round per job (max existing round + 1) for the quick-update control.
  const rows = getDb()
    .prepare(
      "SELECT job_id, COALESCE(MAX(interview_round), 0) + 1 AS next FROM status_events WHERE status = 'interview' GROUP BY job_id"
    )
    .all() as { job_id: number; next: number }[];
  const nextRounds = Object.fromEntries(rows.map((r) => [r.job_id, r.next]));

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-8 space-y-6">
      <h1 className="text-2xl font-bold">JobManager</h1>
      <AddJobForm />
      <JobTable jobs={jobs} nextRounds={nextRounds} />
    </main>
  );
}
