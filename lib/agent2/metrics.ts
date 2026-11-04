/** Pure latency/outcome metrics for the Agent 2 workflows (shown in the inspector's Performance tab). */
export interface WorkflowSample {
  ms: number;
  status: string;
  at: number;
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export interface WorkflowSummary {
  count: number;
  p50: number | null;
  p95: number | null;
  withinTargetPct: number | null;
  fallbackPct: number | null;
  timeoutPct: number | null;
}

export function summarize(samples: WorkflowSample[], targetMs: number): WorkflowSummary {
  const ms = samples.map((s) => s.ms);
  const n = samples.length;
  const pct = (k: number) => (n ? Math.round((k / n) * 100) : null);
  return {
    count: n,
    p50: percentile(ms, 50),
    p95: percentile(ms, 95),
    withinTargetPct: pct(samples.filter((s) => s.ms <= targetMs).length),
    fallbackPct: pct(samples.filter((s) => s.status !== "muse" && s.status !== "completed" && s.status !== "cached").length),
    timeoutPct: pct(samples.filter((s) => s.status === "timeout").length)
  };
}

/** Short stable hash for context/route versions (FNV-1a, base36). */
export function versionHash(input: unknown): string {
  const s = typeof input === "string" ? input : JSON.stringify(input);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}
