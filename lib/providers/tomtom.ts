import type { Need, StopCandidate } from "@/lib/domain/types";
import type { RouteModel } from "@/lib/route/model";
import { getBudget } from "./budget";
import { accessMinutesFor, anchorOnRoute, vegOptionsFromTags } from "./osmPlaces";

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
  alongCache.clear();
}

// ---------------------------------------------------------------------------------------------
// Along-route discovery fallback (opt-in, budgeted, ONE call per window)
// ---------------------------------------------------------------------------------------------

/**
 * TomTom POI category ids (Search API category set). Used only to restrict along-route results.
 * 7315 Restaurant (7315015 Fast Food is a sub-category), 9376 Café/Pub, 7395 Rest Area,
 * 7311 Petrol Station, 7309 Electric Vehicle Station, 7332 Market.
 * NOTE: not verified against a live response in this repo — confirm before relying on them.
 */
export const TOMTOM_CATEGORY = {
  restaurant: 7315,
  cafePub: 9376,
  restArea: 7395,
  petrol: 7311,
  ev: 7309,
  market: 7332
} as const;

const ALONG_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ROUTE_POINTS = 150;
const alongCache = new Map<string, { at: number; results: TomTomAlongResult[] }>();

export interface TomTomAlongResult extends TomTomResult {
  id?: string;
  /** Extra seconds the detour adds to the route (leave + rejoin). */
  detourTime?: number;
  detourDistance?: number;
  position?: { lat: number; lon: number };
  poi?: TomTomResult["poi"] & {
    categorySet?: Array<{ id: number }>;
    categories?: string[];
    classifications?: Array<{ code?: string; names?: Array<{ name?: string }> }>;
  };
}

export interface TomTomAlongRouteResult {
  status: "ok" | "skipped" | "failed";
  candidates: StopCandidate[];
  provenance?: "live" | "cached";
  reason?: string;
  trace: string[];
}

export function tomtomCategorySet(needs: Need[]): number[] {
  const n = new Set(needs.length ? needs : (["meal", "coffee", "restroom"] as Need[]));
  const ids = new Set<number>();
  if (n.has("meal")) ids.add(TOMTOM_CATEGORY.restaurant);
  if (n.has("coffee")) ids.add(TOMTOM_CATEGORY.cafePub);
  if (n.has("restroom")) ids.add(TOMTOM_CATEGORY.restArea);
  if (n.has("ev_charge")) ids.add(TOMTOM_CATEGORY.ev);
  if (n.has("grocery")) ids.add(TOMTOM_CATEGORY.market);
  return [...ids];
}

/** Query term for the {query} path segment: the most important requested need. */
function queryTerm(needs: Need[]): string {
  const order: Array<[Need, string]> = [["meal", "restaurant"], ["coffee", "coffee"], ["restroom", "rest area"], ["ev_charge", "ev charging"], ["grocery", "market"]];
  return order.find(([k]) => needs.length === 0 || needs.includes(k))?.[1] ?? "restaurant";
}

export function alongRouteCacheKey(routeId: string, w: { minKm: number; maxKm: number }, needs: Need[]): string {
  return `tomtom-along:${routeId}:${Math.round(w.minKm)}-${Math.round(w.maxKm)}:${[...new Set(needs)].sort().join(",")}`;
}

/** Map one TomTom along-route result to a StopCandidate (null = unusable/irrelevant). */
export function tomtomResultToCandidate(
  r: TomTomAlongResult,
  route: RouteModel,
  meta: { provenance: "live" | "cached"; fetchedAt: string; localDate?: string }
): StopCandidate | null {
  const name = r.poi?.name;
  if (!name || !r.position) return null;
  const ids = (r.poi?.categorySet ?? []).map((c) => String(c.id));
  const codes = (r.poi?.classifications ?? []).map((c) => (c.code ?? "").toUpperCase());
  const names = [
    ...(r.poi?.categories ?? []),
    ...(r.poi?.classifications ?? []).flatMap((c) => (c.names ?? []).map((x) => x.name ?? ""))
  ]
    .map((s) => s.toLowerCase().trim())
    .filter(Boolean);
  const has = (id: number, code: string) => ids.some((i) => i.startsWith(String(id))) || codes.includes(code);

  const cats = new Set<Need>();
  let type = "poi";
  let amenity: string | undefined;
  if (has(TOMTOM_CATEGORY.restArea, "REST_AREA")) {
    type = "rest-area";
    cats.add("restroom");
  } else if (has(TOMTOM_CATEGORY.restaurant, "RESTAURANT")) {
    const fast = ids.includes("7315015") || names.includes("fast food");
    type = fast ? "fast-food" : "restaurant";
    amenity = fast ? "fast_food" : "restaurant";
    cats.add("meal");
  } else if (has(TOMTOM_CATEGORY.cafePub, "CAFE_PUB")) {
    const pub = names.some((x) => x === "pub" || x === "bar");
    type = pub ? "pub" : "cafe";
    amenity = pub ? "pub" : "cafe";
    if (!pub) cats.add("coffee");
    else cats.add("meal");
  } else if (has(TOMTOM_CATEGORY.ev, "ELECTRIC_VEHICLE_STATION")) {
    type = "ev-charger";
    cats.add("ev_charge");
  } else if (has(TOMTOM_CATEGORY.market, "MARKET")) {
    type = "grocery";
    cats.add("grocery");
  } else if (has(TOMTOM_CATEGORY.petrol, "PETROL_STATION")) {
    type = "gas-station";
  }
  if (cats.size === 0) return null;

  const anchor = anchorOnRoute(route, r.position.lat, r.position.lon);
  const hours = hoursFromTomTom(r.poi?.openingHours, meta.localDate);
  const accessMinutes =
    typeof r.detourTime === "number" && Number.isFinite(r.detourTime)
      ? Math.max(2, Math.round((r.detourTime / 60) * 10) / 10)
      : accessMinutesFor(anchor.offRouteKm);
  const brand = r.poi?.brands?.find((b) => b.name)?.name;
  const c: StopCandidate = {
    id: `tomtom-${r.id ?? `${r.position.lat.toFixed(5)},${r.position.lon.toFixed(5)}`}`,
    name,
    type,
    categories: [...cats],
    region: "",
    ...anchor,
    lat: r.position.lat,
    lng: r.position.lon,
    isMock: false,
    source: "tomtom",
    provenance: meta.provenance,
    fetchedAt: meta.fetchedAt,
    brand: brand ?? name,
    hoursVerified: hours !== null,
    vegetarianVerified: null,
    restroomsVerified: null, // TomTom doesn't tell us
    parkingVerified: null,
    qualityScoreMock: type === "gas-station" ? 0.55 : 0.6,
    open24h: hours?.open24h ?? false,
    accessMinutes
  };
  if (hours?.opensLocal) c.opensLocal = hours.opensLocal;
  if (hours?.closesLocal) c.closesLocal = hours.closesLocal;
  if (cats.has("meal") && amenity) {
    const veg = vegOptionsFromTags({ amenity, cuisine: names.map((x) => x.replace(/[\s-]+/g, "_")).join(";") });
    if (veg) {
      c.vegOptions = veg.level;
      c.vegOptionsNote = veg.note.replace("OSM cuisine", "TomTom category");
    }
  }
  return c;
}

/**
 * Discovery fallback for ONE km window via TomTom "Along Route Search".
 * Off by default (budget disabled unless TOMTOM_LIVE=1 + key) → status "skipped", no network.
 * Cached 24 h by route id + rounded window + needs; a cache hit spends no budget.
 */
export async function searchAlongRouteTomTom(
  route: RouteModel,
  window: { minKm: number; maxKm: number },
  needs: Need[],
  opts: { sessionId?: string; fetchImpl?: typeof fetch; localDate?: string } = {}
): Promise<TomTomAlongRouteResult> {
  const minKm = route.clampKm(Math.min(window.minKm, window.maxKm));
  const maxKm = route.clampKm(Math.max(window.minKm, window.maxKm));
  const label = `tomtom along-route km ${minKm.toFixed(0)}–${maxKm.toFixed(0)}`;
  const budget = getBudget("tomtom");
  const key = alongRouteCacheKey(route.id, { minKm, maxKm }, needs);
  const toCandidates = (results: TomTomAlongResult[], provenance: "live" | "cached", at: number) => {
    const fetchedAt = new Date(at).toISOString();
    const seen = new Set<string>();
    const wanted = needs.length ? needs : (["meal", "coffee", "restroom"] as Need[]);
    return results
      .map((r) => tomtomResultToCandidate(r, route, { provenance, fetchedAt, localDate: opts.localDate }))
      .filter((c): c is StopCandidate => c !== null && c.categories.some((n) => wanted.includes(n)))
      .filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
  };

  const hit = alongCache.get(key);
  if (hit && Date.now() - hit.at < ALONG_TTL_MS) {
    budget.hit();
    const candidates = toCandidates(hit.results, "cached", hit.at);
    return { status: "ok", candidates, provenance: "cached", trace: [`${label}: ${candidates.length} place(s) (cached)`] };
  }
  if (!(maxKm > minKm)) return { status: "skipped", candidates: [], reason: "empty window", trace: [`${label}: skipped — empty window`] };
  const refused = budget.take(opts.sessionId);
  if (refused) return { status: "skipped", candidates: [], reason: refused, trace: [`${label}: skipped — ${refused}`] };
  const apiKey = process.env.TOMTOM_API_KEY;
  if (!apiKey) return { status: "skipped", candidates: [], reason: "tomtom key missing", trace: [`${label}: skipped — key missing`] };

  const step = Math.max(2, (maxKm - minKm) / (MAX_ROUTE_POINTS - 1));
  const points = route
    .sample(minKm, maxKm, step)
    .slice(0, MAX_ROUTE_POINTS)
    .map((p) => ({ lat: Math.round(p.lat * 1e5) / 1e5, lon: Math.round(p.lng * 1e5) / 1e5 }));
  const cats = tomtomCategorySet(needs);
  const url =
    `https://api.tomtom.com/search/2/searchAlongRoute/${encodeURIComponent(queryTerm(needs))}.json` +
    `?key=${encodeURIComponent(apiKey)}&maxDetourTime=600&limit=20${cats.length ? `&categorySet=${cats.join(",")}` : ""}&openingHours=nextSevenDays`;
  const f = opts.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  let results: TomTomAlongResult[];
  try {
    const res = await f(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ route: { points } }),
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error(`tomtom http ${res.status}`);
    results = (((await res.json()) as { results?: TomTomAlongResult[] }).results ?? []);
  } catch (err) {
    const msg = (err as Error).name === "AbortError" ? "timeout" : (err as Error).message.replace(/key=[^&\s]+/g, "key=***");
    budget.error(msg);
    return { status: "failed", candidates: [], reason: msg, trace: [`${label}: failed — ${msg}`] };
  } finally {
    clearTimeout(timer);
  }
  const at = Date.now();
  alongCache.set(key, { at, results });
  const candidates = toCandidates(results, "live", at);
  return {
    status: "ok",
    candidates,
    provenance: "live",
    trace: [`${label}: ${points.length} route point(s), ${results.length} result(s), ${candidates.length} place(s) (live)`]
  };
}

/** For tests. */
export function clearTomTomAlongCache(): void {
  alongCache.clear();
}
