import Link from "next/link";
import { redirect } from "next/navigation";
import { listJobs } from "@/lib/queries";
import { statusLabel, type JobWithStatus } from "@/lib/types";
import { formatAgo } from "@/lib/format";
import StatusBadge from "@/components/StatusBadge";
import {
  AUTO_NAVIGATE_SCORE,
  normalize,
  searchCompanies,
  searchFreeText,
  searchJobs,
  type JobMatch,
} from "@/lib/search";

export const dynamic = "force-dynamic";

/**
 * URL search. Meant for browser keyword shortcuts (e.g. `@jobs` in Chrome), which
 * append whatever you type onto the base URL:
 *
 *   /google                    → Google's applications (or straight to it if there's only one)
 *   /google/swe-intern         → closest application at Google to "swe intern"
 *   /search google swe intern  → free-text: leading "search" is stripped, rest is fuzzy-matched
 *
 * Segments are decoded and dashes/underscores/plus signs treated as spaces, so
 * "software+engineer" and "software-engineer" behave the same.
 */

/** Leading words that just mean "this is a search", not part of the query. */
const SEARCH_PREFIXES = new Set(["search", "s", "find", "go", "q"]);

function decodeSegment(segment: string): string {
  let text = segment;
  try {
    text = decodeURIComponent(segment);
  } catch {
    // Malformed percent-encoding — use the raw segment.
  }
  return text.replace(/[-_+]+/g, " ").trim();
}

interface ParsedQuery {
  /** The raw text, for display. */
  raw: string;
  company?: string;
  role?: string;
  /** True when the query wasn't cleanly split into company/role. */
  freeText: boolean;
}

function parseQuery(slug: string[]): ParsedQuery | null {
  const parts = slug.map(decodeSegment).filter(Boolean);
  if (!parts.length) return null;

  // A "search …" prefix may arrive as its own segment or as the first word of one.
  const first = parts[0];
  const firstWords = first.split(/\s+/);
  if (SEARCH_PREFIXES.has(normalize(firstWords[0]))) {
    const rest = [firstWords.slice(1).join(" "), ...parts.slice(1)].filter(Boolean);
    const raw = rest.join(" ").trim();
    if (!raw) return null;
    // After a search prefix, treat everything as free text — the user typed a
    // sentence, not a path.
    return { raw, freeText: true };
  }

  if (parts.length === 1) {
    // A single segment is a company name (possibly multi-word).
    return { raw: first, company: first, freeText: false };
  }
  // /company/role — extra segments fold into the role.
  return {
    raw: parts.join(" / "),
    company: parts[0],
    role: parts.slice(1).join(" "),
    freeText: false,
  };
}

export default async function SearchPage({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  const query = parseQuery(slug);
  if (!query) redirect("/");

  const jobs = listJobs();
  const byId = new Map(jobs.map((j) => [j.id, j]));

  // --- resolve ---

  if (query.freeText) {
    const matches = searchFreeText(query.raw, jobs);
    if (matches.length === 1 && matches[0].score >= AUTO_NAVIGATE_SCORE) {
      redirect(`/jobs/${matches[0].job.id}`);
    }
    if (matches.length > 1 && matches[0].score >= AUTO_NAVIGATE_SCORE && matches[0].score - matches[1].score >= 0.15) {
      redirect(`/jobs/${matches[0].job.id}`);
    }
    return <Results query={query} matches={matches} byId={byId} totalJobs={jobs.length} />;
  }

  if (query.role) {
    // Company + role: narrow to the best-matching company when there is one,
    // otherwise score against everything.
    const companies = searchCompanies(query.company!);
    const pool = companies.length ? companies[0].jobs : jobs;
    const matches = searchJobs({ company: query.company, role: query.role }, pool);
    if (matches.length && matches[0].score >= AUTO_NAVIGATE_SCORE) {
      redirect(`/jobs/${matches[0].job.id}`);
    }
    if (matches.length === 1) redirect(`/jobs/${matches[0].job.id}`);
    return <Results query={query} matches={matches} byId={byId} totalJobs={jobs.length} />;
  }

  // Company only.
  const companies = searchCompanies(query.company!);
  if (companies.length === 1 && companies[0].jobs.length === 1) {
    redirect(`/jobs/${companies[0].jobs[0].id}`);
  }
  if (companies.length && companies[0].score >= AUTO_NAVIGATE_SCORE) {
    // One clear company with several roles — list just that company's positions.
    const matches: JobMatch[] = companies[0].jobs.map((job) => ({
      job,
      score: companies[0].score,
      matchedOn: "company" as const,
    }));
    return (
      <Results
        query={query}
        matches={matches}
        byId={byId}
        totalJobs={jobs.length}
        heading={`Positions at ${companies[0].company}`}
      />
    );
  }
  return <Results query={query} matches={searchFreeText(query.raw, jobs)} byId={byId} totalJobs={jobs.length} />;
}

function Results({
  query,
  matches,
  byId,
  totalJobs,
  heading,
}: {
  query: ParsedQuery;
  matches: JobMatch[];
  byId: Map<number, JobWithStatus>;
  totalJobs: number;
  heading?: string;
}) {
  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-8 space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold">{heading ?? `Search: ${query.raw}`}</h1>
        <p className="text-sm text-zinc-500">
          {matches.length === 0
            ? `No matches among ${totalJobs} applications.`
            : `${matches.length} match${matches.length === 1 ? "" : "es"}`}
        </p>
      </div>

      {matches.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
              <tr>
                <th className="px-4 py-2.5">Company</th>
                <th className="px-4 py-2.5">Role</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5">In state for</th>
                <th className="px-4 py-2.5">Match</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {matches.map(({ job, score }) => {
                const withStatus = byId.get(job.id);
                return (
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
                        status={withStatus?.latest_event?.status ?? null}
                        label={statusLabel(withStatus?.latest_event ?? null, withStatus?.pending_after ?? null)}
                      />
                    </td>
                    <td className="px-4 py-2.5 text-zinc-500">
                      {withStatus?.latest_event
                        ? formatAgo(withStatus.latest_event.occurred_at).replace(" ago", "")
                        : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-zinc-400">{Math.round(score * 100)}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Link href="/" className="inline-block text-sm text-blue-600 hover:underline dark:text-blue-400">
        ← All applications
      </Link>
    </main>
  );
}
