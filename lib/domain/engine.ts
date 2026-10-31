import type {
  CarState,
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

function meetsHardDiet(stop: StopCandidate, required: string[]): boolean {
  if (required.length === 0) return true;
  if (required.includes("vegetarian") || required.includes("vegan")) {
    return stop.vegetarianVerified === true;
  }
  return true;
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
  const urgentNeeds: Need[] = intent.hungerLevel >= 3 ? [...allNeeds, "meal" as Need] : [...allNeeds];

  const eligible: EligibleStop[] = [];
  const rejected: RejectionReason[] = [];

  const detourTolerance = env.weather === "rain" || env.weather === "snow" || env.weather === "cold" ? 0.6 : 1;

  for (const stop of stops) {
    const reasons: string[] = [];

    const stale = cars.some((c) => c.positionUpdatedMinutesAgo > LOCATION_FRESHNESS_LIMIT_MIN);
    if (stale) reasons.push("one or more car positions are stale (>3 min); precision degraded");

    if (config.avoidRegion && stop.region === config.avoidRegion && !urgentNeeds.includes("ev_charge")) {
      reasons.push(`excluded region: ${config.avoidRegion} per trip config`);
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
    const effectiveMaxDetour = Math.min(config.maximumDetourMinutesPerCar, intent.maxDetourMinutes) * detourTolerance;
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
    const open = isOpenAt(stop, trip.localTime);
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
    const score =
      1 -
      (0.35 * maxDetourNorm + 0.25 * waitNorm + 0.25 * qualityPenalty + 0.15 * unmetNorm);

    eligible.push({
      stop,
      minutesAheadForLead,
      detourMinutesByCar: detourByCar,
      arrivalMinutesFromNowByCar: arrivalByCar,
      maxGroupWaitMinutes: maxGroupWait,
      score,
      scoreBreakdown: { groupDetour: maxDetourNorm, maxWait: waitNorm, quality: qualityPenalty, unmetNeeds: unmetNorm }
    });
  }

  eligible.sort((a, b) => b.score - a.score);
  return { eligible, rejected };
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

export function buildRecommendations(eligible: EligibleStop[], limit = 3): Recommendation[] {
  const top = eligible.slice(0, limit);
  return top.map((e, i) => {
    const risks: string[] = [];
    if (e.stop.isMock) risks.push("SIMULATED fixture data — not a real business or live rating");
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
  isMockProvider: boolean
): EngineResult {
  const { trip, config, cars, collectiveIntent, environment } = request;
  const triggers = deriveTriggerReasons(collectiveIntent, config, trip, environment);
  const { eligible, rejected } = evaluateCandidates(stops, cars, collectiveIntent, config, trip, environment);

  if (triggers.length === 0 || eligible.length === 0) {
    return {
      action: "STAY_SILENT",
      recommendations: [],
      rejected,
      triggerReasons: triggers,
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
    recommendations = buildRecommendations(eligible, 3);
  }

  return {
    action: "PROPOSE_STOP",
    recommendations,
    rejected,
    triggerReasons: triggers,
    provider: providerName,
    isMock: isMockProvider,
    decidedAtLocal: trip.localTime
  };
}
