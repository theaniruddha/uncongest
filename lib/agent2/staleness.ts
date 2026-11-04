/**
 * Deterministic staleness check for Tactical results that arrive late.
 * A result is stale when it was decided for a different context version, when it was decided for a
 * later position/time than the current one (the trip was reset or rewound meanwhile), or when every
 * recommended exit is now behind the lead car / inside the safety-notice distance.
 * Partially stale results keep only the still-reachable recommendations.
 */
export interface TacticalResultLike {
  recommendations: Array<{ stopId: string; rank: number }>;
  recommendedStops?: Array<{ id: string; distanceAlongRouteKm: number }>;
  decidedFor?: { contextVersion: string | null; leadKm?: number | null; elapsedMinutes?: number | null } | null;
}

export type StalenessVerdict =
  | { stale: true; reason: "context_changed" | "time_reversed" | "exits_passed" }
  | { stale: false; keepStopIds: string[]; dropped: string[] };

/** Tolerances for the rounding the request applies (elapsed → whole minutes, km → 0.1). */
const KM_EPS = 0.5;
const MIN_EPS = 1;

export function checkTacticalStaleness(
  r: TacticalResultLike,
  currentContextVersion: string | null,
  leadKm: number,
  noticeKm: number,
  currentElapsedMinutes?: number
): StalenessVerdict {
  if (r.decidedFor?.contextVersion != null && currentContextVersion != null && r.decidedFor.contextVersion !== currentContextVersion) {
    return { stale: true, reason: "context_changed" };
  }
  const d = r.decidedFor;
  if (d?.leadKm != null && d.leadKm > leadKm + KM_EPS) return { stale: true, reason: "time_reversed" };
  if (d?.elapsedMinutes != null && currentElapsedMinutes != null && d.elapsedMinutes > currentElapsedMinutes + MIN_EPS) return { stale: true, reason: "time_reversed" };
  const keep: string[] = [];
  const dropped: string[] = [];
  for (const rec of r.recommendations) {
    const st = r.recommendedStops?.find((s) => s.id === rec.stopId);
    if (!st || st.distanceAlongRouteKm >= leadKm + noticeKm) keep.push(rec.stopId);
    else dropped.push(rec.stopId);
  }
  if (r.recommendations.length > 0 && keep.length === 0) return { stale: true, reason: "exits_passed" };
  return { stale: false, keepStopIds: keep, dropped };
}

/** Keep only the listed stop ids (in order) and re-rank 1..n. */
export function keepAndRerank<T extends { stopId: string; rank: number }>(recs: readonly T[], keep: (stopId: string) => boolean): T[] {
  return recs.filter((x) => keep(x.stopId)).map((x, i) => ({ ...x, rank: i + 1 }));
}

/** Remove stops the user skipped after the request was sent (the request's exclusions were older). */
export function withoutSkipped<T extends { stopId: string; rank: number }>(recs: readonly T[], skipped: readonly string[]): T[] {
  if (!skipped.length) return [...recs];
  const s = new Set(skipped);
  return recs.some((x) => s.has(x.stopId)) ? keepAndRerank(recs, (id) => !s.has(id)) : [...recs];
}
