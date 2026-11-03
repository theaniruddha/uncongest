import type { StopCandidate } from "@/lib/domain/types";
import { getBudget } from "./budget";

/**
 * Optional, budgeted TomTom Search verifier for an OSM candidate. Server-only.
 * - OFF unless TOMTOM_LIVE=1 and TOMTOM_API_KEY are set (see budget.ts).
 * - Cached 24 h per osmId (or name+coords); a cache hit never spends budget.
 * - Patches ONLY what TomTom returned (today's opening hours, brand). The key is never logged.
 */

export type TomTomStatus = "verified" | "not_found" | "skipped";
export interface TomTomVerification {
  status: TomTomStatus;
  reason?: string;
  patch?: Partial<StopCandidate>;
  /** Name TomTom matched (for the caller's trace). */
  matchedName?: string;
  cached?: boolean;
}

const TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map<string, { at: number; result: TomTomVerification }>();

interface TomTomTime {
  date: string;
  hour: number;
  minute: number;
}
interface TomTomResult {
  dist?: number;
  poi?: {
    name?: string;
    brands?: Array<{ name?: string }>;
    openingHours?: { mode?: string; timeRanges?: Array<{ startTime: TomTomTime; endTime: TomTomTime }> };
  };
}

const hhmm = (t: TomTomTime) => `${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}`;

/**
 * Extract today's hours from TomTom openingHours (nextSevenDays, POI-local time).
 * "Today" = the date of the first range unless `localDate` (YYYY-MM-DD) is supplied.
 * Returns null when no usable range exists for that day.
 */
export function hoursFromTomTom(
  oh: NonNullable<TomTomResult["poi"]>["openingHours"],
  localDate?: string
): Pick<StopCandidate, "open24h" | "opensLocal" | "closesLocal" | "hoursVerified"> | null {
  const ranges = oh?.timeRanges ?? [];
  if (ranges.length === 0) return null;
  const today = localDate ?? ranges[0].startTime.date;
  const r = ranges.find((x) => x.startTime.date === today);
  if (!r) return null;
  const startMin = r.startTime.hour * 60 + r.startTime.minute;
  const sameDay = r.endTime.date === r.startTime.date;
  if (startMin === 0 && !sameDay) return { open24h: true, hoursVerified: true, opensLocal: undefined, closesLocal: undefined };
  if (!sameDay) return null; // past-midnight closing: the engine's same-day check can't express it
  return { open24h: false, opensLocal: hhmm(r.startTime), closesLocal: hhmm(r.endTime), hoursVerified: true };
}

export function tomtomCacheKey(c: StopCandidate): string {
  return c.osmId ? `osm:${c.osmId}` : `name:${c.name.toLowerCase()}@${c.lat.toFixed(4)},${c.lng.toFixed(4)}`;
}

export async function verifyWithTomTom(
  candidate: StopCandidate,
  opts: { sessionId?: string; fetchImpl?: typeof fetch; localDate?: string } = {}
): Promise<TomTomVerification> {
  const budget = getBudget("tomtom");
  const key = tomtomCacheKey(candidate);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) {
    budget.hit();
    return { ...hit.result, cached: true };
  }
  const refused = budget.take(opts.sessionId);
  if (refused) return { status: "skipped", reason: refused };
  const apiKey = process.env.TOMTOM_API_KEY;
  if (!apiKey) return { status: "skipped", reason: "tomtom key missing" };

  const url =
    `https://api.tomtom.com/search/2/search/${encodeURIComponent(candidate.name)}.json` +
    `?lat=${candidate.lat}&lon=${candidate.lng}&radius=300&limit=1&openingHours=nextSevenDays&key=${encodeURIComponent(apiKey)}`;
  const f = opts.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  let json: { results?: TomTomResult[] };
  try {
    const res = await f(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`tomtom http ${res.status}`);
    json = (await res.json()) as { results?: TomTomResult[] };
  } catch (err) {
    // never surface the URL (contains the key)
    const msg = (err as Error).name === "AbortError" ? "timeout" : (err as Error).message.replace(/key=[^&\s]+/g, "key=***");
    budget.error(msg);
    return { status: "skipped", reason: `tomtom error: ${msg}` };
  } finally {
    clearTimeout(timer);
  }

  const top = json.results?.[0];
  let result: TomTomVerification;
  if (!top || !top.poi) {
    result = { status: "not_found", reason: "no TomTom POI within 300 m" };
  } else {
    const patch: Partial<StopCandidate> = {};
    const brand = top.poi.brands?.find((b) => b.name)?.name;
    if (brand) patch.brand = brand;
    const hours = hoursFromTomTom(top.poi.openingHours, opts.localDate);
    if (hours) Object.assign(patch, hours);
    result = { status: "verified", patch, matchedName: top.poi.name };
  }
  cache.set(key, { at: Date.now(), result });
  return result;
}

/** For tests. */
export function clearTomTomCache(): void {
  cache.clear();
}
