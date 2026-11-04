import type { Dietary, Need, StopCandidate } from "./types";
import { dietFit } from "./engine";
import { URGENCY_RANK, type UrgencyLevel, type UrgencyResult } from "./urgency";

/**
 * Ambient Trip Watcher — a deterministic check run on every simulation tick (or live GPS fix).
 * It is NOT an agent: no LLM, no network. It decides whether Agent 2 needs to be called and
 * de-duplicates so the same situation never produces a second notification.
 *
 * Call Agent 2 when:
 *   - urgency is high (decide now), or
 *   - there is no live recommendation and a suitable exit is approaching (early enough to act), or
 *   - the previous recommendation became unusable (passed / inside the notice window / skipped), or
 *   - urgency escalated or the set of needs changed.
 * Stay quiet otherwise — including while a previous recommendation is still actionable.
 */
export interface WatchCar {
  id: string;
  progressKm: number;
  speedKph: number;
}

export interface WatchMemory {
  /** Situation key of the last Agent 2 call. */
  lastKey: string | null;
  lastCallElapsed: number | null;
  /** Top stop recommended last time and its route km (null after STAY_SILENT). */
  lastRecommendedKm: number | null;
  lastRecommendedStopId: string | null;
}

export const EMPTY_MEMORY: WatchMemory = { lastKey: null, lastCallElapsed: null, lastRecommendedKm: null, lastRecommendedStopId: null };

export interface WatchInput {
  elapsedMinutes: number;
  lead: WatchCar;
  urgency: UrgencyResult;
  /** Known candidate stops (fixture/provider cache) — used for timing only, not ranking. */
  stops: StopCandidate[];
  advanceNoticeMinutes: number;
  routeTotalKm: number;
  excludedStopIds: string[];
  /** A stop is confirmed and not yet reached — stay quiet. */
  confirmedStopPending: boolean;
  /** Hard dietary rules and excluded region, so the watcher's timing matches Agent 2's checks. */
  requiredDiet?: Dietary[];
  avoidRegion?: string | null;
  /** Early-trip quiet window (e.g. 30 min after leaving Home): routine reminders are held. */
  departureQuiet?: { untilElapsed: number; reason: string };
  memory: WatchMemory;
}

export interface WatchDecision {
  shouldCall: boolean;
  /** True when the call is allowed only because of the final-opportunity-before-gap exception. */
  overrideInitialQuiet?: boolean;
  key: string;
  reasons: string[];
  /** First relevant opportunity that can still be taken with enough notice. */
  nextOpportunity: { stopId: string; exitId: string; km: number; minutesAhead: number } | null;
  /** Gap (km) from that opportunity to the following relevant one (or destination). */
  gapAfterKm: number | null;
  missedRecommendation: boolean;
}

/** Window (minutes beyond the safety notice) in which an exit counts as "approaching". */
export const APPROACH_WINDOW_MIN = { high: 60, moderate: 25, low: 15, none: 0 } as const;
export const LIMITED_FACILITIES_GAP_KM = 70;
/** Never call Agent 2 more often than this (simulated minutes) unless urgency escalates or a rec is missed. */
export const MIN_CALL_SPACING_MIN = 5;

function relevant(stop: StopCandidate, needs: Need[]): boolean {
  return needs.length > 0 && needs.some((n) => stop.categories.includes(n));
}

function parseKey(key: string | null): { level: UrgencyLevel; needs: string } {
  const [level, , needs] = (key ?? "none||").split("|");
  return { level: (level as UrgencyLevel) || "none", needs: needs ?? "" };
}

export function watch(input: WatchInput): WatchDecision {
  const { lead, urgency, memory, elapsedMinutes } = input;
  const reasons: string[] = [];
  const minutesAheadOf = (km: number) => (lead.speedKph > 0 ? ((km - lead.progressKm) / lead.speedKph) * 60 : Infinity);
  const diet = input.requiredDiet ?? [];
  const regionOk = (s: StopCandidate) => !input.avoidRegion || s.region !== input.avoidRegion || urgency.level === "high";

  const ahead = input.stops
    .filter((s) => !input.excludedStopIds.includes(s.id) && relevant(s, urgency.needs) && regionOk(s))
    .filter((s) => dietFit(s, diet, urgency.needs).ok) // same diet rule Agent 2 applies
    .filter((s) => minutesAheadOf(s.distanceAlongRouteKm) >= input.advanceNoticeMinutes)
    .sort((a, b) => a.distanceAlongRouteKm - b.distanceAlongRouteKm);

  const next = ahead[0] ?? null;
  const following = ahead.find((s) => next && s.distanceAlongRouteKm - next.distanceAlongRouteKm > 3) ?? null;
  const gapAfterKm = next ? (following ? following.distanceAlongRouteKm : input.routeTotalKm) - next.distanceAlongRouteKm : null;
  const nextOpportunity = next
    ? { stopId: next.id, exitId: next.exitId, km: next.distanceAlongRouteKm, minutesAhead: minutesAheadOf(next.distanceAlongRouteKm) }
    : null;

  const needsKey = [...urgency.needs].sort().join(",");
  const key = `${urgency.level}|${nextOpportunity?.exitId ?? "none"}|${needsKey}`;
  const prev = parseKey(memory.lastKey);
  const escalated = URGENCY_RANK[urgency.level] > URGENCY_RANK[prev.level];
  const needsChanged = memory.lastKey != null && prev.needs !== needsKey;

  // Is the previous recommendation still something the driver can safely act on?
  const recActive = memory.lastRecommendedStopId != null && memory.lastRecommendedKm != null;
  const recStillActionable =
    recActive &&
    !input.excludedStopIds.includes(memory.lastRecommendedStopId!) &&
    minutesAheadOf(memory.lastRecommendedKm!) >= input.advanceNoticeMinutes;
  const missedRecommendation = recActive && !input.confirmedStopPending && !recStillActionable;

  const base = { key, nextOpportunity, gapAfterKm, missedRecommendation };
  const quiet = (why: string): WatchDecision => ({ ...base, shouldCall: false, reasons: [...reasons, why] });
  const call = (why: string): WatchDecision => ({
    ...base,
    shouldCall: true,
    overrideInitialQuiet: Boolean(input.departureQuiet && elapsedMinutes < input.departureQuiet.untilElapsed && urgency.reminderOnly),
    reasons: [...reasons, why]
  });

  if (input.confirmedStopPending) return quiet("stop confirmed; quiet until reached");
  if (urgency.level === "none") return quiet("no active need — stay quiet");
  if (input.departureQuiet && elapsedMinutes < input.departureQuiet.untilElapsed) {
    const explicit = !urgency.reminderOnly;
    const window0 = input.advanceNoticeMinutes + APPROACH_WINDOW_MIN[urgency.level];
    const finalBeforeGap =
      nextOpportunity != null && gapAfterKm != null && gapAfterKm >= LIMITED_FACILITIES_GAP_KM && nextOpportunity.minutesAhead <= window0;
    if (!explicit && urgency.level !== "high" && !finalBeforeGap) {
      return quiet(`${input.departureQuiet.reason} — routine stops held until ${Math.round(input.departureQuiet.untilElapsed)} min (explicit/urgent requests still go through)`);
    }
    if (finalBeforeGap && !explicit) reasons.push(`last suitable stop before a ${Math.round(gapAfterKm!)} km gap — overriding the early-trip quiet window`);
  }
  if (!missedRecommendation && key === memory.lastKey) return quiet("situation unchanged since last decision (deduplicated)");

  if (missedRecommendation) {
    const passed = lead.progressKm > memory.lastRecommendedKm!;
    reasons.push(`${passed ? "passed" : "can no longer safely signal"} previously recommended stop ${memory.lastRecommendedStopId}; recalculating`);
  } else if (recStillActionable && !escalated && !needsChanged) {
    return quiet(`recommendation ${memory.lastRecommendedStopId} still valid (${Math.round(minutesAheadOf(memory.lastRecommendedKm!))} min ahead)`);
  }

  const spaced = memory.lastCallElapsed == null || elapsedMinutes - memory.lastCallElapsed >= MIN_CALL_SPACING_MIN;
  if (!spaced && !escalated && !missedRecommendation) {
    return quiet(`rate-limited: last decision ${Math.round(elapsedMinutes - memory.lastCallElapsed!)} min ago`);
  }
  if (escalated && memory.lastKey) reasons.push(`urgency escalated ${prev.level} → ${urgency.level}`);
  if (needsChanged && !escalated) reasons.push(`needs changed (${prev.needs || "none"} → ${needsKey})`);

  if (urgency.level === "high") return call(`high urgency (${urgency.reasons.join("; ")}) — decide now`);
  if (!nextOpportunity) {
    if (urgency.level === "moderate") return call("moderate need but no suitable stop ahead with enough notice — ask engine to explain/escalate");
    return quiet("low urgency and no suitable stop ahead — stay quiet");
  }

  const window = input.advanceNoticeMinutes + APPROACH_WINDOW_MIN[urgency.level];
  const limitedAhead = gapAfterKm != null && gapAfterKm >= LIMITED_FACILITIES_GAP_KM;
  if (nextOpportunity.minutesAhead <= window) {
    if (limitedAhead) reasons.push(`after it, next suitable stop is ${Math.round(gapAfterKm!)} km later — limited facilities`);
    return call(`suitable exit ${Math.round(nextOpportunity.minutesAhead)} min ahead (notice ≥ ${input.advanceNoticeMinutes}, window ≤ ${window}) for ${urgency.level} urgency`);
  }
  if (limitedAhead && urgency.level === "moderate" && nextOpportunity.minutesAhead <= window + 20) {
    return call(`limited facilities after the next option (${Math.round(gapAfterKm!)} km gap) — recommend early`);
  }
  // Low urgency (e.g. a meal-time reminder) waits until an exit is actually approaching.
  if ((missedRecommendation || needsChanged || escalated) && urgency.level !== "low") return call("re-evaluating after change");
  return quiet(`${urgency.level} urgency; next suitable exit ${Math.round(nextOpportunity.minutesAhead)} min ahead — waiting until within ${window} min`);
}
