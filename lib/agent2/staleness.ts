/**
 * Deterministic staleness check for Tactical results that arrive late.
 * A result is stale when it was decided for a different context version, or when every
 * recommended exit is now behind the lead car / inside the safety-notice distance.
 * Partially stale results keep only the still-reachable recommendations.
 */
export interface TacticalResultLike {
  recommendations: Array<{ stopId: string; rank: number }>;
  recommendedStops?: Array<{ id: string; distanceAlongRouteKm: number }>;
  decidedFor?: { contextVersion: string | null } | null;
}

export type StalenessVerdict =
  | { stale: true; reason: "context_changed" | "exits_passed" }
  | { stale: false; keepStopIds: string[]; dropped: string[] };

export function checkTacticalStaleness(r: TacticalResultLike, currentContextVersion: string | null, leadKm: number, noticeKm: number): StalenessVerdict {
  if (r.decidedFor?.contextVersion != null && currentContextVersion != null && r.decidedFor.contextVersion !== currentContextVersion) {
    return { stale: true, reason: "context_changed" };
  }
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
