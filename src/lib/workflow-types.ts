/** Automation types. Kept apart from types.ts so client components can import them cheaply. */

/**
 * Where an application is in the automation pipeline. Deliberately separate from
 * recruiting outcomes (applied/OA/interview/…), which stay in status_events.
 */
export const WORKFLOW_STATES = [
  "queued", "extracting", "generating_resume", "validating_resume", "filling", "needs_input",
  "ready_to_submit", "submitting", "submitted", "submission_unknown", "retry_wait", "failed", "cancelled",
] as const;
export type WorkflowState = (typeof WORKFLOW_STATES)[number];

export type TaskStep = "extract" | "resume" | "prepare";
/** Which agent CLI runs the Resume Builder plugin. */
export type ResumeEngineName = "codex" | "claude";
/** Who produced a resume version: an engine, or you in the LaTeX editor. */
export type ArtifactOrigin = ResumeEngineName | "manual";
export const ENGINE_LABELS: Record<ArtifactOrigin, string> = { codex: "Codex", claude: "Claude", manual: "Edited by you" };
export type TaskState = "queued" | "running" | "blocked" | "done" | "failed" | "cancelled";
/** Tasks sharing a scarce resource never run concurrently (one browser, one Codex run). */
export type TaskResource = "network" | "codex" | "browser";

export interface Task {
  id: number;
  job_id: number;
  step: TaskStep;
  resource: TaskResource;
  state: TaskState;
  payload: string;
  attempts: number;
  max_attempts: number;
  run_after: string;
  lease_owner: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  cancel_requested: 0 | 1;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkflowEvent {
  id: number;
  job_id: number;
  task_id: number | null;
  type: string;
  message: string;
  created_at: string;
}

export interface JobSnapshot {
  id: number;
  job_id: number;
  source_url: string;
  final_url: string | null;
  canonical_url: string | null;
  application_url: string | null;
  title: string | null;
  company: string | null;
  location: string | null;
  employment_type: string | null;
  posting_id: string | null;
  description_md: string;
  content_sha256: string;
  method: string;
  captured_at: string;
}

export interface CodexRun {
  id: number;
  job_id: number;
  task_id: number | null;
  attempt: number;
  purpose: string;
  work_dir: string;
  plugin_ref: string | null;
  plugin_version: string | null;
  plugin_resource_hash: string | null;
  cli_version: string | null;
  model: string | null;
  owner: string | null;
  pid: number | null;
  proc_start: string | null;
  session_id: string | null;
  state: "starting" | "running" | "exited" | "abandoned";
  outcome: string | null;
  exit_code: number | null;
  exit_signal: string | null;
  blockers: string;
  evidence: string;
  usage: string | null;
  event_count: number;
  error: string | null;
  started_at: string;
  finished_at: string | null;
  engine: ResumeEngineName;
}

export interface ArtifactCheck {
  name: string;
  /** "skipped" means the check could not run (e.g. no verified profile) — never counted as a pass. */
  status: "pass" | "fail" | "skipped";
  detail: string;
}

export interface ResumeArtifact {
  id: number;
  job_id: number;
  codex_run_id: number | null;
  snapshot_id: number | null;
  version: number;
  pdf_path: string;
  tex_path: string;
  report_path: string | null;
  pdf_sha256: string;
  tex_sha256: string;
  page_count: number | null;
  plugin_version: string | null;
  plugin_resource_hash: string | null;
  checks: string;
  summary: string;
  feedback: string | null;
  status: "pending_review" | "approved" | "rejected" | "superseded";
  document_id: number | null;
  created_at: string;
  engine: ArtifactOrigin;
}

/** One row of the queue page. */
export interface QueueRow {
  job_id: number;
  company: string;
  title: string;
  url: string | null;
  ats: string | null;
  workflow_state: WorkflowState;
  workflow_detail: string | null;
  paused: 0 | 1;
  created_at: string;
  task_id: number | null;
  task_step: TaskStep | null;
  task_state: TaskState | null;
  attempts: number | null;
  max_attempts: number | null;
  last_error: string | null;
  run_after: string | null;
  latest_artifact_id: number | null;
  latest_artifact_status: ResumeArtifact["status"] | null;
  latest_artifact_engine: ArtifactOrigin | null;
  has_snapshot: 0 | 1;
}

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

export interface ApplicationField {
  id: number;
  job_id: number;
  field_key: string;
  label: string;
  kind: string;
  required: 0 | 1;
  options: string;
  category: FieldCategory;
  answer: string | null;
  answer_source: string | null;
  status: FieldStatus;
  note: string | null;
  readback: string | null;
  position: number;
  updated_at: string;
  max_length: number | null;
}

export type AnswerScope = "global" | "company" | "job";
