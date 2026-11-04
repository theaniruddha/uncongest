import type { ZodType, ZodTypeDef } from "zod";

/**
 * Non-streaming Muse (Meta Responses API) call with native structured output
 * (`text.format = json_schema, strict`), a reasoning effort, and a HARD deadline.
 *
 * Never throws: every failure is returned as `{ ok: false, reason }` so callers can fall back
 * deterministically. Uses the same env vars as lib/providers/ai.ts and its own process-wide
 * rolling rate guard (LLM_MAX_CALLS_PER_10_MIN, default 30).
 */

export type MuseEffort = "low" | "medium" | "high";
export type MuseFailureReason = "disabled" | "timeout" | "http" | "invalid" | "rate_limited";

export interface MuseStructuredRequest<T> {
  system: string;
  user: string;
  schemaName: string;
  jsonSchema: Record<string, unknown>;
  zod: ZodType<T, ZodTypeDef, unknown>;
  effort: MuseEffort;
  deadlineMs: number;
  maxOutputTokens?: number;
}

export type MuseStructuredResult<T> =
  | { ok: true; value: T; ms: number; usage: unknown }
  | { ok: false; reason: MuseFailureReason; detail: string; ms: number };

export interface MuseCallStats {
  calls: number;
  timeouts: number;
  failures: number;
  /** Durations (ms) of the most recent completed HTTP attempts (≤ 50). */
  totalMs: number[];
}

const stats: MuseCallStats = { calls: 0, timeouts: 0, failures: 0, totalMs: [] };

export function museCallStats(): MuseCallStats {
  return { ...stats, totalMs: [...stats.totalMs] };
}

/** For tests. */
export function resetMuseStructured(): void {
  stats.calls = 0;
  stats.timeouts = 0;
  stats.failures = 0;
  stats.totalMs = [];
  callLog.length = 0;
}

const callLog: number[] = [];
function takeRateSlot(): boolean {
  const raw = process.env.LLM_MAX_CALLS_PER_10_MIN;
  const limit = raw !== undefined && raw !== "" && Number.isFinite(Number(raw)) ? Number(raw) : 30;
  const now = Date.now();
  while (callLog.length && now - callLog[0] > 10 * 60_000) callLog.shift();
  if (callLog.length >= limit) return false;
  callLog.push(now);
  return true;
}

function museConfig(): { baseUrl: string; apiKey: string; model: string } | null {
  if ((process.env.AI_PROVIDER ?? "mock").toLowerCase() !== "meta") return null;
  const apiKey = process.env.MODEL_API_KEY || process.env.MUSE_API_KEY || process.env.META_API_KEY;
  if (!apiKey) return null;
  return {
    baseUrl: (process.env.META_API_BASE || "https://api.meta.ai/v1").replace(/\/$/, ""),
    apiKey,
    model: process.env.AI_MODEL || "muse-spark-1.3"
  };
}

/** Model name used for the strategic workflow (or null when Muse is disabled). */
export function museModelName(): string | null {
  const cfg = museConfig();
  return cfg ? cfg.model : null;
}

function record(ms: number) {
  stats.totalMs.push(ms);
  if (stats.totalMs.length > 50) stats.totalMs.shift();
}

/** Pull the output text out of a non-streaming Responses API body. */
function outputText(json: any): { text: string; status: string } {
  const status = typeof json?.status === "string" ? json.status : "unknown";
  if (typeof json?.output_text === "string" && json.output_text.trim()) return { text: json.output_text, status };
  const text = (Array.isArray(json?.output) ? json.output : [])
    .filter((o: any) => o?.type === "message")
    .flatMap((o: any) => (Array.isArray(o.content) ? o.content : []))
    .filter((c: any) => c?.type === "output_text" && typeof c.text === "string")
    .map((c: any) => c.text)
    .join("");
  return { text, status };
}

export async function callMuseStructured<T>(req: MuseStructuredRequest<T>): Promise<MuseStructuredResult<T>> {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  const cfg = museConfig();
  if (!cfg) return { ok: false, reason: "disabled", detail: "AI_PROVIDER is not \"meta\" or no Muse API key is configured", ms: 0 };
  if (!takeRateSlot()) {
    stats.failures++;
    return { ok: false, reason: "rate_limited", detail: "LLM rate limit reached (LLM_MAX_CALLS_PER_10_MIN)", ms: 0 };
  }
  stats.calls++;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, req.deadlineMs));
  const payload = {
    model: cfg.model,
    input: [
      { role: "system", content: req.system },
      { role: "user", content: req.user }
    ],
    stream: false,
    max_output_tokens: req.maxOutputTokens ?? 8000,
    reasoning: { effort: req.effort },
    text: { format: { type: "json_schema", name: req.schemaName, strict: true, schema: req.jsonSchema } }
  };
  try {
    const res = await fetch(`${cfg.baseUrl}/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      stats.failures++;
      record(elapsed());
      return { ok: false, reason: res.status === 429 ? "rate_limited" : "http", detail: `muse http ${res.status}${detail ? `: ${detail}` : ""}`, ms: elapsed() };
    }
    const json = await res.json();
    const ms = elapsed();
    record(ms);
    const { text, status } = outputText(json);
    console.info(`[ai:strategic] meta:${cfg.model} effort=${req.effort} ${ms}ms status=${status} usage=${JSON.stringify(json?.usage ?? null)}`);
    if (!text.trim()) {
      stats.failures++;
      return { ok: false, reason: "invalid", detail: `muse returned no output text (status ${status})`, ms };
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, ""));
    } catch {
      stats.failures++;
      return { ok: false, reason: "invalid", detail: `muse returned non-JSON output (status ${status})`, ms };
    }
    const parsed = req.zod.safeParse(parsedJson);
    if (!parsed.success) {
      stats.failures++;
      const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")} ${i.message}`).join("; ");
      return { ok: false, reason: "invalid", detail: `schema validation failed: ${issues}`, ms };
    }
    return { ok: true, value: parsed.data, ms, usage: json?.usage ?? null };
  } catch (err) {
    const ms = elapsed();
    record(ms);
    if ((err as Error).name === "AbortError" || controller.signal.aborted) {
      stats.timeouts++;
      return { ok: false, reason: "timeout", detail: `muse timeout after ${req.deadlineMs} ms`, ms };
    }
    stats.failures++;
    return { ok: false, reason: "http", detail: `muse request failed: ${(err as Error).message}`.slice(0, 300), ms };
  } finally {
    clearTimeout(timer);
  }
}
