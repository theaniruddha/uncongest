import type { Need, StopCandidate } from "@/lib/domain/types";
import type { RouteModel } from "@/lib/route/model";
import type { ProviderUsage } from "@/lib/trip/types";
import { getBudget } from "./budget";
import { discoverOsmPlaces } from "./osmPlaces";
import type { PlaceProvider } from "./places";
import { searchAlongRouteTomTom, verifyWithTomTom } from "./tomtom";

/**
 * Real-place provider for any RouteModel: OSM places discovered per requested km window
 * (see osmPlaces.ts), optionally verified with TomTom for the top-N of each window.
 * When EVERY OSM tile of a window failed (not merely "0 places"), it tries ONE opt-in TomTom
 * along-route search for the window (skipped unless TOMTOM_LIVE=1 + key). If that is also
 * unavailable it returns [] and records why in `trace` — it never fabricates places;
 * the caller decides whether to fall back to fixtures.
 */
export class RoutePlaceProvider implements PlaceProvider {
  isMock = false;
  readonly trace: string[] = [];
  private tomtomUsed = false;
  private readonly sessionId?: string;
  private readonly tomtomVerifyTop: number;
  private readonly fetchImpl?: typeof fetch;
  /** Fast path: only use cached tiles (no live Overpass, no TomTom fallback/verification). */
  private readonly cacheOnly: boolean;

  constructor(
    private readonly route: RouteModel,
    opts: { sessionId?: string; tomtomVerifyTop?: number; fetchImpl?: typeof fetch; cacheOnly?: boolean } = {}
  ) {
    this.cacheOnly = opts.cacheOnly === true;
    this.sessionId = opts.sessionId;
    this.tomtomVerifyTop = Math.max(0, opts.tomtomVerifyTop ?? 0);
    this.fetchImpl = opts.fetchImpl;
  }

  get name(): string {
    return this.tomtomUsed ? "osm-places+tomtom" : "osm-places";
  }

  /** Budget usage for the inspector. */
  get usage(): ProviderUsage[] {
    return [getBudget("overpass").usage(this.sessionId), getBudget("tomtom").usage(this.sessionId)];
  }

  async getCandidates(pass: "initial" | "nextExits", opts: { minKm: number; maxKm: number; needs: Need[] }): Promise<StopCandidate[]> {
    const label = `[${pass}] km ${opts.minKm.toFixed(0)}–${opts.maxKm.toFixed(0)}`;
    if (!(opts.maxKm > opts.minKm)) {
      this.trace.push(`${label}: empty window, no query`);
      return [];
    }
    let candidates: StopCandidate[];
    let failedTiles = 0;
    const tiles = tilesFor(this.route, opts);
    const broad = broadNeeds(opts.needs);
    const results = await mapLimit(tiles, 2, async (t) => {
      try {
        const res = await discoverOsmPlaces(this.route, t, broad, { sessionId: this.sessionId, fetchImpl: this.fetchImpl, cacheOnly: this.cacheOnly });
        this.trace.push(`${label} tile km ${t.minKm.toFixed(0)}–${t.maxKm.toFixed(0)}: ${res.candidates.length} place(s), ${res.provenance}`);
        return res.candidates;
      } catch (err) {
        if (this.cacheOnly) {
          // a cache miss in the fast path is not an OSM failure → no TomTom fallback
          this.trace.push(`${label} tile km ${t.minKm.toFixed(0)}–${t.maxKm.toFixed(0)}: not cached (skipped in fast path)`);
          return [] as StopCandidate[];
        }
        failedTiles++;
        this.trace.push(`${label} tile km ${t.minKm.toFixed(0)}–${t.maxKm.toFixed(0)}: OSM lookup failed — ${(err as Error).message}`);
        return [] as StopCandidate[];
      }
    });
    const wanted = opts.needs.length ? opts.needs : broad;
    let pool = results.flat();
    if (!this.cacheOnly && tiles.length > 0 && failedTiles === tiles.length) {
      const tt = await searchAlongRouteTomTom(this.route, { minKm: opts.minKm, maxKm: opts.maxKm }, wanted, {
        sessionId: this.sessionId,
        fetchImpl: this.fetchImpl
      });
      this.trace.push(...tt.trace.map((t) => `${label} ${t}`));
      this.trace.push(`${label} ${alongRouteTraceLine(tt)}`);
      if (tt.status === "ok") {
        this.tomtomUsed = true;
        pool = tt.candidates;
      }
    }
    const seen = new Set<string>();
    candidates = pool
      .filter((c) => {
        const key = c.osmId ?? c.id;
        if (seen.has(key)) return false;
        seen.add(key);
        return c.distanceAlongRouteKm >= opts.minKm - 3 && c.distanceAlongRouteKm <= opts.maxKm + 3 && c.categories.some((k) => wanted.includes(k));
      })
      .slice(0, MAX_PER_DECISION);
    if (candidates.length === 0) this.trace.push(`${label}: no real places found for [${wanted.join(", ")}] in this window`);

    if (!this.cacheOnly && this.tomtomVerifyTop > 0 && candidates.length > 0) {
      const n = Math.min(this.tomtomVerifyTop, candidates.length);
      for (let i = 0; i < n; i++) {
        const c = candidates[i];
        const v = await verifyWithTomTom(c, { sessionId: this.sessionId, fetchImpl: this.fetchImpl });
        if (v.status === "verified") {
          this.tomtomUsed = true;
          candidates[i] = { ...c, ...v.patch };
          const fields = Object.keys(v.patch ?? {});
          this.trace.push(`${label} tomtom: verified "${c.name}"${v.matchedName ? ` as "${v.matchedName}"` : ""}${v.cached ? " (cached)" : ""}${fields.length ? `; updated ${fields.join(", ")}` : ""}`);
        } else {
          this.trace.push(`${label} tomtom: ${v.status} "${c.name}"${v.reason ? ` — ${v.reason}` : ""}`);
          if (v.status === "skipped") break; // budget refused/disabled: don't keep trying
        }
      }
    }
    return candidates;
  }
}

/** Fixed road tiles so discovery results are cacheable across decisions and needs. */
export const TILE_KM = 30;
const MAX_PER_DECISION = 30;
const BROAD = ["meal", "coffee", "restroom", "grocery"] as Need[];

function broadNeeds(needs: Need[]): Need[] {
  return needs.includes("ev_charge") ? [...BROAD, "ev_charge"] : BROAD;
}

export function tilesFor(route: RouteModel, w: { minKm: number; maxKm: number }): KmWindow[] {
  const out: KmWindow[] = [];
  const first = Math.floor(Math.max(0, w.minKm) / TILE_KM);
  const last = Math.floor(Math.min(route.totalKm, w.maxKm) / TILE_KM);
  for (let i = first; i <= last && out.length < 6; i++) {
    out.push({ minKm: i * TILE_KM, maxKm: Math.min((i + 1) * TILE_KM, route.totalKm) });
  }
  return out;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Warm the tile cache for likely stop windows (called right after a route is planned). */
export async function prefetchWindows(
  route: RouteModel,
  windows: KmWindow[],
  opts: { sessionId?: string; fetchImpl?: typeof fetch; cacheOnly?: boolean } = {}
): Promise<{ trace: string[]; candidates: StopCandidate[] }> {
  const tiles = new Map<string, KmWindow>();
  for (const w of windows) for (const t of tilesFor(route, w)) tiles.set(`${t.minKm}`, t);
  const trace: string[] = [];
  const found: StopCandidate[] = [];
  const attempted = new Set<string>();
  const failed = new Set<string>();
  await mapLimit([...tiles.values()].slice(0, 6), 2, async (t) => {
    attempted.add(`${t.minKm}`);
    try {
      const r = await discoverOsmPlaces(route, t, BROAD, opts);
      found.push(...r.candidates);
      trace.push(`prefetch km ${t.minKm}–${t.maxKm.toFixed(0)}: ${r.candidates.length} place(s), ${r.provenance}`);
    } catch (err) {
      failed.add(`${t.minKm}`);
      trace.push(`prefetch km ${t.minKm}–${t.maxKm.toFixed(0)}: failed — ${(err as Error).message}`);
    }
  });
  // Per window: if every attempted tile failed, try ONE opt-in TomTom along-route search.
  for (const w of windows) {
    const keys = tilesFor(route, w).map((t) => `${t.minKm}`).filter((k) => attempted.has(k));
    if (opts.cacheOnly || keys.length === 0 || !keys.every((k) => failed.has(k))) continue;
    const tt = await searchAlongRouteTomTom(route, w, BROAD, opts);
    const label = `prefetch window km ${w.minKm.toFixed(0)}–${w.maxKm.toFixed(0)}`;
    trace.push(...tt.trace.map((t) => `${label} ${t}`), `${label} ${alongRouteTraceLine(tt)}`);
    if (tt.status === "ok") found.push(...tt.candidates);
  }
  const seen = new Set<string>();
  const candidates = found
    .filter((c) => (seen.has(c.osmId ?? c.id) ? false : (seen.add(c.osmId ?? c.id), true)))
    .sort((a, b) => a.distanceAlongRouteKm - b.distanceAlongRouteKm);
  return { trace, candidates };
}

function alongRouteTraceLine(tt: { status: string; candidates: StopCandidate[]; reason?: string }): string {
  if (tt.status === "ok") return `tomtom along-route fallback: ${tt.candidates.length} place(s)`;
  const r = tt.reason ?? "";
  return `tomtom along-route fallback ${tt.status}: ${/disabled/.test(r) ? "disabled" : r}`;
}

export interface KmWindow {
  minKm: number;
  maxKm: number;
}

/**
 * Km windows to search for a decision, at most 2:
 * - start = lead + the distance covered during the advance-notice period (can't stop sooner)
 * - end   = lead + horizonKm, clamped to the route end
 * - if the horizon exceeds 80 km the span is split in two equal halves, so a caller can query
 *   the near window first and only fetch the far one when the near window has nothing.
 * Returns [] when nothing is left ahead.
 */
export function windowsForDecision(
  leadKm: number,
  speedKph: number,
  horizonKm: number,
  routeTotalKm: number,
  noticeMinutes = 10
): KmWindow[] {
  const noticeKm = (Math.max(speedKph, 0) * noticeMinutes) / 60;
  const start = Math.min(leadKm + noticeKm, routeTotalKm);
  const end = Math.min(leadKm + horizonKm, routeTotalKm);
  if (!(end > start)) return [];
  if (horizonKm <= 80) return [{ minKm: start, maxKm: end }];
  const mid = start + (end - start) / 2;
  return [
    { minKm: start, maxKm: mid },
    { minKm: mid, maxKm: end }
  ];
}
