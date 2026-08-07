/**
 * Client for the patched CatGPT-Gateway, which drives a real ChatGPT session in
 * a browser and exposes an OpenAI-compatible endpoint. Our patch adds two things
 * the upstream project lacks: navigating to a Custom GPT (`custom_gpt_url`) and
 * returning files the GPT generated (`files`). See `gateway-patch/README.md`.
 */

const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://localhost:8000";
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN ?? "";
const CUSTOM_GPT_URL = process.env.CUSTOM_GPT_URL ?? "";

/**
 * A browser round-trip through ChatGPT takes far longer than a normal API call:
 * page load, human-paced typing, the model thinking, then the PDF being built in
 * the sandbox. Well above parser.ts's 20s.
 */
const TIMEOUT_MS = 300_000;

export interface GeneratedFile {
  filename: string;
  mime_type: string;
  /** Base64 file contents, as returned by the patched gateway. */
  b64: string;
}

export interface GeneratedResume {
  /** The assistant's chat text. Saved as a .md fallback when no file comes back. */
  text: string;
  /** Null when the GPT replied with text only — the caller falls back to .md. */
  file: GeneratedFile | null;
  /** The ChatGPT conversation, so a revision can continue it. */
  threadId: string | null;
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string | null } }[];
  files?: GeneratedFile[];
  thread_id?: string | null;
  error?: { message?: string } | string;
}

/** True when the gateway is reachable — used to give a clearer error up front. */
export async function gatewayHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`${GATEWAY_URL}/healthz`, { signal: AbortSignal.timeout(3_000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Sends a job description to the Custom GPT and returns its resume.
 * Throws with a human-readable message; callers surface it as a 422.
 */
export async function generateResume(
  jobDescription: string,
  /** Continue an existing conversation — used for revisions. */
  threadId?: string | null
): Promise<GeneratedResume> {
  if (!CUSTOM_GPT_URL) {
    throw new Error("CUSTOM_GPT_URL is not set — add it to .env.local (see gateway-patch/README.md)");
  }

  let res: Response;
  try {
    res = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(GATEWAY_TOKEN ? { Authorization: `Bearer ${GATEWAY_TOKEN}` } : {}),
      },
      body: JSON.stringify({
        model: "catgpt-browser",
        stream: false,
        custom_gpt_url: CUSTOM_GPT_URL,
        ...(threadId ? { thread_id: threadId } : {}),
        messages: [{ role: "user", content: jobDescription }],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // A refused connection is by far the most common failure: gateway not running.
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Error(`Gateway timed out after ${TIMEOUT_MS / 1000}s — check the browser window for a stuck prompt`);
    }
    throw new Error(`Can't reach the gateway at ${GATEWAY_URL} — is it running? (npm run start:all)`);
  }

  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    // FastAPI reports errors as {"detail": "..."} — surface that, not the JSON.
    let detail = raw;
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed?.detail === "string") detail = parsed.detail;
    } catch {
      // Not JSON; the raw body is the best message available.
    }
    throw new Error(detail ? detail.slice(0, 300) : `Gateway returned HTTP ${res.status}`);
  }

  const body = (await res.json()) as ChatCompletionResponse;
  if (body.error) {
    const message = typeof body.error === "string" ? body.error : body.error.message;
    throw new Error(message ?? "Gateway reported an error");
  }

  const text = body.choices?.[0]?.message?.content ?? "";
  const file = body.files?.find((f) => f.b64) ?? null;
  if (!text && !file) throw new Error("Gateway returned an empty response");

  return { text, file, threadId: body.thread_id ?? null };
}
