import { NextResponse } from "next/server";
import { recommendStopsRequestSchema } from "@/lib/domain/schemas";
import { decideWithExploration, urgencyForRequest } from "@/lib/domain/engine";
import type { EligibleStop, RecommendStopsRequest, RejectionReason, StopCandidate, ToolTraceEntry, WeatherSnapshot } from "@/lib/domain/types";
import { HORIZON, type UrgencyResult } from "@/lib/domain/urgency";
import { getAiProvider } from "@/lib/providers/ai";
import { allUsage, getBudget } from "@/lib/providers/budget";
import { getPlaceProvider, type PlaceProvider } from "@/lib/providers/places";
import { routeModelForRef } from "@/lib/providers/routeRef";
import { RoutePlaceProvider, windowsForDecision } from "@/lib/providers/routePlaces";
import type { RouteModel } from "@/lib/route/model";
import { addMinutesLocal, getWeatherProvider, todayLocalDate, type WeatherReading } from "@/lib/providers/weather";
import { TORONTO_MONTREAL } from "@/lib/route/route";

export const dynamic = "force-dynamic";

function snap(r: WeatherReading): WeatherSnapshot {
  const { id, condition, tempC, precipProbability, description, source, forHour, stale, note } = r;
  return { id, condition, tempC, precipProbability, description, source, forHour, stale, note };
}

/** Agent 2 endpoint (Exploration & Decision), with the shared context layer applied first. */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = recommendStopsRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "schema validation failed", issues: parsed.error.issues }, { status: 422 });
  }
  const request: RecommendStopsRequest = parsed.data;

  const trace: ToolTraceEntry[] = [];
  const timed = async <T,>(tool: string, input: string, fn: () => Promise<T>, summarize: (r: T) => string, provenance?: ToolTraceEntry["provenance"]) => {
    const t0 = Date.now();
    try {
      const r = await fn();
      trace.push({ tool, input, output: summarize(r), provenance, ms: Date.now() - t0 });
      return r;
    } catch (err) {
      trace.push({ tool, input, output: `failed: ${(err as Error).message}`, provenance: "unavailable", ms: Date.now() - t0 });
      throw err;
    }
  };

  // ---- Context layer: route, positions + weather at each car now ----
  const ctx = request.context;
  const tripCtx = ctx;
  const sessionId = ctx?.sessionId ?? "anon";
  const realData = ctx?.dataMode === "real";
  let route: RouteModel = TORONTO_MONTREAL;
  if (ctx) {
    try {
      route = await timed("route.lookup", ctx.route.id, () => routeModelForRef(ctx.route, sessionId), (m) => `${m.totalKm.toFixed(0)} km, ${m.exits().length} exits (${m.source})`);
    } catch (err) {
      return NextResponse.json({ error: `route unavailable: ${(err as Error).message}`, toolTrace: trace }, { status: 503 });
    }
  }
  const timeZone = ctx?.timeZone ?? "America/Toronto";
  const weatherMode = request.options?.weatherMode ?? "simulated";
  const weather = getWeatherProvider(weatherMode, timeZone);
  const localDate = request.trip.localDate ?? todayLocalDate(new Date(), timeZone);
  const nowLocal = `${localDate}T${request.trip.localTime}`;
  const cars = request.cars.map((c) => {
    if (c.lat != null && c.lng != null) return c;
    const p = route.pointAtKm(c.progressKm);
    return { ...c, lat: p.lat, lng: p.lng, headingDeg: p.headingDeg };
  });
  const carWeather = (
    await timed(
      "weather.cars",
      `${cars.length} car(s) @ ${nowLocal}`,
      () => weather.getReadings(cars.map((c) => ({ id: c.id, lat: c.lat!, lng: c.lng!, localDateTime: nowLocal })), request.environment.weather),
      (r) => r.map((w) => `${w.id}: ${w.description}${w.tempC != null ? ` ${Math.round(w.tempC)}°C` : ""} [${w.source}]`).join("; "),
      weatherMode === "live" ? "live" : "simulated"
    )
  ).map(snap);
  const lead = cars.find((c) => c.role === "lead") ?? cars[0];
  const leadWeather = carWeather.find((w) => w.id === lead.id);
  const environment = { ...request.environment };
  const contextNotes: string[] = [];
  if (weatherMode === "live" && leadWeather?.source === "open-meteo") {
    environment.weather = leadWeather.condition;
    contextNotes.push(`live weather at lead car: ${leadWeather.description}${leadWeather.tempC != null ? `, ${leadWeather.tempC}°C` : ""} (Open-Meteo ${leadWeather.forHour})`);
  } else if (weatherMode === "live") {
    contextNotes.push(leadWeather?.note ?? "live weather unavailable; simulated weather used");
  }
  const enriched: RecommendStopsRequest = { ...request, cars, environment };

  const stopWeatherFor = async (eligible: EligibleStop[]) => {
    const pts = eligible.slice(0, 8).map((e) => ({
      id: e.stop.id,
      lat: e.stop.lat,
      lng: e.stop.lng,
      localDateTime: addMinutesLocal(localDate, request.trip.localTime, e.arrivalMinutesFromNowByCar[lead.id] ?? e.minutesAheadForLead)
    }));
    const readings = pts.length
      ? await timed(
          "weather.arrival",
          `${pts.length} stop(s) at ETA`,
          () => weather.getReadings(pts, environment.weather),
          (r) => r.map((w) => `${w.id} @${w.forHour.slice(11, 16)} ${w.description} [${w.source}]`).join("; "),
          weatherMode === "live" ? "live" : "simulated"
        )
      : [];
    return Object.fromEntries(readings.map((r) => [r.id, snap(r)]));
  };

  // ---- Agent 2 ----
  const provider = getAiProvider();
  const urgency = urgencyForRequest(enriched);
  let realPlaces: RoutePlaceProvider | null = null;
  let placeProvider: PlaceProvider = getPlaceProvider();
  if (realData) {
    realPlaces = new RoutePlaceProvider(route, { sessionId, tomtomVerifyTop: ctx?.tomtomVerifyTop ?? 0 });
    const rp = realPlaces;
    const windows = windowsForDecision(lead.progressKm, lead.speedKph, HORIZON[urgency.level].maxKm, route.totalKm, request.config.advanceNoticeMinutes);
    // Urgency-bounded, selective discovery: "initial" only searches the horizon windows ahead.
    placeProvider = {
      name: rp.name,
      isMock: false,
      async getCandidates(pass, o) {
        const ws = pass === "initial" ? windows : [{ minKm: Math.max(o.minKm, lead.progressKm), maxKm: Math.min(o.maxKm, route.totalKm) }];
        const out: StopCandidate[] = [];
        for (const w of ws) {
          const found = await timed(
            `places.osm.${pass}`,
            `km ${w.minKm.toFixed(0)}–${w.maxKm.toFixed(0)} needs [${o.needs.join(", ") || "any"}]`,
            () => rp.getCandidates(pass, { ...o, ...w }),
            (r) => `${r.length} real place(s) (live/cached per tile: see discovery detail)`
          );
          out.push(...found.filter((f) => !out.some((x) => x.id === f.id)));
        }
        return out;
      }
    };
  }
  const providerNote = { value: provider.name };
  let stopWeather: Record<string, WeatherSnapshot> = {};
  let eligibleSeen: EligibleStop[] = [];
  const llmResolver = async (ctx: {
    eligible: EligibleStop[];
    rejected: RejectionReason[];
    triggerReasons: string[];
    urgency: UrgencyResult;
    exploration: string[];
  }) => {
    eligibleSeen = ctx.eligible;
    stopWeather = await stopWeatherFor(ctx.eligible);
    const t0 = Date.now();
    try {
      const decision = await provider.decide({
        trip: enriched.trip,
        config: enriched.config,
        cars: enriched.cars,
        intent: enriched.collectiveIntent,
        environment,
        eligible: ctx.eligible,
        rejected: ctx.rejected,
        triggerReasons: ctx.triggerReasons,
        urgency: ctx.urgency,
        exploration: [...contextNotes, ...ctx.exploration],
        weatherAtArrival: stopWeather,
        weatherAtCars: carWeather,
        tripContext: tripCtx?.agentContext,
        preferences: tripCtx ? { mood: tripCtx.mood, mealPreference: tripCtx.mealPreference, customMeal: tripCtx.customMeal } : undefined
      });
      trace.push({
        tool: `agent2.${provider.isMock ? "mock" : "llm"}`,
        input: `${ctx.eligible.length} validated candidate(s), urgency ${ctx.urgency.level}`,
        output: `${decision.action}: ${decision.picks.map((p) => p.stopId).join(", ") || "—"}`,
        provenance: provider.isMock ? "simulated" : "live",
        ms: Date.now() - t0
      });
      return decision;
    } catch (err) {
      trace.push({ tool: "agent2.llm", input: provider.name, output: `failed: ${(err as Error).message}`, provenance: "unavailable", ms: Date.now() - t0 });
      providerNote.value = `${provider.name} failed (${(err as Error).message}); deterministic fallback used`;
      console.warn(`[ai:decision] ${providerNote.value}`);
      return null;
    }
  };

  const result = await decideWithExploration(enriched, placeProvider, provider.name, provider.isMock, llmResolver, {
    destinationKm: route.totalKm
  });
  if (realPlaces) for (const line of realPlaces.trace) trace.push({ tool: "places.osm.detail", input: "", output: line });
  const recommended = result.recommendations.map((r) => r.stopId);
  const stops = recommended.map((id) => stopWeather[id]).filter((w): w is WeatherSnapshot => Boolean(w));
  return NextResponse.json({
    ...result,
    provider: providerNote.value,
    exploration: [...contextNotes, ...result.exploration],
    weather: { mode: weatherMode, cars: carWeather, stops },
    recommendedStops: recommended.map((id) => eligibleSeen.find((e) => e.stop.id === id)?.stop).filter(Boolean),
    toolTrace: trace,
    usage: (getBudget("tomtom"), allUsage(sessionId)),
    dataMode: ctx?.dataMode ?? "demo"
  });
}
