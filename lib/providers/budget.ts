import type { ProviderUsage } from "@/lib/trip/types";

/**
 * Server-side request budgets for external APIs (cost guard).
 * - rolling window limit for the whole process
 * - per-session limit (session id supplied by the client, e.g. a random tab id)
 * - cache-hit counter for the inspector
 * In-memory: resets on server restart / cold start, which errs on the side of fewer calls overall
 * only per instance — keep limits conservative for public hosting.
 */
export interface BudgetOptions {
  provider: string;
  enabled: boolean;
  windowLimit: number;
  windowMs: number;
  sessionLimit: number;
}

export class RequestBudget {
  private calls: number[] = [];
  private sessions = new Map<string, number>();
  private cacheHits = 0;
  private lastError?: string;
  constructor(private opts: BudgetOptions) {}

  get enabled(): boolean {
    return this.opts.enabled;
  }

  /** Try to spend one request. Returns null when allowed, or a reason string when refused. */
  take(sessionId = "anon"): string | null {
    if (!this.opts.enabled) return `${this.opts.provider} live lookups are disabled`;
    const now = Date.now();
    while (this.calls.length && now - this.calls[0] > this.opts.windowMs) this.calls.shift();
    if (this.calls.length >= this.opts.windowLimit) return `${this.opts.provider} budget exhausted (${this.opts.windowLimit} per ${Math.round(this.opts.windowMs / 60000)} min)`;
    const used = this.sessions.get(sessionId) ?? 0;
    if (used >= this.opts.sessionLimit) return `${this.opts.provider} session budget exhausted (${this.opts.sessionLimit} per session)`;
    this.calls.push(now);
    this.sessions.set(sessionId, used + 1);
    return null;
  }

  hit(): void {
    this.cacheHits += 1;
  }

  error(message: string): void {
    this.lastError = message;
  }

  usage(sessionId = "anon"): ProviderUsage {
    const now = Date.now();
    return {
      provider: this.opts.provider,
      enabled: this.opts.enabled,
      usedInWindow: this.calls.filter((t) => now - t <= this.opts.windowMs).length,
      windowLimit: this.opts.windowLimit,
      usedThisSession: this.sessions.get(sessionId) ?? 0,
      sessionLimit: this.opts.sessionLimit,
      cacheHits: this.cacheHits,
      lastError: this.lastError
    };
  }
}

const n = (v: string | undefined, d: number) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);

const registry = new Map<string, RequestBudget>();

/** Process-wide budget per provider, configured from env on first use. */
export function getBudget(provider: "tomtom" | "overpass" | "osrm" | "nominatim" | "open-meteo"): RequestBudget {
  let b = registry.get(provider);
  if (b) return b;
  const P = provider.toUpperCase().replace(/-/g, "_");
  const defaults: Record<string, { enabled: boolean; window: number; session: number }> = {
    // TomTom is OFF unless explicitly enabled (TOMTOM_LIVE=1) and a key exists.
    tomtom: { enabled: process.env.TOMTOM_LIVE === "1" && Boolean(process.env.TOMTOM_API_KEY), window: 20, session: 10 },
    overpass: { enabled: process.env.OVERPASS_LIVE !== "0", window: 40, session: 25 },
    osrm: { enabled: process.env.OSRM_LIVE !== "0", window: 30, session: 15 },
    nominatim: { enabled: process.env.NOMINATIM_LIVE !== "0", window: 60, session: 40 },
    "open-meteo": { enabled: true, window: 200, session: 120 }
  };
  const d = defaults[provider];
  b = new RequestBudget({
    provider,
    enabled: d.enabled,
    windowLimit: n(process.env[`${P}_WINDOW_LIMIT`], d.window),
    windowMs: n(process.env[`${P}_WINDOW_MS`], 60 * 60 * 1000),
    sessionLimit: n(process.env[`${P}_SESSION_LIMIT`], d.session)
  });
  registry.set(provider, b);
  return b;
}

/** For tests. */
export function resetBudgets(): void {
  registry.clear();
}

export function allUsage(sessionId?: string): ProviderUsage[] {
  return [...registry.values()].map((b) => b.usage(sessionId));
}
