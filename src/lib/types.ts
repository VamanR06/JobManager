export const STATUSES = ["applied", "oa", "interview", "pending", "rejected", "accepted"] as const;
export type Status = (typeof STATUSES)[number];

export interface Job {
  id: number;
  company: string;
  title: string;
  url: string | null;
  notes: string;
  resume_id: number | null;
  cover_letter_id: number | null;
  created_at: string;
}

export type DocumentKind = "resume" | "cover_letter";

export interface AppDocument {
  id: number;
  kind: DocumentKind;
  name: string;
  file_path: string;
  archived: 0 | 1;
  uploaded_at: string;
}

/** Document plus the jobs it's linked to (for the documents pages). */
export interface DocumentWithUsage extends AppDocument {
  used_by: { id: number; company: string; title: string }[];
}

export interface StatusEvent {
  id: number;
  job_id: number;
  status: Status;
  interview_round: number | null;
  oa_score: string | null;
  pre_notes: string;
  post_notes: string;
  occurred_at: string;
  created_at: string;
}

export interface Recording {
  id: number;
  status_event_id: number;
  file_path: string;
  started_at: string;
  ended_at: string | null;
  duration_sec: number | null;
  state: "recording" | "done" | "failed";
}

export interface Posting {
  job_id: number;
  title: string | null;
  company: string | null;
  location: string | null;
  description_md: string;
  source: "parsed" | "manual";
  fetch_status: "ok" | "failed";
  fetched_at: string;
}

/** Job row shape used by the dashboard: job + its latest status event. */
export interface JobWithStatus extends Job {
  latest_event: StatusEvent | null;
  /** For a 'pending' latest event: the most recent prior non-pending event it refers to. */
  pending_after: StatusEvent | null;
}

/** Human label for a status event, e.g. "Interview R2" or "Pending — after OA". */
export function statusLabel(event: StatusEvent | null, pendingAfter: StatusEvent | null): string {
  if (!event) return "No status";
  switch (event.status) {
    case "applied":
      return "Applied";
    case "oa":
      return event.oa_score ? `OA (${event.oa_score})` : "OA";
    case "interview":
      return event.interview_round ? `Interview R${event.interview_round}` : "Interview";
    case "rejected":
      return "Rejected";
    case "accepted":
      return "Accepted";
    case "pending":
      return pendingAfter
        ? `Pending — after ${statusLabel(pendingAfter, null)}`
        : "Pending";
  }
}
