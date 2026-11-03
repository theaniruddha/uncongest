import { getBudget } from "./budget";

/**
 * Nominatim (OpenStreetMap) geocoding client. Server-only.
 * Usage policy: <= 1 request/second process-wide (serialized queue), descriptive User-Agent,
 * results cached in memory for 24 h, budgeted via getBudget("nominatim").
 */
const BASE = process.env.NOMINATIM_URL || "https://nominatim.openstreetmap.org";
const UA = "uncongest-sim/0.2 (road-trip simulator)";
const TTL_MS = 24 * 60 * 60 * 1000;
const MIN_INTERVAL_MS = 1000;
const TIMEOUT_MS = 10000;

export interface PlaceSuggestion {
  label: string;
  lat: number;
  lng: number;
  kind: string;
}

export class GeocodeUnavailableError extends Error {}

const searchCache = new Map<string, { at: number; results: PlaceSuggestion[] }>();
const reverseCache = new Map<string, { at: number; result: { label: string } }>();

// Process-wide throttle: every Nominatim request is chained onto this promise.
let queue: Promise<void> = Promise.resolve();
let lastRequestAt = 0;

function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();
    return fn();
  });
  // Keep the chain alive regardless of individual failures.
  queue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function nominatimGet(url: string, fetchImpl?: typeof fetch): Promise<unknown> {
  const f = fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await f(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: ctrl.signal });
    if (!res.ok) throw new GeocodeUnavailableError(`nominatim http ${res.status}`);
    return await res.json();
  } catch (err) {
    if (err instanceof GeocodeUnavailableError) throw err;
    const msg = (err as Error).name === "AbortError" ? "timeout" : (err as Error).message;
    throw new GeocodeUnavailableError(`Nominatim unavailable: ${msg}`);
  } finally {
    clearTimeout(t);
  }
}

const normalize = (q: string) => q.trim().toLowerCase().replace(/\s+/g, " ");

export async function searchPlaces(
  q: string,
  opts: { limit?: number; countryCodes?: string[]; sessionId?: string; fetchImpl?: typeof fetch } = {}
): Promise<PlaceSuggestion[]> {
  const query = normalize(q);
  if (query.length < 3) return [];
  const limit = Math.min(Math.max(Math.round(opts.limit ?? 6), 1), 20);
  const cc = (opts.countryCodes ?? ["ca", "us"]).map((c) => c.toLowerCase()).join(",");
  const key = `${query}|${limit}|${cc}`;
  const budget = getBudget("nominatim");
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) {
    budget.hit();
    return hit.results;
  }
  const refused = budget.take(opts.sessionId);
  if (refused) throw new GeocodeUnavailableError(refused);

  const params = new URLSearchParams({ format: "jsonv2", q: q.trim(), limit: String(limit), addressdetails: "0" });
  if (cc) params.set("countrycodes", cc);
  try {
    const json = await throttled(() => nominatimGet(`${BASE}/search?${params.toString()}`, opts.fetchImpl));
    const rows = Array.isArray(json) ? (json as Array<Record<string, unknown>>) : [];
    const results: PlaceSuggestion[] = rows
      .map((r) => ({
        label: String(r.display_name ?? r.name ?? ""),
        lat: Number(r.lat),
        lng: Number(r.lon),
        kind: String(r.type ?? r.addresstype ?? r.category ?? "place")
      }))
      .filter((r) => r.label && Number.isFinite(r.lat) && Number.isFinite(r.lng));
    searchCache.set(key, { at: Date.now(), results });
    return results;
  } catch (err) {
    budget.error((err as Error).message);
    throw err;
  }
}

export async function reverseGeocode(
  lat: number,
  lng: number,
  opts: { sessionId?: string; fetchImpl?: typeof fetch } = {}
): Promise<{ label: string }> {
  const key = `${lat.toFixed(3)},${lng.toFixed(3)}`;
  const budget = getBudget("nominatim");
  const hit = reverseCache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) {
    budget.hit();
    return hit.result;
  }
  const refused = budget.take(opts.sessionId);
  if (refused) throw new GeocodeUnavailableError(refused);
  const params = new URLSearchParams({ format: "jsonv2", lat: lat.toFixed(5), lon: lng.toFixed(5), zoom: "14", addressdetails: "0" });
  try {
    const json = (await throttled(() => nominatimGet(`${BASE}/reverse?${params.toString()}`, opts.fetchImpl))) as Record<string, unknown> | null;
    const label = json && typeof json.display_name === "string" ? json.display_name : `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    const result = { label };
    reverseCache.set(key, { at: Date.now(), result });
    return result;
  } catch (err) {
    budget.error((err as Error).message);
    throw err;
  }
}

/** For tests. */
export function clearGeocodeCache(): void {
  searchCache.clear();
  reverseCache.clear();
}
