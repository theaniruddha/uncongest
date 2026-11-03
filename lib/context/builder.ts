import type { Need, Weather } from "@/lib/domain/types";
import type { PlaceRef, StopPlan } from "@/lib/trip/types";

/**
 * Relevance-aware, compact context for the LLM agents.
 * Destination / origin details are included only when they can change a stop decision, and each
 * inclusion is explained in `includedBecause`. Conversation history is capped at 2 utterances per car.
 */

export interface AgentContextCar {
  id: string;
  label: string;
  role: "lead" | "follower";
  // stable properties
  adults: number;
  kids: number;
  dietary: string[];
  ev?: boolean;
  maxDetourMinutes?: number;
  // current state
  progressKm: number;
  speedKph: number;
  phase: string;
  atStopId?: string;
  positionUpdatedMinutesAgo: number;
  drivingMinutesSinceRest?: number;
  batteryPercent?: number;
  // temporary needs
  needs: Need[];
  hungerLevel?: 0 | 1 | 2 | 3;
  restroomUrgent?: boolean;
  notHungry?: boolean;
  /** Newest last; only the last 2 are passed on. */
  recentUtterances?: string[];
}

export interface AgentContextState {
  elapsedMinutes: number;
  localTime: string;
  route: { totalKm: number; remainingKm: number; remainingMinutes: number };
  origin: PlaceRef;
  destination: PlaceRef;
  arrival: { local: string; minutesFromNow: number; sunsetLocal: string | null; afterDark: boolean; minutesAfterSunset: number | null };
  weatherAtDestination?: { condition: Weather; tempC?: number | null; description?: string } | null;
  cars: AgentContextCar[];
  /** All stop plans of the trip (history + active). */
  stops: StopPlan[];
  mealHistory?: { kind: "unknown" | "already_ate" | "last_meal_at"; time?: string };
  /** Group (lead) driving minutes since the last substantial rest. */
  drivingMinutesSinceRest: number;
  mood?: string[];
  mealPreference?: string;
  /** Largest arrival delay a candidate stop under consideration would add, minutes. */
  candidateDelayMinutes?: number;
  /** Number of food options known on the remaining route (undefined = not known). */
  foodOptionsAhead?: number;
}

export interface AgentContextResult {
  context: Record<string, unknown>;
  includedBecause: string[];
}

export const CONTEXT_THRESHOLDS = {
  arrivingSoonMinutes: 60,
  sunsetWindowMinutes: 45,
  candidateDelayMinutes: 20,
  fewFoodOptions: 2,
  tripJustStartedMinutes: 15,
  coldTempC: 0,
  utterancesPerCar: 2
} as const;

const r = (x: number) => Math.round(x);

function lastConfirmed(stops: StopPlan[], filter: (s: StopPlan) => boolean): StopPlan | null {
  const done = stops.filter((s) => (s.status === "COMPLETED" || s.status === "RESUMED") && filter(s));
  done.sort((a, b) => (a.departedAtElapsed ?? a.arrivedAtElapsed ?? 0) - (b.departedAtElapsed ?? b.arrivedAtElapsed ?? 0));
  return done.length ? done[done.length - 1] : null;
}

export function buildAgentContext(state: AgentContextState): AgentContextResult {
  const T = CONTEXT_THRESHOLDS;
  const why: string[] = [];

  // --- destination relevance
  const destReasons: string[] = [];
  if (state.arrival.minutesFromNow <= T.arrivingSoonMinutes) destReasons.push(`arriving within ${T.arrivingSoonMinutes} min`);
  if (state.arrival.afterDark) destReasons.push("arrival after dark");
  else if (state.arrival.minutesAfterSunset != null && state.arrival.minutesAfterSunset > -T.sunsetWindowMinutes)
    destReasons.push(`arrival within ${T.sunsetWindowMinutes} min of sunset`);
  const w = state.weatherAtDestination;
  if (w && (w.condition === "rain" || w.condition === "snow" || w.condition === "cold" || (w.tempC != null && w.tempC <= T.coldTempC)))
    destReasons.push(`arrival weather ${w.condition}`);
  if ((state.candidateDelayMinutes ?? 0) > T.candidateDelayMinutes) destReasons.push(`candidate stop delays arrival > ${T.candidateDelayMinutes} min`);
  if (state.foodOptionsAhead != null && state.foodOptionsAhead < T.fewFoodOptions) destReasons.push("few food options on remaining route");
  for (const d of destReasons) why.push(`destination: ${d}`);

  const includeOrigin = state.elapsedMinutes < T.tripJustStartedMinutes;
  if (includeOrigin) why.push(`origin: trip started < ${T.tripJustStartedMinutes} min ago`);

  // --- history
  const lastStop = lastConfirmed(state.stops, () => true);
  const lastMealStop = lastConfirmed(state.stops, (s) => s.satisfiedNeeds.includes("meal"));
  const minutesAgo = (s: StopPlan) => r(state.elapsedMinutes - (s.departedAtElapsed ?? s.arrivedAtElapsed ?? state.elapsedMinutes));
  const lastMeal: unknown = lastMealStop
    ? { at: lastMealStop.name, minAgo: minutesAgo(lastMealStop) }
    : state.mealHistory?.kind === "already_ate"
      ? "ate before departure"
      : state.mealHistory?.kind === "last_meal_at" && state.mealHistory.time
        ? { localTime: state.mealHistory.time }
        : "unknown";
  const active = state.stops.find((s) => s.status === "SELECTED" || s.status === "EN_ROUTE" || s.status === "ARRIVED");

  const context: Record<string, unknown> = {
    now: { min: r(state.elapsedMinutes), local: state.localTime },
    route: { totalKm: r(state.route.totalKm), remainingKm: r(state.route.remainingKm), remainingMin: r(state.route.remainingMinutes) },
    arrivalLocal: state.arrival.local,
    drivingMinSinceRest: r(state.drivingMinutesSinceRest),
    mood: state.mood ?? [],
    mealPref: state.mealPreference ?? "auto",
    lastStop: lastStop ? { name: lastStop.name, minAgo: minutesAgo(lastStop), satisfied: lastStop.satisfiedNeeds } : "none since departure",
    lastMeal,
    cars: state.cars.map((c) => {
      const needs: Record<string, unknown> = { list: c.needs };
      if (c.hungerLevel) needs.hunger = c.hungerLevel;
      if (c.restroomUrgent) needs.restroomUrgent = true;
      if (c.notHungry) needs.notHungry = true;
      const stable: Record<string, unknown> = { role: c.role, adults: c.adults, kids: c.kids };
      if (c.dietary.length) stable.diet = c.dietary;
      if (c.ev) stable.ev = true;
      if (c.maxDetourMinutes != null) stable.maxDetour = c.maxDetourMinutes;
      const now: Record<string, unknown> = { km: r(c.progressKm), kph: r(c.speedKph), phase: c.phase };
      if (c.atStopId) now.stop = c.atStopId;
      if (c.positionUpdatedMinutesAgo > 0) now.gpsStaleMin = c.positionUpdatedMinutesAgo;
      if (c.batteryPercent != null) now.battery = c.batteryPercent;
      if (c.drivingMinutesSinceRest != null) now.drivingSinceRest = r(c.drivingMinutesSinceRest);
      const out: Record<string, unknown> = { id: c.id, label: c.label, stable, now, needs };
      const said = (c.recentUtterances ?? []).slice(-T.utterancesPerCar).map((u) => (u.length > 160 ? `${u.slice(0, 157)}...` : u));
      if (said.length) out.said = said;
      return out;
    })
  };
  if (active) {
    context.activeStop = { id: active.stopId, name: active.name, status: active.status, km: r(active.km), dwell: active.plannedDwellMinutes, cars: active.participants };
  }
  if (destReasons.length) {
    const dest: Record<string, unknown> = {
      label: state.destination.label,
      type: state.destination.type,
      arrivalLocal: state.arrival.local,
      minutesAway: r(state.arrival.minutesFromNow),
      sunsetLocal: state.arrival.sunsetLocal,
      afterDark: state.arrival.afterDark
    };
    if (w) dest.weather = w.tempC != null ? { condition: w.condition, tempC: w.tempC } : { condition: w.condition };
    if (state.foodOptionsAhead != null) dest.foodOptionsAhead = state.foodOptionsAhead;
    dest.why = destReasons;
    context.destination = dest;
  }
  if (includeOrigin) context.origin = { label: state.origin.label, type: state.origin.type };
  return { context, includedBecause: why };
}
