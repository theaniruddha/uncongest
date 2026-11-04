/** Server-side helpers shared by every Muse workflow and the legacy AI adapter. */
const calls: number[] = [];

export function takeLlmRateSlot(): boolean {
  const raw = Number(process.env.LLM_MAX_CALLS_PER_10_MIN ?? 30);
  const limit = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 30;
  const now = Date.now();
  while (calls.length && now - calls[0] >= 600_000) calls.shift();
  if (calls.length >= limit) return false;
  calls.push(now);
  return true;
}

export function resetLlmRateSlots(): void {
  calls.length = 0;
}

export function museApiKey(): string | undefined {
  return [process.env.MODEL_API_KEY, process.env.MUSE_API_KEY, process.env.META_API_KEY, process.env.META_MODEL_API_KEY]
    .map((key) => key?.trim()).find(Boolean);
}

/** Provider errors may echo authorization headers, URLs or submitted content. Never relay them. */
export function safeLlmError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/^(meta|muse|mistral)(?::[^ ]+)? http \d{3}$/.test(message)) return message;
  if (/^(meta|muse) timeout after \d+ ms$/.test(message)) return message;
  if (message === "LLM rate limit reached (LLM_MAX_CALLS_PER_10_MIN)") return message;
  return "Model request or output validation failed; deterministic fallback used";
}
