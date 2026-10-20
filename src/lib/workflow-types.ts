/** Types for applying through ChatGPT (apply/*) and the Profile. Kept apart from types.ts so client components can import them cheaply. */

/**
 * Where an application is in applying through ChatGPT (mcp-browser.ts); NULL =
 * tracked by hand. Deliberately separate from recruiting outcomes
 * (applied/OA/interview/…), which stay in status_events. Older values (queued,
 * extracting, generating_resume, …) may still be stored from the removed
 * resume queue; they're shown as-is.
 */
export const WORKFLOW_STATES = [
  "queued", "extracting", "generating_resume", "validating_resume", "filling", "needs_input",
  "ready_to_submit", "submitting", "submitted", "submission_unknown", "retry_wait", "failed", "cancelled",
] as const;
export type WorkflowState = (typeof WORKFLOW_STATES)[number];

/** Profile keys the editor offers. Values are only ever what the user typed. */
export const PROFILE_FIELDS = [
  { key: "first_name", label: "Legal first name", group: "Contact" },
  { key: "last_name", label: "Legal last name", group: "Contact" },
  { key: "full_name", label: "Full legal name", group: "Contact" },
  { key: "preferred_name", label: "Preferred name", group: "Contact" },
  { key: "email", label: "Email", group: "Contact" },
  { key: "phone", label: "Phone", group: "Contact" },
  { key: "location", label: "Current city, state", group: "Contact" },
  { key: "country", label: "Country of residence", group: "Contact" },
  { key: "current_company", label: "Current company / employer", group: "Contact" },
  { key: "current_title", label: "Current job title", group: "Contact" },
  { key: "linkedin", label: "LinkedIn URL", group: "Links" },
  { key: "github", label: "GitHub URL", group: "Links" },
  { key: "website", label: "Portfolio / website", group: "Links" },
  { key: "school", label: "School", group: "Education" },
  { key: "degree", label: "Degree (e.g. Bachelor of Science in Engineering)", group: "Education" },
  { key: "major", label: "Major / discipline", group: "Education" },
  { key: "graduation", label: "Graduation (month year, e.g. May 2028)", group: "Education" },
  { key: "gpa", label: "GPA", group: "Education" },
  { key: "work_authorized_us", label: "Authorized to work in the US? (yes/no)", group: "Eligibility" },
  { key: "needs_sponsorship_now", label: "Requires visa sponsorship now? (yes/no)", group: "Eligibility" },
  { key: "needs_sponsorship_future", label: "Will require sponsorship in the future? (yes/no)", group: "Eligibility" },
  { key: "earliest_start", label: "Earliest start date", group: "Availability" },
  { key: "relocation", label: "Willing to relocate? (yes/no/depends)", group: "Availability" },
  { key: "demographic_policy", label: "Voluntary demographic questions (e.g. \"decline to answer\")", group: "Policy" },
] as const;
export type ProfileKey = (typeof PROFILE_FIELDS)[number]["key"];

export interface ProfileFact {
  key: string;
  value: string;
  verified_at: string | null;
  updated_at: string;
}

/** How a form question is handled (plan §6). */
export type FieldCategory = "fact" | "eligibility" | "demographic" | "attestation" | "narrative" | "file" | "other";
/** resolved → will be filled; unknown → needs you; skipped → optional, left blank; filled/mismatch after read-back. */
export type FieldStatus = "resolved" | "unknown" | "skipped" | "filled" | "mismatch" | "unsupported";

export type AnswerScope = "global" | "company" | "job";
