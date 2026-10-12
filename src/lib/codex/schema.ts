/**
 * The application-owned contract for a Resume Builder run's final message.
 * Passed to `codex exec --output-schema`; every property is required and
 * nullable ones say so explicitly, as structured outputs expect. The same
 * schema validates the result file locally — the CLI enforcing it is not
 * something we take on trust.
 */

export const BLOCKER_CODES = [
  "plugin_unavailable", "resources_unavailable", "description_incomplete", "fact_conflict",
  "compiler_unavailable", "other",
] as const;

export const RESUME_RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "status", "pdf_path", "tex_path", "validation_report_path", "validation_summary", "plugin",
    "resources_loaded", "revision_count", "unresolved_failures", "coverage_gaps", "blockers",
  ],
  properties: {
    status: { type: "string", enum: ["completed", "needs_input", "failed"] },
    pdf_path: { type: ["string", "null"] },
    tex_path: { type: ["string", "null"] },
    validation_report_path: { type: ["string", "null"] },
    validation_summary: { type: "string" },
    plugin: {
      type: "object",
      additionalProperties: false,
      required: ["skill_name", "version", "skill_file"],
      properties: {
        skill_name: { type: "string" },
        version: { type: ["string", "null"] },
        skill_file: { type: ["string", "null"] },
      },
    },
    resources_loaded: { type: "array", items: { type: "string" } },
    revision_count: { type: "integer" },
    unresolved_failures: { type: "array", items: { type: "string" } },
    coverage_gaps: { type: "array", items: { type: "string" } },
    blockers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["code", "message"],
        properties: {
          code: { type: "string", enum: [...BLOCKER_CODES] },
          message: { type: "string" },
        },
      },
    },
  },
} as const;

export interface ResumeRunResultJson {
  status: "completed" | "needs_input" | "failed";
  pdf_path: string | null;
  tex_path: string | null;
  validation_report_path: string | null;
  validation_summary: string;
  plugin: { skill_name: string; version: string | null; skill_file: string | null };
  resources_loaded: string[];
  revision_count: number;
  /** Plugin rules the resume still breaks (page length, wrapping…). These fail verification. */
  unresolved_failures: string[];
  /** Job requirements the content bank can't truthfully support. Informational, never "fixed". */
  coverage_gaps: string[];
  blockers: { code: (typeof BLOCKER_CODES)[number]; message: string }[];
}

// ---------- minimal JSON Schema validator ----------
// Covers exactly the keywords our schemas use: type (incl. unions), enum,
// required, properties, additionalProperties:false, items.

type Schema = {
  type?: string | readonly string[];
  enum?: readonly unknown[];
  required?: readonly string[];
  properties?: Record<string, Schema>;
  additionalProperties?: boolean;
  items?: Schema;
};

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

export function validateSchema(schema: Schema, value: unknown, at = "$"): string[] {
  const errors: string[] = [];
  if (schema.type) {
    const allowed = typeof schema.type === "string" ? [schema.type] : schema.type;
    const actual = typeOf(value);
    const ok = allowed.includes(actual) || (actual === "integer" && allowed.includes("number"));
    if (!ok) return [`${at}: expected ${allowed.join(" or ")}, got ${actual}`];
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${at}: not one of ${schema.enum.join(", ")}`);
  if (typeOf(value) === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in obj)) errors.push(`${at}.${key}: required`);
    for (const [key, v] of Object.entries(obj)) {
      const sub = schema.properties?.[key];
      if (sub) errors.push(...validateSchema(sub, v, `${at}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${at}.${key}: unexpected property`);
    }
  }
  if (typeOf(value) === "array" && schema.items) {
    (value as unknown[]).forEach((item, i) => errors.push(...validateSchema(schema.items!, item, `${at}[${i}]`)));
  }
  return errors;
}

/** Parses and validates a result file's text. Returns the object or the reasons it was rejected. */
export function parseResumeResult(text: string): { ok: true; value: ResumeRunResultJson } | { ok: false; errors: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, errors: ["Result is not valid JSON"] };
  }
  const errors = validateSchema(RESUME_RESULT_SCHEMA as unknown as Schema, parsed);
  return errors.length ? { ok: false, errors } : { ok: true, value: parsed as ResumeRunResultJson };
}
