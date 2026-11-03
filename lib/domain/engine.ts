import type {
  CarState,
  Dietary,
  CollectiveIntent,
  EligibleStop,
  EngineResult,
  Environment,
  Need,
  Recommendation,
  RecommendationKind,
  RejectionReason,
  StopCandidate,
  TripConfig,
  TripContext
} from "./types";
import { evaluateUrgency, HORIZON, type UrgencyResult } from "./urgency";

export const LOCATION_FRESHNESS_LIMIT_MIN = 3;
const AVG_CRUISE_KPH = 100;
const DWELL_MINUTES = 25;

export function mapsUrlFor(lat: number, lng: number, name: string): string {
  const label = encodeURIComponent(name);
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&destination_place_name=${label}`;
}

export function addMinutesToLocalTime(localTime: string, minutes: number): string {
  const [h, m] = localTime.split(":").map(Number);
  const total = ((h * 60 + m + Math.round(minutes)) % 1440 + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export function isOpenAt(stop: StopCandidate, localTime: string): { open: boolean; note?: string } {
  if (stop.open24h) return { open: true };
  const [h, m] = localTime.split(":").map(Number);
  const minutes = h * 60 + m;
  const toMin = (s: string) => {
    const [hh, mm] = s.split(":").map(Number);
    return hh * 60 + mm;
  };
  const opens = stop.opensLocal ? toMin(stop.opensLocal) : 0;
  const closes = stop.closesLocal ? toMin(stop.closesLocal) : 24 * 60;
  if (minutes >= opens && minutes < closes) return { open: true };
  return {
    open: false,
    note: `opens ${stop.opensLocal ?? "?"}-${stop.closesLocal ?? "?"} local; ETA ${localTime}`
  };
}

export function meetsHardDiet(stop: StopCandidate, required: Dietary[]): boolean {
  if (required.length === 0) return true;
  const verified = stop.dietaryVerified ?? (stop.vegetarianVerified === true ? ["vegetarian" as Dietary] : []);
  return required.every((d) => verified.includes(d));
}

const STRICT_DIETS: Dietary[] = ["halal", "gluten_free"];
const VEG_DIETS: Dietary[] = ["vegetarian", "vegan"];

export type VegLevel = NonNullable<StopCandidate["vegOptions"]>;
export function vegLevel(stop: StopCandidate): VegLevel {
  if (stop.vegOptions) return stop.vegOptions;
  if (stop.dietaryVerified?.includes("vegetarian") || stop.vegetarianVerified === true) return "good";
  return "some"; // unknown menus: most highway food has something veg; never assume "poor"
}

export interface DietFit {
  ok: boolean;
  /** Hard rejection reason (strict diets, or a clearly non-veg-friendly menu). */
  reason?: string;
  /** Soft note for the trace / recommendation. */
  note?: string;
  /** Score adjustment: negative = worse fit, positive = better. */
  adjust: number;
}

/**
 * Diet only matters when the group would eat there (meal needed AND the stop serves meals).
 * - halal / gluten_free: strict — must be verified.
 * - vegetarian / vegan: a preference — "veg-friendly" is enough (Subway-style chains, plazas);
 *   only clearly non-veg-friendly menus (steakhouse, bar-style diner) are excluded.
 */
export function dietFit(stop: StopCandidate, diet: Dietary[], needs: Need[]): DietFit {
  if (diet.length === 0 || !needs.includes("meal") || !stop.categories.includes("meal")) return { ok: true, adjust: 0 };
  const strict = diet.filter((d) => STRICT_DIETS.includes(d));
  if (strict.length && !meetsHardDiet(stop, strict)) {
    return { ok: false, reason: `hard dietary requirement (${strict.join(", ")}) not verified`, adjust: 0 };
  }
  const veg = diet.filter((d) => VEG_DIETS.includes(d));
  if (veg.length === 0) return { ok: true, adjust: 0 };
  const level = vegLevel(stop);
  const vegan = veg.includes("vegan");
  if (level === "poor") {
    return { ok: false, reason: `not veg-friendly${stop.vegOptionsNote ? `: ${stop.vegOptionsNote}` : " (steakhouse / bar-style menu)"}`, adjust: 0 };
  }
  if (level === "some") {
    return {
      ok: true,
      adjust: vegan ? -0.1 : -0.04,
      note: `${vegan ? "vegan" : "vegetarian"} options likely but not a veg-focused menu${stop.vegOptionsNote ? ` (${stop.vegOptionsNote})` : ""}`
    };
  }
  return { ok: true, adjust: level === "dedicated" ? 0.06 : 0.03, note: level === "dedicated" ? "veg-focused menu" : "good vegetarian options" };
}

function chargerCompatible(stop: StopCandidate, cars: CarState[]): boolean {
  const evCars = cars.filter((c) => c.ev);
  if (evCars.length === 0) return true;
  if (!stop.chargers || stop.chargers.length === 0) return false;
  return evCars.every((car) => {
    if (!car.connector) return false;
    return stop.chargers!.some((ch) => ch.connector === car.connector && ch.count > 0);
  });
}

function coversNeeds(stop: StopCandidate, needs: Need[]): Need[] {
  return needs.filter((n) => !stop.categories.includes(n));
}

export function evaluateCandidates(
  stops: StopCandidate[],
  cars: CarState[],
  intent: CollectiveIntent,
  config: TripConfig,
  trip: TripContext,
  env: Environment
): { eligible: EligibleStop[]; rejected: RejectionReason[] } {
  const lead = cars.find((c) => c.role === "lead") ?? cars[0];
  const allNeeds = new Set<Need>([...intent.need, ...cars.flatMap((c) => c.needs)]);
  const requiredDiet = [...new Set([...config.requiredDiet, ...intent.dietary])];
  const urgent = intent.hungerLevel >= 3 || intent.need.includes("ev_charge");
  const urgentNeeds: Need[] = intent.hungerLevel >= 3 ? [...allNeeds, "meal" as Need] : [...allNeeds];

  const eligible: EligibleStop[] = [];
  const rejected: RejectionReason[] = [];
  const deprioritized: RejectionReason[] = [];

  const detourTolerance = !urgent && (env.weather === "rain" || env.weather === "snow" || env.weather === "cold") ? 0.6 : 1;
  const effectiveMaxDetour = Math.min(config.maximumDetourMinutesPerCar, intent.maxDetourMinutes) * detourTolerance;

  for (const stop of stops) {
    const reasons: string[] = [];
    const soft: string[] = [];

    const stale = cars.some((c) => c.positionUpdatedMinutesAgo > LOCATION_FRESHNESS_LIMIT_MIN);
    if (stale) reasons.push("one or more car positions are stale (>3 min); precision degraded");

    if (config.avoidRegion && stop.region === config.avoidRegion) {
      if (urgent) {
        soft.push(`region ${config.avoidRegion} normally excluded, but allowed under urgent need (${urgentNeeds.join(", ")})`);
      } else {
        reasons.push(`excluded region: ${config.avoidRegion} per trip config`);
      }
    }
    if (trip.elapsedMinutes < config.noOptionalStopsFirstMinutes && intent.hungerLevel < 3) {
      reasons.push(`within no-optional-stops window (first ${config.noOptionalStopsFirstMinutes} min)`);
    }

    const minutesAheadForLead = lead.speedKph > 0 ? ((stop.distanceAlongRouteKm - lead.progressKm) / lead.speedKph) * 60 : Infinity;
    if (minutesAheadForLead <= 0) {
      reasons.push("exit already passed by lead car");
    } else if (minutesAheadForLead < config.advanceNoticeMinutes) {
      reasons.push(`insufficient lead time: ${minutesAheadForLead.toFixed(1)} min ahead < ${config.advanceNoticeMinutes} min notice`);
    }

    const detourByCar: Record<string, number> = {};
    const arrivalByCar: Record<string, number> = {};
    let maxDetour = 0;
    let unreachable = false;
    for (const car of cars) {
      const distAhead = stop.distanceAlongRouteKm - car.progressKm;
      const base = car.speedKph > 0 ? (Math.max(distAhead, 0) / car.speedKph) * 60 : Infinity;
      const detour = distAhead <= 0 ? Infinity : stop.accessMinutes + env.trafficDelayMinutes * 0.2;
      if (!isFinite(detour) || !isFinite(base)) {
        unreachable = true;
        detourByCar[car.id] = Infinity;
        arrivalByCar[car.id] = Infinity;
        continue;
      }
      detourByCar[car.id] = detour;
      arrivalByCar[car.id] = base + detour;
      maxDetour = Math.max(maxDetour, detour);
    }
    if (unreachable) reasons.push("unreachable: stop behind one or more cars");
    if (!unreachable && maxDetour > effectiveMaxDetour) {
      reasons.push(`detour ${maxDetour.toFixed(1)} min exceeds limit ${effectiveMaxDetour.toFixed(1)} min (weather-adjusted)`);
    }

    const arrivals = Object.values(arrivalByCar).filter(isFinite);
    const maxGroupWait = arrivals.length > 1 ? Math.max(...arrivals) - Math.min(...arrivals) : 0;
    if (arrivals.length > 1 && maxGroupWait > config.maximumRegroupWaitMinutes) {
      reasons.push(`group wait ${maxGroupWait.toFixed(1)} min exceeds ${config.maximumRegroupWaitMinutes} min`);
    }

    const diet = dietFit(stop, requiredDiet, urgentNeeds);
    if (!diet.ok) reasons.push(diet.reason!);
    if (urgentNeeds.includes("ev_charge") && !chargerCompatible(stop, cars)) {
      reasons.push("no verified compatible charger for an EV in the group");
    }
    const arrivalLocal = addMinutesToLocalTime(trip.localTime, minutesAheadForLead);
    const open = isOpenAt(stop, arrivalLocal);
    if (!open.open) reasons.push(open.note ?? "closed at ETA");

    if (reasons.length > 0) {
      rejected.push({ stopId: stop.id, reasons });
      continue;
    }

    const unmet = coversNeeds(stop, urgentNeeds);
    const qualityPenalty = 1 - stop.qualityScoreMock;
    const maxDetourNorm = Math.min(maxDetour / Math.max(config.maximumDetourMinutesPerCar, 1), 1);
    const waitNorm = Math.min(maxGroupWait / Math.max(config.maximumRegroupWaitMinutes, 1), 1);
    const unmetNorm = urgentNeeds.length > 0 ? unmet.length / urgentNeeds.length : 0;

    const fatigue = trip.minutesSinceLastStop != null ? Math.min(trip.minutesSinceLastStop / 180, 1) : 0;
    const darkness = env.daylightMinutes < 60 ? (60 - env.daylightMinutes) / 60 : 0;
    const kidFactor = intent.kids && stop.restroomsVerified === true ? 0.05 : 0;
    const trafficRisk = Math.min(env.trafficDelayMinutes / 60, 1) * (stop.type === "highway-plaza" ? 0.1 : 0);

    const score =
      1 -
      (0.3 * maxDetourNorm +
        0.2 * waitNorm +
        0.2 * qualityPenalty +
        0.15 * unmetNorm +
        0.05 * fatigue +
        0.05 * darkness * maxDetourNorm +
        trafficRisk) +
      kidFactor +
      diet.adjust;
    if (diet.note && diet.adjust < 0) soft.push(diet.note);

    const tier: EligibleStop["tier"] =
      stop.qualityScoreMock <= 0.5 || stop.restroomsVerified === false ? "fallback" : "primary";

    eligible.push({
      stop,
      tier,
      minutesAheadForLead,
      detourMinutesByCar: detourByCar,
      arrivalMinutesFromNowByCar: arrivalByCar,
      maxGroupWaitMinutes: maxGroupWait,
      score: Math.max(0, Math.min(1, score)),
      scoreBreakdown: { groupDetour: maxDetourNorm, maxWait: waitNorm, quality: qualityPenalty, unmetNeeds: unmetNorm }
    });
    if (soft.length > 0) {
      deprioritized.push({ stopId: stop.id, reasons: soft });
    }
  }

  eligible.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier === "primary" ? -1 : 1;
    return b.score - a.score;
  });
  return { eligible, rejected: [...rejected, ...deprioritized.filter((d) => !rejected.some((r) => r.stopId === d.stopId))] };
}

export function deriveTriggerReasons(
  intent: CollectiveIntent,
  config: TripConfig,
  trip: TripContext,
  env: Environment
): string[] {
  const reasons: string[] = [];
  if (intent.hungerLevel >= 2 || intent.need.includes("meal")) reasons.push("meal window approaching; group hungry");
  if (intent.need.includes("coffee")) reasons.push("coffee requested by group");
  if (intent.need.includes("restroom") || intent.restroomUrgent) {
    reasons.push(intent.kids ? "restroom/rest break needed (kids in group)" : "restroom/rest break needed");
  } else if (intent.kids && (trip.minutesSinceLastStop ?? 0) >= 90) {
    reasons.push("rest break due (kids in group, 90+ min since last stop)");
  }
  if (intent.need.includes("ev_charge")) reasons.push("EV charge needed");
  if (!config.groceriesCompleted && env.weather === "cold" && env.daylightMinutes < 90) {
    reasons.push("cold after dark approaching and groceries not yet purchased");
  }
  if (env.trafficDelayMinutes >= 20) reasons.push(`heavy traffic delay ${env.trafficDelayMinutes} min ahead`);
  return reasons;
}

function pickKinds(rank: number): RecommendationKind {
  return rank === 0 ? "BEST_FIT" : rank === 1 ? "FASTEST" : "ALTERNATIVE";
}

export function buildRecommendations(eligible: EligibleStop[], limit = 3, urgency: 0 | 1 | 2 | 3 = 0, nearestFirst = false): Recommendation[] {
  const urgencyScore = (e: EligibleStop) => e.score + (1 - e.scoreBreakdown.groupDetour) * 0.35 + (1 - e.scoreBreakdown.unmetNeeds) * 0.1;
  const ranked = [...eligible].sort((a, b) => {
    if (nearestFirst) return a.stop.distanceAlongRouteKm - b.stop.distanceAlongRouteKm;
    if (urgency >= 3) return urgencyScore(b) - urgencyScore(a);
    if (a.tier !== b.tier) return a.tier === "primary" ? -1 : 1;
    return b.score - a.score;
  });
  const primary = ranked.filter((e) => e.tier === "primary");
  const top = urgency >= 3 || nearestFirst ? ranked.slice(0, limit) : (primary.length >= 2 ? primary : ranked).slice(0, limit);
  return top.map((e, i) => {
    const risks: string[] = [];
    if (e.stop.isMock) risks.push("SIMULATED fixture data — not a real business or live rating");
    if (e.tier === "fallback") risks.push("FALLBACK: lower quality or unverified facilities — best available given constraints; consider deferring if not urgent");
    if (e.stop.restroomsVerified !== true) risks.push("restroom availability unverified");
    if (e.stop.congestionNoteMock) risks.push(e.stop.congestionNoteMock);
    if (e.maxGroupWaitMinutes > 0) risks.push(`cars arrive ${e.maxGroupWaitMinutes.toFixed(0)} min apart; regroup wait applies`);
    return {
      kind: pickKinds(i),
      stopId: e.stop.id,
      name: e.stop.name,
      rank: i + 1,
      reason: `${e.stop.name}${e.stop.exitLabel ? ` at ${e.stop.exitLabel}` : ""} matches the group's needs with ${(e.score * 100).toFixed(0)}% composite fit (quality ${(e.stop.qualityScoreMock * 100).toFixed(0)}% mock); lead car reaches the exit in ~${Math.round(e.minutesAheadForLead)} min.`,
      tradeoffs: [
        `Extra driving: ${Math.max(...Object.values(e.detourMinutesByCar)).toFixed(0)} min max per car`,
        `Group wait: ${e.maxGroupWaitMinutes.toFixed(0)} min`,
        `Quality score (mock): ${(e.stop.qualityScoreMock * 100).toFixed(0)}%`
      ],
      detourMinutesByCar: e.detourMinutesByCar,
      arrivalMinutesFromNowByCar: e.arrivalMinutesFromNowByCar,
      maxGroupWaitMinutes: e.maxGroupWaitMinutes,
      confidence: Math.round(e.score * 100) / 100,
      risks,
      mapsUrl: mapsUrlFor(e.stop.lat, e.stop.lng, e.stop.name),
      requiresApproval: true,
      mock: true
    };
  });
}

export function decide(
  request: import("./types").RecommendStopsRequest,
  stops: StopCandidate[],
  llmPick: { action?: string; picks: Array<{ stopId: string; reason: string; tradeoffs: string[]; kind?: string }>; speakMessage?: string } | null,
  providerName: string,
  isMockProvider: boolean,
  precomputed?: { eligible: EligibleStop[]; rejected: RejectionReason[]; exploration: string[]; triggers?: string[]; urgency?: UrgencyResult }
): EngineResult {
  const { trip, config, cars, collectiveIntent, environment } = request;
  const triggers = precomputed?.triggers ?? deriveTriggerReasons(collectiveIntent, config, trip, environment);
  const urgency = precomputed?.urgency;
  const { eligible, rejected } = precomputed ?? evaluateCandidates(stops, cars, collectiveIntent, config, trip, environment);

  const understood = buildUnderstoodSummary(request);
  const verifiedChecks = buildVerifiedChecks(request, eligible, rejected);
  const exploration: string[] = precomputed?.exploration ?? [];

  if (triggers.length === 0 || eligible.length === 0) {
    return {
      action: "STAY_SILENT",
      recommendations: [],
      rejected,
      triggerReasons: triggers,
      understood,
      exploration,
      verifiedChecks,
      provider: providerName,
      isMock: isMockProvider,
      decidedAtLocal: trip.localTime,
      urgency
    };
  }

  // The model may decline to interrupt only when the need is low (e.g. a meal-time reminder).
  if (llmPick?.action === "STAY_SILENT" && (!urgency || urgency.level === "none" || urgency.level === "low")) {
    return {
      action: "STAY_SILENT",
      recommendations: [],
      rejected,
      triggerReasons: triggers,
      understood,
      exploration: [...exploration, "decision agent chose STAY_SILENT (allowed at low urgency)"],
      verifiedChecks,
      provider: providerName,
      isMock: isMockProvider,
      decidedAtLocal: trip.localTime,
      urgency,
      speakMessage: llmPick.speakMessage
    };
  }

  const nearestFirst = urgency?.level === "high";
  let recommendations: Recommendation[];
  if (llmPick && llmPick.picks.length > 0) {
    const byId = new Map(eligible.map((e) => [e.stop.id, e]));
    const chosen = llmPick.picks
      .map((p) => byId.get(p.stopId))
      .filter((e): e is EligibleStop => Boolean(e))
      .slice(0, 3);
    if (chosen.length === 0) {
      recommendations = buildRecommendations(eligible, 3, collectiveIntent.hungerLevel, nearestFirst);
    } else {
      recommendations = chosen.map((e, i) => {
      const base = buildRecommendations([e], 1)[0];
      const llm = llmPick.picks.find((p) => p.stopId === e.stop.id);
      return {
        ...base,
        rank: i + 1,
        kind: (llm?.kind as RecommendationKind) ?? base.kind,
        reason: llm?.reason ?? base.reason,
        tradeoffs: llm?.tradeoffs?.length ? llm.tradeoffs : base.tradeoffs
      };
    });
    }
  } else {
    recommendations = buildRecommendations(eligible, 3, collectiveIntent.hungerLevel, nearestFirst);
  }

  const action: EngineResult["action"] =
    llmPick?.action === "ESCALATE_TO_PASSENGER" || llmPick?.action === "REPLAN" ? llmPick.action : "PROPOSE_STOP";
  return {
    action,
    recommendations,
    rejected,
    triggerReasons: triggers,
    understood,
    exploration,
    verifiedChecks,
    provider: providerName,
    isMock: isMockProvider,
    decidedAtLocal: trip.localTime,
    urgency,
    speakMessage: llmPick?.speakMessage
  };
}

function buildUnderstoodSummary(request: import("./types").RecommendStopsRequest): string[] {
  const { collectiveIntent: intent, environment: env, trip, cars } = request;
  const out: string[] = [];
  if (intent.need.length) out.push(`needs: ${intent.need.join(", ")}`);
  if (intent.hungerLevel > 0) out.push(`hunger level ${intent.hungerLevel}/3${intent.hungerLevel >= 3 ? " (urgent)" : ""}`);
  if (intent.dietary.length) out.push(`dietary: ${intent.dietary.join(", ")}`);
  if (intent.kids) out.push("children in group — restroom priority");
  const evCars = cars.filter((c) => c.ev);
  if (evCars.length) {
    out.push(`EV: ${evCars.map((c) => `${c.id} ${c.connector ?? "?"} @ ${c.batteryPercent ?? "?"}%`).join("; ")}`);
  }
  out.push(`weather ${env.weather}, traffic +${env.trafficDelayMinutes} min, daylight left ${env.daylightMinutes} min`);
  if (trip.minutesSinceLastStop != null) out.push(`last stop ${trip.minutesSinceLastStop} min ago`);
  return out;
}

function buildVerifiedChecks(
  request: import("./types").RecommendStopsRequest,
  eligible: EligibleStop[],
  rejected: RejectionReason[]
): string[] {
  const checks: string[] = [];
  checks.push(`${eligible.length} candidate(s) passed all hard checks (${eligible.map((e) => e.stop.id).join(", ") || "none"})`);
  checks.push(`${rejected.length} candidate(s) rejected with reasons`);
  const stale = request.cars.some((c) => c.positionUpdatedMinutesAgo > LOCATION_FRESHNESS_LIMIT_MIN);
  checks.push(stale ? "position freshness: DEGRADED (>3 min)" : "position freshness: OK (<=3 min)");
  checks.push(`lead-time check: min ${request.config.advanceNoticeMinutes} min notice enforced`);
  checks.push(`detour cap: ${request.config.maximumDetourMinutesPerCar} min/car (weather-adjusted)`);
  checks.push(`group wait cap: ${request.config.maximumRegroupWaitMinutes} min`);
  return checks;
}

import type { PlaceProvider } from "@/lib/providers/places";

export interface ExplorationOutcome {
  exploration: string[];
  eligible: EligibleStop[];
  rejected: RejectionReason[];
  discoveredStopIds: string[];
}

export async function exploreNextExits(
  request: import("./types").RecommendStopsRequest,
  initial: { eligible: EligibleStop[]; rejected: RejectionReason[] },
  allInitialStops: StopCandidate[],
  placeProvider: PlaceProvider
): Promise<ExplorationOutcome> {
  const { cars, collectiveIntent } = request;
  const lead = cars.find((c) => c.role === "lead") ?? cars[0];
  const notes: string[] = [];
  const primaryCount = initial.eligible.filter((e) => e.tier === "primary").length;

  const windowMin = lead.progressKm + 1;
  const windowMax = lead.progressKm + 130;
  const needs = [...new Set([...collectiveIntent.need, ...cars.flatMap((c) => c.needs)])];

  const discovered = await placeProvider.getCandidates("nextExits", {
    minKm: windowMin,
    maxKm: windowMax,
    needs
  });
  notes.push(
    `second search: place provider "${placeProvider.name}" pass=nextExits over ${windowMin.toFixed(0)}–${windowMax.toFixed(0)} km ahead (next 1–2 exits beyond initial window), needs [${needs.join(", ") || "none"}] → ${discovered.length} raw candidate(s)`
  );

  const { eligible: newEligible, rejected: newRejected } = evaluateCandidates(
    discovered,
    cars,
    collectiveIntent,
    request.config,
    request.trip,
    request.environment
  );
  const discoveredStopIds = newEligible.map((e) => e.stop.id);
  if (newEligible.length > 0) {
    notes.push(`validated ${newEligible.length} newly discovered candidate(s): ${discoveredStopIds.join(", ")}`);
  }
  const eligibleIds = new Set(newEligible.map((e) => e.stop.id));
  const hardRejected = newRejected.filter((r) => !eligibleIds.has(r.stopId));
  const softNoted = newRejected.filter((r) => eligibleIds.has(r.stopId));
  if (hardRejected.length > 0) {
    notes.push(`rejected ${hardRejected.length} newly discovered candidate(s): ${hardRejected.map((r) => `${r.stopId} (${r.reasons[0]})`).join("; ")}`);
  }
  if (softNoted.length > 0) {
    notes.push(`kept with caveats: ${softNoted.map((r) => `${r.stopId} (${r.reasons[0]})`).join("; ")}`);
  }

  const mergedEligible = [...initial.eligible, ...newEligible].sort((a, b) => {
    if (a.tier !== b.tier) return a.tier === "primary" ? -1 : 1;
    return b.score - a.score;
  });
  const mergedRejected = [...initial.rejected, ...newRejected];

  const beforeTop = initial.eligible[0]?.stop.id ?? null;
  const afterTop = mergedEligible[0]?.stop.id ?? null;
  if (beforeTop && afterTop && beforeTop !== afterTop) {
    notes.push(`comparison changed the top recommendation: ${beforeTop} → ${afterTop}`);
  } else if (afterTop) {
    notes.push(`comparison confirmed ${afterTop} as top recommendation`);
  }
  if (primaryCount < 2 && initial.eligible.length > 0) {
    notes.push("initial options were thin (<2 primary); second search was warranted");
  }
  return { exploration: notes, eligible: mergedEligible, rejected: mergedRejected, discoveredStopIds };
}

export function urgencyForRequest(request: import("./types").RecommendStopsRequest): UrgencyResult {
  const { collectiveIntent: intent, cars, trip } = request;
  const evs = cars.filter((c) => c.ev && c.batteryPercent != null);
  return evaluateUrgency(
    {
      needs: [...new Set([...intent.need, ...cars.flatMap((c) => c.needs)])],
      hungerLevel: intent.hungerLevel,
      restroomUrgent: intent.restroomUrgent,
      notHungry: intent.notHungry,
      kids: intent.kids,
      ev: evs.length > 0,
      batteryPercent: evs.length ? Math.min(...evs.map((c) => c.batteryPercent!)) : undefined
    },
    {
      elapsedMinutes: trip.elapsedMinutes,
      localTime: trip.localTime,
      minutesSinceLastStop: trip.minutesSinceLastStop ?? trip.elapsedMinutes,
      lastMealMinutesAgo: trip.lastMealMinutesAgo ?? null
    }
  );
}

/**
 * Urgency-bounded horizon: high → nearest suitable exit(s); moderate → next 1–2 usable exits;
 * low → farther ahead. Widens at most once if nothing fits. Returns kept + notes.
 */
export function applyHorizon(
  eligible: EligibleStop[],
  leadKm: number,
  level: UrgencyResult["level"]
): { kept: EligibleStop[]; notes: string[] } {
  const order: Array<UrgencyResult["level"]> = ["high", "moderate", "low"];
  const pick = (lvl: UrgencyResult["level"]) => {
    const h = HORIZON[lvl];
    const within = eligible
      .filter((e) => e.stop.distanceAlongRouteKm - leadKm <= h.maxKm)
      .sort((a, b) => a.stop.distanceAlongRouteKm - b.stop.distanceAlongRouteKm);
    const exitIds = [...new Set(within.map((e) => e.stop.exitId))].slice(0, lvl === "high" ? 2 : h.exits);
    // Distance order only matters for high urgency; otherwise keep the score/tier ranking.
    const kept = (lvl === "high" ? within : eligible).filter(
      (e) => exitIds.includes(e.stop.exitId) && e.stop.distanceAlongRouteKm - leadKm <= h.maxKm
    );
    return { h, kept, exitCount: exitIds.length };
  };
  const notes: string[] = [];
  let first = pick(level);
  notes.push(
    `urgency ${level}: horizon ${first.h.label} (≤ ${first.h.maxKm} km) → ${first.kept.length} option(s) at ${first.exitCount} exit(s)`
  );
  if (first.kept.length === 0 && eligible.length > 0 && level !== "low" && level !== "none") {
    const wider = order[order.indexOf(level) + 1];
    first = pick(wider);
    notes.push(`nothing suitable inside the ${level} horizon; widened once to ${wider} (≤ ${first.h.maxKm} km) → ${first.kept.length} option(s)`);
  }
  const deferred = eligible.length - first.kept.length;
  if (deferred > 0) notes.push(`${deferred} eligible option(s) beyond the horizon deferred (not rejected)`);
  return { kept: first.kept, notes };
}

function gapAheadNote(kept: EligibleStop[], all: StopCandidate[], needs: Need[], destinationKm: number | null): string | null {
  if (kept.length === 0 || needs.length === 0) return null;
  const last = Math.max(...kept.map((e) => e.stop.distanceAlongRouteKm));
  const later = all
    .filter((s) => s.distanceAlongRouteKm > last + 3 && needs.some((n) => s.categories.includes(n)))
    .sort((a, b) => a.distanceAlongRouteKm - b.distanceAlongRouteKm)[0];
  if (later) {
    const gap = later.distanceAlongRouteKm - last;
    return gap >= 70
      ? `limited facilities ahead: after these options the next stop serving [${needs.join(", ")}] is ${Math.round(gap)} km later (${later.name})`
      : `next alternative after these options: ${later.name}, ${Math.round(gap)} km later`;
  }
  return destinationKm != null
    ? `no further known stops serving [${needs.join(", ")}] before the destination (${Math.round(destinationKm - last)} km)`
    : `no further known stops serving [${needs.join(", ")}] in provider data`;
}

export async function decideWithExploration(
  request: import("./types").RecommendStopsRequest,
  placeProvider: PlaceProvider,
  providerName: string,
  isMockProvider: boolean,
  llmResolver?: (ctx: {
    eligible: EligibleStop[];
    rejected: RejectionReason[];
    triggerReasons: string[];
    urgency: UrgencyResult;
    exploration: string[];
  }) => Promise<{ action?: string; picks: Array<{ stopId: string; reason: string; tradeoffs: string[]; kind?: string }>; speakMessage?: string } | null>,
  opts?: { destinationKm?: number }
): Promise<EngineResult> {
  const exclude = new Set(request.options?.excludeStopIds ?? []);
  const notExcluded = (s: StopCandidate) => !exclude.has(s.id);
  const initialStops = (
    await placeProvider.getCandidates("initial", {
      minKm: 0,
      maxKm: 1000,
      needs: request.collectiveIntent.need
    })
  ).filter(notExcluded);
  const urgency = urgencyForRequest(request);
  // Inferred needs (e.g. a meal-time reminder) shape scoring, but not the trigger wording.
  const evalIntent = { ...request.collectiveIntent, need: [...new Set([...request.collectiveIntent.need, ...urgency.needs])] };
  const activeNeeds = evalIntent.need;
  const servesNeed = (r: { eligible: EligibleStop[]; rejected: RejectionReason[] }) => {
    if (activeNeeds.length === 0) return r;
    const keep = r.eligible.filter((e) => activeNeeds.some((n) => e.stop.categories.includes(n)));
    const drop = r.eligible
      .filter((e) => !keep.includes(e))
      .map((e) => ({ stopId: e.stop.id, reasons: [`doesn't serve any active need (${activeNeeds.join(", ")})`] }));
    return { eligible: keep, rejected: [...r.rejected, ...drop] };
  };
  const initial = servesNeed(evaluateCandidates(initialStops, request.cars, evalIntent, request.config, request.trip, request.environment));
  const baseTriggers = deriveTriggerReasons(request.collectiveIntent, request.config, request.trip, request.environment);
  const triggers = [...baseTriggers];
  if (urgency.level !== "none" && baseTriggers.length === 0) triggers.push(...urgency.reasons);

  const primaryCount = initial.eligible.filter((e) => e.tier === "primary").length;
  let eligible = initial.eligible;
  let rejected = initial.rejected;
  let exploration: string[] = [];
  let discovered: StopCandidate[] = [];

  const needsExploration = triggers.length > 0 && (initial.eligible.length === 0 || primaryCount < 2);
  if (needsExploration) {
    const outcome = await exploreNextExits({ ...request, collectiveIntent: evalIntent }, initial, initialStops, {
      name: placeProvider.name,
      isMock: placeProvider.isMock,
      getCandidates: async (pass, o) => {
        const found = (await placeProvider.getCandidates(pass, o)).filter(notExcluded);
        discovered = found;
        return found;
      }
    });
    const filtered = servesNeed({ eligible: outcome.eligible, rejected: outcome.rejected });
    exploration = outcome.exploration;
    eligible = filtered.eligible;
    rejected = filtered.rejected;
  } else {
    exploration = ["initial search sufficient — second pass not warranted"];
  }
  if (exclude.size > 0) exploration.unshift(`excluded by group: ${[...exclude].join(", ")}`);

  if (triggers.length > 0) {
    const lead = request.cars.find((c) => c.role === "lead") ?? request.cars[0];
    const horizon = applyHorizon(eligible, lead.progressKm, urgency.level);
    exploration.push(...horizon.notes);
    if (horizon.kept.length > 0) eligible = horizon.kept;
    const gap = gapAheadNote(eligible, [...initialStops, ...discovered], urgency.needs, opts?.destinationKm ?? null);
    if (gap) exploration.push(gap);
  }

  let llmPick = null;
  if (llmResolver && (triggers.length === 0 || eligible.length > 0)) {
    try {
      llmPick = await llmResolver({ eligible, rejected, triggerReasons: triggers, urgency, exploration });
    } catch {
      llmPick = null;
    }
  }
  return decide(request, initialStops, llmPick, providerName, isMockProvider, { eligible, rejected, exploration, triggers, urgency });
}
