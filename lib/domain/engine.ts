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

function meetsHardDiet(stop: StopCandidate, required: Dietary[]): boolean {
  if (required.length === 0) return true;
  const verified = stop.dietaryVerified ?? (stop.vegetarianVerified === true ? ["vegetarian" as Dietary] : []);
  return required.every((d) => verified.includes(d));
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

    if (requiredDiet.length > 0 && !meetsHardDiet(stop, requiredDiet)) {
      reasons.push(`hard dietary requirement (${requiredDiet.join(", ")}) not verified`);
    }
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
      kidFactor;

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
  if (intent.need.includes("restroom") || intent.kids) reasons.push("restroom/rest break needed (kids in group)");
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

export function buildRecommendations(eligible: EligibleStop[], limit = 3, urgency: 0 | 1 | 2 | 3 = 0): Recommendation[] {
  const urgencyScore = (e: EligibleStop) => e.score + (1 - e.scoreBreakdown.groupDetour) * 0.35 + (1 - e.scoreBreakdown.unmetNeeds) * 0.1;
  const ranked = [...eligible].sort((a, b) => {
    if (urgency >= 3) return urgencyScore(b) - urgencyScore(a);
    if (a.tier !== b.tier) return a.tier === "primary" ? -1 : 1;
    return b.score - a.score;
  });
  const primary = ranked.filter((e) => e.tier === "primary");
  const top = urgency >= 3 ? ranked.slice(0, limit) : (primary.length >= 2 ? primary : ranked).slice(0, limit);
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
      reason: `${e.stop.name} matches the group's needs with ${(e.score * 100).toFixed(0)}% composite fit (quality ${(e.stop.qualityScoreMock * 100).toFixed(0)}% mock).`,
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
  precomputed?: { eligible: EligibleStop[]; rejected: RejectionReason[]; exploration: string[] }
): EngineResult {
  const { trip, config, cars, collectiveIntent, environment } = request;
  const triggers = deriveTriggerReasons(collectiveIntent, config, trip, environment);
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
      decidedAtLocal: trip.localTime
    };
  }

  let recommendations: Recommendation[];
  if (llmPick && llmPick.picks.length > 0) {
    const byId = new Map(eligible.map((e) => [e.stop.id, e]));
    const chosen = llmPick.picks
      .map((p) => byId.get(p.stopId))
      .filter((e): e is EligibleStop => Boolean(e))
      .slice(0, 3);
    if (chosen.length === 0) {
      recommendations = buildRecommendations(eligible, 3);
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
    recommendations = buildRecommendations(eligible, 3, collectiveIntent.hungerLevel);
  }

  return {
    action: "PROPOSE_STOP",
    recommendations,
    rejected,
    triggerReasons: triggers,
    understood,
    exploration,
    verifiedChecks,
    provider: providerName,
    isMock: isMockProvider,
    decidedAtLocal: trip.localTime
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
  if (newRejected.length > 0) {
    notes.push(`rejected ${newRejected.length} newly discovered candidate(s): ${newRejected.map((r) => `${r.stopId} (${r.reasons[0]})`).join("; ")}`);
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

export async function decideWithExploration(
  request: import("./types").RecommendStopsRequest,
  placeProvider: PlaceProvider,
  providerName: string,
  isMockProvider: boolean,
  llmResolver?: (ctx: {
    eligible: EligibleStop[];
    rejected: RejectionReason[];
    triggerReasons: string[];
  }) => Promise<{ action?: string; picks: Array<{ stopId: string; reason: string; tradeoffs: string[]; kind?: string }>; speakMessage?: string } | null>
): Promise<EngineResult> {
  const initialStops = await placeProvider.getCandidates("initial", {
    minKm: 0,
    maxKm: 1000,
    needs: request.collectiveIntent.need
  });
  const initial = evaluateCandidates(initialStops, request.cars, request.collectiveIntent, request.config, request.trip, request.environment);
  const triggers = deriveTriggerReasons(request.collectiveIntent, request.config, request.trip, request.environment);

  const primaryCount = initial.eligible.filter((e) => e.tier === "primary").length;
  let eligible = initial.eligible;
  let rejected = initial.rejected;
  let exploration: string[] = [];

  const needsExploration = triggers.length > 0 && (initial.eligible.length === 0 || primaryCount < 2);
  if (needsExploration) {
    const outcome = await exploreNextExits(request, initial, initialStops, placeProvider);
    exploration = outcome.exploration;
    eligible = outcome.eligible;
    rejected = outcome.rejected;
  } else {
    exploration = ["initial search sufficient — second pass not warranted"];
  }

  let llmPick = null;
  if (llmResolver && (triggers.length === 0 || eligible.length > 0)) {
    try {
      llmPick = await llmResolver({ eligible, rejected, triggerReasons: triggers });
    } catch {
      llmPick = null;
    }
  }
  return decide(request, initialStops, llmPick, providerName, isMockProvider, { eligible, rejected, exploration });
}
