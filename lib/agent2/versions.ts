/**
 * Pure version helpers for stale-result detection on the client.
 *
 * Two versions with different granularity:
 * - TACTICAL (5 s workflow): fine-grained — any setup field, car speed/offset, intent, skipped stop or
 *   stop commitment that would change a "right now" decision.
 * - STRATEGIC (30 s workflow): coarse — route, setup, needs, weather override, completed/cancelled
 *   stops, and a progress epoch that is bumped only when the shown plan expires. Never per tick and
 *   never on intermediate stop lifecycle steps (SELECTED → EN_ROUTE → ARRIVED).
 */
import { versionHash } from "./metrics";

export interface VersionStop {
  stopId: string;
  status: string;
  satisfiedNeeds: string[];
}

export interface VersionIntent {
  needs: Array<{ need: string }>;
  hungerLevel?: unknown;
  restroomUrgent?: unknown;
  notHungry?: unknown;
  dietary: readonly string[];
}

export interface VersionSetup {
  destinationLabel: string;
  departureUtcIso: string;
  departureMode: string;
  tz: string;
  dataMode: string;
  mood: readonly string[];
  mealPreference: unknown;
  mealHistory: unknown;
  customMeal?: unknown;
  cars: Array<{ id: string; speedKph: number; startOffsetMinutes: number }>;
}

export interface VersionInput {
  /** Bumped on every reset / re-plan so results from a previous trip never match. */
  tripGen: number;
  routeId: string;
  setup: VersionSetup;
  weatherOverride: string;
  intents: Record<string, VersionIntent | undefined>;
  stops: readonly VersionStop[];
}

const ACTIVE = new Set(["SELECTED", "EN_ROUTE", "ARRIVED"]);
const DONE = new Set(["COMPLETED", "RESUMED"]);

/**
 * Stop commitments that matter for planning.
 * - tactical: every committed stop; the active stop is one `active:` entry whatever its lifecycle step.
 * - strategic: only finished (COMPLETED/RESUMED, with satisfied needs) and CANCELLED stops.
 */
export function stopsSignature(stops: readonly VersionStop[], mode: "tactical" | "strategic"): string[] {
  const out: string[] = [];
  for (const s of stops) {
    if (DONE.has(s.status)) out.push(`done:${s.stopId}:${[...s.satisfiedNeeds].sort().join("+")}`);
    else if (s.status === "CANCELLED") out.push(`cancelled:${s.stopId}`);
    else if (mode === "tactical" && ACTIVE.has(s.status)) out.push(`active:${s.stopId}`);
  }
  return out;
}

function setupSignature(s: VersionSetup) {
  return {
    dest: s.destinationLabel,
    dep: s.departureUtcIso,
    mode: s.departureMode,
    tz: s.tz,
    data: s.dataMode,
    mood: [...s.mood].sort(),
    mealPreference: s.mealPreference ?? null,
    mealHistory: s.mealHistory ?? null,
    customMeal: s.customMeal ?? null
  };
}

function intentSignature(cars: VersionSetup["cars"], intents: VersionInput["intents"]) {
  return cars.map((c) => {
    const i = intents[c.id];
    return [c.id, i?.needs.map((n) => n.need).sort() ?? [], i?.hungerLevel ?? null, i?.restroomUrgent ?? null, i?.notHungry ?? null, i ? [...i.dietary].sort() : []];
  });
}

export function tacticalContextVersion(v: VersionInput & { skipped: readonly string[] }): string {
  return versionHash({
    w: "tactical",
    gen: v.tripGen,
    route: v.routeId,
    setup: setupSignature(v.setup),
    weather: v.weatherOverride,
    speeds: v.setup.cars.map((c) => [c.id, c.speedKph, c.startOffsetMinutes]),
    cars: intentSignature(v.setup.cars, v.intents),
    stops: stopsSignature(v.stops, "tactical"),
    skipped: [...v.skipped].sort()
  });
}

export function strategicContextVersion(v: VersionInput & { epoch: number }): string {
  return versionHash({
    w: "strategic",
    gen: v.tripGen,
    epoch: v.epoch,
    route: v.routeId,
    setup: setupSignature(v.setup),
    weather: v.weatherOverride,
    speeds: v.setup.cars.map((c) => [c.id, c.speedKph]),
    cars: intentSignature(v.setup.cars, v.intents),
    stops: stopsSignature(v.stops, "strategic")
  });
}

/**
 * True when the lead has passed the plan's expiresAtKm or the clock has passed expiresAtElapsed.
 * A km expiry at (or beyond) the end of the route never fires, so a plan covering the rest of the
 * trip is not re-planned in a loop at the destination. Unknown position/time never expires a plan.
 */
export function isPlanExpired(
  plan: { expiresAtKm?: number | null; expiresAtElapsed?: number | null } | null | undefined,
  at: { leadKm: number | null; elapsedMinutes: number | null; routeTotalKm?: number | null }
): boolean {
  if (!plan) return false;
  const kmLimitUseful = plan.expiresAtKm != null && (at.routeTotalKm == null || plan.expiresAtKm < at.routeTotalKm - 1);
  if (kmLimitUseful && at.leadKm != null && at.leadKm >= plan.expiresAtKm!) return true;
  if (plan.expiresAtElapsed != null && at.elapsedMinutes != null && at.elapsedMinutes >= plan.expiresAtElapsed) return true;
  return false;
}

/** Strategic run meta.status → client status. Unknown or "error" statuses are never shown as success. */
export function strategicClientStatus(metaStatus: string | undefined): "completed" | "cached" | "fallback" | "timeout" | "error" {
  return metaStatus === "completed" || metaStatus === "cached" || metaStatus === "fallback" || metaStatus === "timeout" ? metaStatus : "error";
}

/** Bounded retry backoff for failed Strategic runs: null once the attempts are used up. */
export function strategicRetryDelayMs(attempt: number, maxAttempts = 2, baseMs = 8000): number | null {
  if (attempt >= maxAttempts) return null;
  return baseMs * 2 ** attempt;
}
