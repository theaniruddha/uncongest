import { NextResponse } from "next/server";
import { recommendStopsRequestSchema } from "@/lib/domain/schemas";
import { decideWithExploration } from "@/lib/domain/engine";
import type { EligibleStop, RecommendStopsRequest, RejectionReason, WeatherSnapshot } from "@/lib/domain/types";
import type { UrgencyResult } from "@/lib/domain/urgency";
import { getAiProvider } from "@/lib/providers/ai";
import { getPlaceProvider } from "@/lib/providers/places";
import { addMinutesLocal, getWeatherProvider, todayLocalDate, type WeatherReading } from "@/lib/providers/weather";
import { pointAtKm, ROUTE } from "@/lib/route/route";

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

  // ---- Context layer: positions + weather at each car now ----
  const weatherMode = request.options?.weatherMode ?? "simulated";
  const weather = getWeatherProvider(weatherMode);
  const localDate = request.trip.localDate ?? todayLocalDate();
  const nowLocal = `${localDate}T${request.trip.localTime}`;
  const cars = request.cars.map((c) => {
    if (c.lat != null && c.lng != null) return c;
    const p = pointAtKm(c.progressKm);
    return { ...c, lat: p.lat, lng: p.lng, headingDeg: p.headingDeg };
  });
  const carWeather = (
    await weather.getReadings(
      cars.map((c) => ({ id: c.id, lat: c.lat!, lng: c.lng!, localDateTime: nowLocal })),
      request.environment.weather
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
    const readings = pts.length ? await weather.getReadings(pts, environment.weather) : [];
    return Object.fromEntries(readings.map((r) => [r.id, snap(r)]));
  };

  // ---- Agent 2 ----
  const provider = getAiProvider();
  const placeProvider = getPlaceProvider();
  const providerNote = { value: provider.name };
  let stopWeather: Record<string, WeatherSnapshot> = {};
  const llmResolver = async (ctx: {
    eligible: EligibleStop[];
    rejected: RejectionReason[];
    triggerReasons: string[];
    urgency: UrgencyResult;
    exploration: string[];
  }) => {
    stopWeather = await stopWeatherFor(ctx.eligible);
    try {
      return await provider.decide({
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
        weatherAtCars: carWeather
      });
    } catch (err) {
      providerNote.value = `${provider.name} failed (${(err as Error).message}); deterministic fallback used`;
      console.warn(`[ai:decision] ${providerNote.value}`);
      return null;
    }
  };

  const result = await decideWithExploration(enriched, placeProvider, provider.name, provider.isMock, llmResolver, {
    destinationKm: ROUTE.totalKm
  });
  const recommended = result.recommendations.map((r) => r.stopId);
  const stops = recommended.map((id) => stopWeather[id]).filter((w): w is WeatherSnapshot => Boolean(w));
  return NextResponse.json({
    ...result,
    provider: providerNote.value,
    exploration: [...contextNotes, ...result.exploration],
    weather: { mode: weatherMode, cars: carWeather, stops }
  });
}
