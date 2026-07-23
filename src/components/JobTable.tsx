"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { STATUSES, statusLabel, type JobWithStatus, type Status } from "@/lib/types";
import { formatAgo } from "@/lib/format";
import StatusBadge from "./StatusBadge";
import QuickStatus from "./QuickStatus";

interface Props {
  jobs: JobWithStatus[];
  nextRounds: Record<number, number>;
}

export default function JobTable({ jobs, nextRounds }: Props) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<Status | "">("");

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return jobs.filter((job) => {
      if (statusFilter && job.latest_event?.status !== statusFilter) return false;
      if (q && !`${job.company} ${job.title}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [jobs, query, statusFilter]);

  const inputCls =
    "rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          placeholder="Search company or role…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className={`${inputCls} w-64`}
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as Status | "")}
          className={inputCls}
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <span className="ml-auto text-xs text-zinc-500">
          {filtered.length} of {jobs.length} applications
        </span>
      </div>

      <div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
            <tr>
              <th className="px-4 py-2.5">Company</th>
              <th className="px-4 py-2.5">Role</th>
              <th className="px-4 py-2.5">Status</th>
              <th className="px-4 py-2.5">In state for</th>
              <th className="px-4 py-2.5">Link</th>
              <th className="px-4 py-2.5">Update</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {filtered.map((job) => (
              <tr key={job.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-900/50">
                <td className="px-4 py-2.5 font-medium">
                  <Link href={`/jobs/${job.id}`} className="hover:underline">
                    {job.company}
                  </Link>
                </td>
                <td className="px-4 py-2.5 text-zinc-600 dark:text-zinc-400">
                  <Link href={`/jobs/${job.id}`} className="hover:underline">
                    {job.title}
                  </Link>
                </td>
                <td className="px-4 py-2.5">
                  <StatusBadge
                    status={job.latest_event?.status ?? null}
                    label={statusLabel(job.latest_event, job.pending_after)}
                  />
                </td>
                <td className="px-4 py-2.5 text-zinc-500">
                  {job.latest_event ? formatAgo(job.latest_event.occurred_at).replace(" ago", "") : "—"}
                </td>
                <td className="px-4 py-2.5">
                  {job.url ? (
                    <a
                      href={job.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-blue-600 hover:underline dark:text-blue-400"
                    >
                      posting ↗
                    </a>
                  ) : (
                    <span className="text-zinc-400">—</span>
                  )}
                </td>
                <td className="px-4 py-2.5">
                  <QuickStatus jobId={job.id} nextRound={nextRounds[job.id] ?? 1} />
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-zinc-400">
                  {jobs.length === 0 ? "No applications yet — add your first one above." : "No matches."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
