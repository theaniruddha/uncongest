import { getBudget } from "./budget";

/**
 * Shared Overpass API client (OpenStreetMap, ODbL). Server-only.
 * - budgeted (getBudget("overpass")), cached in memory by cacheKey for `ttlMs`
 * - de-duplicates concurrent identical queries
 * - tries a mirror if the primary endpoint fails
 * Callers must keep queries small (bbox/around a few route windows), never the whole journey.
 */
export const OVERPASS_ENDPOINTS = [
  process.env.OVERPASS_URL || "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter"
];
const UA = "uncongest-sim/0.2 (road-trip simulator; contact via repo)";

export interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

export interface OverpassResult {
  elements: OverpassElement[];
  provenance: "live" | "cached";
  fetchedAt: string;
}

const cache = new Map<string, { at: number; elements: OverpassElement[] }>();
const inflight = new Map<string, Promise<OverpassResult>>();

export class OverpassUnavailableError extends Error {}

export async function overpassQuery(
  query: string,
  opts: { cacheKey: string; ttlMs?: number; sessionId?: string; timeoutMs?: number; fetchImpl?: typeof fetch }
): Promise<OverpassResult> {
  const ttl = opts.ttlMs ?? 24 * 60 * 60 * 1000;
  const hit = cache.get(opts.cacheKey);
  const budget = getBudget("overpass");
  if (hit && Date.now() - hit.at < ttl) {
    budget.hit();
    return { elements: hit.elements, provenance: "cached", fetchedAt: new Date(hit.at).toISOString() };
  }
  const pending = inflight.get(opts.cacheKey);
  if (pending) return pending;

  const run = (async (): Promise<OverpassResult> => {
    const refused = budget.take(opts.sessionId);
    if (refused) throw new OverpassUnavailableError(refused);
    const f = opts.fetchImpl ?? fetch;
    let lastErr = "unknown";
    for (const url of OVERPASS_ENDPOINTS) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 25000);
      try {
        const res = await f(url, {
          method: "POST",
          headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ data: query }).toString(),
          signal: ctrl.signal
        });
        if (!res.ok) throw new Error(`overpass http ${res.status}`);
        const json = (await res.json()) as { elements?: OverpassElement[] };
        const elements = json.elements ?? [];
        const at = Date.now();
        cache.set(opts.cacheKey, { at, elements });
        console.info(`[overpass] ${opts.cacheKey}: ${elements.length} element(s)`);
        return { elements, provenance: "live", fetchedAt: new Date(at).toISOString() };
      } catch (err) {
        lastErr = (err as Error).name === "AbortError" ? "timeout" : (err as Error).message;
      } finally {
        clearTimeout(t);
      }
    }
    budget.error(lastErr);
    throw new OverpassUnavailableError(`Overpass unavailable: ${lastErr}`);
  })();
  inflight.set(opts.cacheKey, run);
  try {
    return await run;
  } finally {
    inflight.delete(opts.cacheKey);
  }
}

/** For tests. */
export function clearOverpassCache(): void {
  cache.clear();
  inflight.clear();
}
