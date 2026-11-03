import type { Need, StopCandidate } from "@/lib/domain/types";
import type { RouteModel } from "@/lib/route/model";
import type { ProviderUsage } from "@/lib/trip/types";
import { getBudget } from "./budget";
import { discoverOsmPlaces } from "./osmPlaces";
import type { PlaceProvider } from "./places";
import { verifyWithTomTom } from "./tomtom";

/**
 * Real-place provider for any RouteModel: OSM places discovered per requested km window
 * (see osmPlaces.ts), optionally verified with TomTom for the top-N of each window.
 * On Overpass failure it returns [] and records why in `trace` — it never fabricates places;
 * the caller decides whether to fall back to fixtures.
 */
export class RoutePlaceProvider implements PlaceProvider {
  isMock = false;
  readonly trace: string[] = [];
  private verified = false;
  private readonly sessionId?: string;
  private readonly tomtomVerifyTop: number;
  private readonly fetchImpl?: typeof fetch;

  constructor(
    private readonly route: RouteModel,
    opts: { sessionId?: string; tomtomVerifyTop?: number; fetchImpl?: typeof fetch } = {}
  ) {
    this.sessionId = opts.sessionId;
    this.tomtomVerifyTop = Math.max(0, opts.tomtomVerifyTop ?? 0);
    this.fetchImpl = opts.fetchImpl;
  }

  get name(): string {
    return this.verified ? "osm-places+tomtom" : "osm-places";
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
    try {
      const res = await discoverOsmPlaces(this.route, { minKm: opts.minKm, maxKm: opts.maxKm }, opts.needs, {
        sessionId: this.sessionId,
        fetchImpl: this.fetchImpl
      });
      this.trace.push(...res.trace.map((t) => `${label} ${t}`));
      candidates = res.candidates;
    } catch (err) {
      this.trace.push(`${label}: OSM lookup failed — ${(err as Error).message}; returning no real places`);
      return [];
    }

    if (this.tomtomVerifyTop > 0 && candidates.length > 0) {
      const n = Math.min(this.tomtomVerifyTop, candidates.length);
      for (let i = 0; i < n; i++) {
        const c = candidates[i];
        const v = await verifyWithTomTom(c, { sessionId: this.sessionId, fetchImpl: this.fetchImpl });
        if (v.status === "verified") {
          this.verified = true;
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
