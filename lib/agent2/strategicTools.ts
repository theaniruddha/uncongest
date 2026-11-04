import { allFixtureStops } from "@/lib/providers/places";
import type { Need, StopCandidate } from "@/lib/domain/types";
import { MEAL_WINDOWS } from "@/lib/domain/urgency";
import { haversineKm, type RouteModel } from "@/lib/route/model";
import { prefetchWindows, type KmWindow } from "@/lib/providers/routePlaces";
import { getWeatherProvider } from "@/lib/providers/weather";
import { formatInZone, utcToLocal } from "@/lib/trip/daylight";
import { arrivalDaylight } from "@/lib/trip/eta";
import { opportunityWindows } from "@/lib/trip/opportunityWindows";
import type { TripRoute } from "@/lib/trip/types";
import type { StrategicInput } from "./strategic";

/* ------------------------------------------------------------------------------------------
 * Agent 2 · Strategic Planner — typed specialist tools (deterministic; no LLM).
 * Each tool returns ONE evidence item; runTools() runs them with bounded concurrency and a
 * per-tool timeout and assigns ids e1..eN in tool order.
 * ---------------------------------------------------------------------------------------- */

export type EvidenceProvenance = "live" | "cached" | "recorded" | "simulated" | "unavailable";

export type ToolName = "futureWindows" | "placesInWindows" | "weatherAtWaypoints" | "destinationArrival" | "routeAlternatives" | "borderCrossing";

export const TOOL_ORDER: ToolName[] = ["futureWindows", "placesInWindows", "weatherAtWaypoints", "destinationArrival", "routeAlternatives", "borderCrossing"];

export interface ToolResult<D = unknown> {
  tool: ToolName;
  summary: string;
  provenance: EvidenceProvenance;
  data: D;
}

export interface Evidence<D = unknown> extends ToolResult<D> {
  id: string;
}

export interface ToolTraceItem {
  tool: string;
  input: string;
  output: string;
  provenance?: string;
  ms?: number;
}

/** Compact place record handed to the planner (ids are real provider ids). */
export interface CompactPlace {
  id: string;
  name: string;
  km: number;
  categories: Need[];
  exit?: string;
  restroomsVerified: boolean | null;
  vegOptions?: string;
  open24h: boolean;
  offRouteKm?: number;
  isMock?: boolean;
  source?: string;
}

export interface FutureWindow {
  id: string;
  fromKm: number;
  toKm: number;
  kinds: Array<"meal" | "coffee" | "rest_break">;
  reason: string;
  expectedLocalFrom: string;
  expectedLocalTo: string;
}

export interface FutureWindowsData {
  windows: FutureWindow[];
  cruiseSpeedKph: number;
}

export interface PlacesData {
  searched: KmWindow[];
  /** coverage: fraction (0–1) of the window covered by searched place tiles. */
  perWindow: Array<{ windowId: string; fromKm: number; toKm: number; counts: Record<Need, number>; coverage: number }>;
  gaps: Array<{ fromKm: number; toKm: number; lengthKm: number }>;
  candidates: CompactPlace[];
}

export interface WeatherData {
  points: Array<{ id: string; km: number; localTime: string; description: string; tempC: number | null; precipProbability: number | null; source: string; condition: string; recordedAt?: string | null; note?: string }>;
}

export interface ArrivalData {
  arrivalLocal: string;
  arrivalElapsed: number;
  remainingKm: number;
  sunsetLocal: string | null;
  afterDark: boolean;
  minutesAfterSunset: number | null;
  destinationType: string;
  destinationKm: number;
}

export interface AlternativesData {
  mainDistanceKm: number | null;
  mainDurationMinutes: number | null;
  alternatives: Array<{ id: string; summary: string; deltaMinutes: number; deltaKm: number; avoidsCrossings: string[] }>;
  mainBorderCrossings: Array<{ km: number; name: string | null }>;
}

export interface BorderData {
  crossings: Array<{ km: number; name: string | null; beforeCount: number; afterCount: number; beforeIds: string[]; afterIds: string[] }>;
  candidates: CompactPlace[];
}

/** Everything the tools may read. Built once per planner run by strategic.ts. */
export interface ToolContext {
  input: StrategicInput;
  route: RouteModel;
  /** The full stored TripRoute (alternatives, border crossings), when known. */
  tripRoute: TripRoute | null;
  /** Deterministic future windows (computed before tools run; shared by several tools). */
  windows: FutureWindow[];
  cruiseSpeedKph: number;
  nowUtc: Date;
  fetchImpl?: typeof fetch;
}

export type ToolImpl = (ctx: ToolContext) => Promise<ToolResult>;
export type ToolImpls = Record<ToolName, ToolImpl>;

export const TOOL_TIMEOUT_MS = 12_000;
export const TOOL_CONCURRENCY = 3;
const GAP_KM = 60;
const MAX_WINDOW_KM = 80;
const BORDER_RADIUS_KM = 40;

const r0 = (x: number) => Math.round(x);
const r1 = (x: number) => Math.round(x * 10) / 10;
const clip = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
const hhmm = (min: number) => {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

/** Cruise speed for projections: the lead's current speed when moving, else a highway default. */
export function cruiseSpeedFor(input: StrategicInput): number {
  if (input.cruiseSpeedKph && input.cruiseSpeedKph > 0) return input.cruiseSpeedKph;
  return input.leadSpeedKph >= 40 ? input.leadSpeedKph : 95;
}

/** Minutes from now until the lead reaches `km` (0 if behind). */
export function minutesToKm(ctx: Pick<ToolContext, "input" | "cruiseSpeedKph">, km: number): number {
  return Math.max(0, ((km - ctx.input.leadKm) / Math.max(ctx.cruiseSpeedKph, 1)) * 60);
}

export function localAtKm(ctx: Pick<ToolContext, "input" | "cruiseSpeedKph">, km: number): string {
  return hhmm(toMin(ctx.input.localTime) + minutesToKm(ctx, km));
}

/* ------------------------------------------------------------------ future windows */

/**
 * Deterministic future windows over the REMAINING route: opportunityWindows() from the lead's
 * position/local time, plus meal windows (MEAL_WINDOWS) against projected local times and a
 * rest window adjusted by driving minutes since the last rest. ≤ 3 windows, merged, km-ordered.
 */
export function computeFutureWindows(input: StrategicInput, route: RouteModel, cruiseSpeedKph: number): FutureWindow[] {
  const ctx = { input, cruiseSpeedKph };
  const lead = route.clampKm(input.leadKm);
  const remaining = route.totalKm - lead;
  if (remaining <= 1) return [];
  const speed = Math.max(cruiseSpeedKph, 1);
  const kmAfter = (min: number) => Math.min(lead + (min / 60) * speed, route.totalKm);
  const noticeKm = kmAfter(10);
  const nowMin = toMin(input.localTime);
  const driveMin = (remaining / speed) * 60;
  type Raw = { fromKm: number; toKm: number; kinds: FutureWindow["kinds"]; reason: string };
  const raw: Raw[] = [];

  // Base windows from the shared deterministic helper (offset to the lead's position).
  const lastMealTime =
    input.lastMealMinutesAgo != null ? hhmm(nowMin - input.lastMealMinutesAgo) : input.mealHistory.kind === "last_meal_at" ? input.mealHistory.time : undefined;
  const base = opportunityWindows({
    routeKm: remaining,
    speedKph: speed,
    departureLocal: input.localTime,
    mood: input.mood,
    mealPreference: input.mealPreference,
    mealHistory: lastMealTime ? { kind: "last_meal_at", time: lastMealTime } : input.mealHistory.kind === "already_ate" ? { kind: "already_ate" } : { kind: "unknown" }
  });
  for (const w of base) {
    // Rest windows from opportunityWindows assume a fresh start; ours are recomputed below.
    if (/rest break/.test(w.reason) && !/window|coffee/.test(w.reason)) continue;
    const kinds: FutureWindow["kinds"] = [];
    if (/lunch|dinner/.test(w.reason)) kinds.push("meal");
    if (/coffee/.test(w.reason)) kinds.push("coffee");
    if (/rest/.test(w.reason)) kinds.push("rest_break");
    raw.push({ fromKm: lead + w.minKm, toKm: lead + w.maxKm, kinds: kinds.length ? kinds : ["rest_break"], reason: w.reason });
  }

  // Meal windows vs projected local time (today and, for long drives, tomorrow) — covers the
  // case where we are already inside a meal window (opportunityWindows starts at notice).
  const ateRecently = input.lastMealMinutesAgo != null && input.lastMealMinutesAgo < 150;
  if (!ateRecently && input.mealHistory.kind !== "already_ate") {
    for (const day of [0, 1440]) {
      for (const w of MEAL_WINDOWS) {
        const start = w.start + day - nowMin;
        const end = w.end + day - nowMin;
        if (end <= 10 || start >= driveMin) continue;
        const fromKm = Math.max(kmAfter(Math.max(start, 0)), noticeKm);
        const toKm = Math.min(kmAfter(Math.min(end, driveMin)), fromKm + 90);
        if (toKm - fromKm >= 5) raw.push({ fromKm, toKm, kinds: ["meal"], reason: `${w.name} window` });
      }
    }
  }

  // Rest break: due at 90 (tired / kids) or 120 min of continuous driving.
  const restAt = input.mood.includes("tired") || input.kids ? 90 : 120;
  const restIn = Math.max(restAt - input.drivingMinutesSinceRest, 10);
  if (restIn < driveMin - 10) {
    raw.push({ fromKm: kmAfter(Math.max(restIn - 20, 10)), toKm: kmAfter(restIn + 20), kinds: ["rest_break"], reason: `rest break due after ~${restAt} min of driving` });
  }

  raw.sort((a, b) => a.fromKm - b.fromKm);
  const merged: Raw[] = [];
  for (const w of raw) {
    const last = merged[merged.length - 1];
    if (last && w.fromKm <= last.toKm + 5) {
      last.toKm = Math.max(last.toKm, w.toKm);
      for (const k of w.kinds) if (!last.kinds.includes(k)) last.kinds.push(k);
      if (!last.reason.includes(w.reason)) last.reason = `${last.reason} + ${w.reason}`;
    } else merged.push({ ...w, kinds: [...w.kinds] });
  }
  return merged
    .filter((w) => w.toKm > lead && w.toKm - w.fromKm >= 2)
    .slice(0, 3)
    .map((w, i) => ({
      id: `w${i + 1}`,
      fromKm: r1(route.clampKm(Math.max(w.fromKm, lead))),
      // Cap merged windows so place lookups stay small (≤ 3 tiles per window).
      toKm: r1(route.clampKm(Math.min(w.toKm, Math.max(w.fromKm, lead) + MAX_WINDOW_KM))),
      kinds: w.kinds,
      reason: w.reason,
      expectedLocalFrom: localAtKm(ctx, w.fromKm),
      expectedLocalTo: localAtKm(ctx, Math.min(w.toKm, Math.max(w.fromKm, lead) + MAX_WINDOW_KM))
    }));
}

async function futureWindowsTool(ctx: ToolContext): Promise<ToolResult<FutureWindowsData>> {
  const ws = ctx.windows;
  const summary = ws.length
    ? ws.map((w) => `${w.id} km ${r0(w.fromKm)}–${r0(w.toKm)} (${w.expectedLocalFrom}–${w.expectedLocalTo}): ${w.reason}`).join("; ")
    : "No meal/rest windows fall on the remaining route.";
  return { tool: "futureWindows", summary: clip(summary), provenance: "simulated", data: { windows: ws, cruiseSpeedKph: ctx.cruiseSpeedKph } };
}

/* ------------------------------------------------------------------ places */

const NEEDS: Need[] = ["meal", "coffee", "restroom", "grocery", "ev_charge"];

export function compactPlace(c: StopCandidate): CompactPlace {
  return {
    id: c.id,
    isMock: c.isMock,
    source: c.isMock ? "fictional demo fixture" : c.source,
    name: c.name,
    km: r1(c.distanceAlongRouteKm),
    categories: c.categories,
    exit: c.exitLabel,
    restroomsVerified: c.restroomsVerified,
    vegOptions: c.categories.includes("meal") ? c.vegOptions : undefined,
    open24h: c.open24h,
    offRouteKm: c.offRouteKm != null ? r1(c.offRouteKm) : undefined
  };
}

/** Food or restroom-capable stop (what a group needs on a long stretch). */
export function isFoodOrRestroom(p: Pick<CompactPlace, "categories" | "restroomsVerified">): boolean {
  return p.categories.includes("meal") || p.categories.includes("restroom") || p.restroomsVerified === true;
}

/** Tiles that actually returned data ("prefetch km A–B: N place(s), live|cached"); failed / not-cached tiles are unknown, NOT empty. */
export function coveredTiles(trace: string[]): KmWindow[] {
  const out: KmWindow[] = [];
  for (const t of trace) {
    const m = /prefetch km (\d+(?:\.\d+)?)–(\d+(?:\.\d+)?): \d+ place\(s\), (live|cached)/.exec(t);
    if (m) out.push({ minKm: Number(m[1]), maxKm: Number(m[2]) });
  }
  return out;
}

function coverageOf(w: KmWindow, tiles: KmWindow[]): number {
  const len = Math.max(w.maxKm - w.minKm, 1e-6);
  let covered = 0;
  for (const t of tiles) covered += Math.max(0, Math.min(w.maxKm, t.maxKm) - Math.max(w.minKm, t.minKm));
  return Math.min(1, covered / len);
}

function provenanceFromTrace(trace: string[]): EvidenceProvenance {
  if (trace.some((t) => /\blive\b/.test(t))) return "live";
  if (trace.some((t) => /\bcached\b/.test(t))) return "cached";
  if (trace.some((t) => /tomtom along-route fallback: \d+/.test(t))) return "live";
  return "unavailable";
}

/** Gaps ≥ 60 km without a food/restroom place inside the searched (contiguous) coverage. */
export function findGaps(searched: KmWindow[], places: CompactPlace[], minGapKm = GAP_KM): PlacesData["gaps"] {
  const segs = [...searched].sort((a, b) => a.minKm - b.minKm);
  const cover: KmWindow[] = [];
  for (const s of segs) {
    const last = cover[cover.length - 1];
    if (last && s.minKm <= last.maxKm + 0.5) last.maxKm = Math.max(last.maxKm, s.maxKm);
    else cover.push({ ...s });
  }
  const good = places.filter(isFoodOrRestroom).map((p) => p.km).sort((a, b) => a - b);
  const gaps: PlacesData["gaps"] = [];
  for (const c of cover) {
    const pts = [c.minKm, ...good.filter((k) => k >= c.minKm && k <= c.maxKm), c.maxKm];
    for (let i = 1; i < pts.length; i++) {
      const len = pts[i] - pts[i - 1];
      if (len >= minGapKm) gaps.push({ fromKm: r1(pts[i - 1]), toKm: r1(pts[i]), lengthKm: r0(len) });
    }
  }
  return gaps;
}

async function placesInWindowsTool(ctx: ToolContext): Promise<ToolResult<PlacesData>> {
  const windows = ctx.windows.slice(0, 3);
  if (ctx.input.dataMode === "demo") {
    const searched = windows.map((w) => ({ minKm: w.fromKm, maxKm: w.toKm }));
    const places = allFixtureStops()
      .filter((c) => c.distanceAlongRouteKm > ctx.input.leadKm && windows.some((w) => c.distanceAlongRouteKm >= w.fromKm - 3 && c.distanceAlongRouteKm <= w.toKm + 3))
      .map(compactPlace);
    const perWindow = windows.map((w) => ({
      windowId: w.id, fromKm: w.fromKm, toKm: w.toKm,
      counts: Object.fromEntries(NEEDS.map((n) => [n, places.filter((p) => p.km >= w.fromKm - 3 && p.km <= w.toKm + 3 && p.categories.includes(n)).length])) as Record<Need, number>,
      coverage: 1
    }));
    return { tool: "placesInWindows", summary: `Mock · ${places.length} fictional demo fixture place(s) in future windows; facilities and hours are authored scenario assumptions.`, provenance: "simulated", data: { searched, perWindow, gaps: [], candidates: places } };
  }
  if (windows.length === 0) {
    return { tool: "placesInWindows", summary: "No future windows to search.", provenance: "simulated", data: { searched: [], perWindow: [], gaps: [], candidates: [] } };
  }
  const kmWindows = windows.map((w) => ({ minKm: w.fromKm, maxKm: w.toKm }));
  // Cache-only so a slow Overpass never eats the Muse budget; a live lookup warms the cache in the background.
  const { trace, candidates } = await prefetchWindows(ctx.route, kmWindows, { sessionId: ctx.input.sessionId, fetchImpl: ctx.fetchImpl, cacheOnly: !ctx.fetchImpl });
  if (!ctx.fetchImpl) void prefetchWindows(ctx.route, kmWindows, { sessionId: ctx.input.sessionId }).catch(() => undefined);
  const provenance = provenanceFromTrace(trace);
  const lead = ctx.input.leadKm;
  const places = candidates.filter((c) => c.distanceAlongRouteKm > lead && !c.isMock).map(compactPlace);
  const tiles = coveredTiles(trace);
  const perWindow = windows.map((w) => {
    const inW = places.filter((p) => p.km >= w.fromKm - 3 && p.km <= w.toKm + 3);
    const counts = Object.fromEntries(NEEDS.map((n) => [n, inW.filter((p) => p.categories.includes(n)).length])) as Record<Need, number>;
    return { windowId: w.id, fromKm: w.fromKm, toKm: w.toKm, counts, coverage: coverageOf({ minKm: w.fromKm, maxKm: w.toKm }, tiles) };
  });
  // Coverage = tiles that actually returned data. Un-fetched stretches are UNKNOWN, never "no services".
  const searched = tiles.map((t) => ({ minKm: Math.max(t.minKm, lead), maxKm: t.maxKm })).filter((t) => t.maxKm > t.minKm);
  const gaps = findGaps(searched, places);
  const anyCovered = searched.length > 0;
  const summary = !anyCovered
    ? `Place data for km ${windows.map((w) => `${r0(w.fromKm)}–${r0(w.toKm)}`).join(", ")} not available yet (being fetched in the background) — counts unknown, do NOT assume there are no services.`
    : perWindow
        .map((p) =>
          p.coverage < 0.5
            ? `${p.windowId} km ${r0(p.fromKm)}–${r0(p.toKm)}: counts unknown (only ${Math.round(p.coverage * 100)}% searched)`
            : `${p.windowId} km ${r0(p.fromKm)}–${r0(p.toKm)}: ${p.counts.meal} meal, ${p.counts.coffee} coffee, ${p.counts.restroom} restroom${p.coverage < 1 ? ` (${Math.round(p.coverage * 100)}% searched)` : ""}`
        )
        .join("; ") + (gaps.length ? `; gaps ≥ ${GAP_KM} km without food/restroom in searched stretches: ${gaps.map((g) => `km ${r0(g.fromKm)}–${r0(g.toKm)}`).join(", ")}` : "");
  return { tool: "placesInWindows", summary: clip(summary), provenance: anyCovered ? provenance : "unavailable", data: { searched, perWindow, gaps, candidates: places } };
}

/* ------------------------------------------------------------------ weather */

async function weatherAtWaypointsTool(ctx: ToolContext): Promise<ToolResult<WeatherData>> {
  const lead = ctx.input.leadKm;
  const total = ctx.route.totalKm;
  const remaining = total - lead;
  if (remaining <= 1) return { tool: "weatherAtWaypoints", summary: "At destination; no waypoints ahead.", provenance: "simulated", data: { points: [] } };
  const kms: number[] = [];
  const n = Math.min(5, Math.max(1, Math.floor(remaining / 40)));
  for (let i = 1; i <= n; i++) kms.push(lead + (remaining * i) / (n + 1));
  kms.push(total);
  const pts = kms.map((km, i) => {
    const p = ctx.route.pointAtKm(km);
    const at = new Date(ctx.nowUtc.getTime() + minutesToKm(ctx, km) * 60_000);
    const local = utcToLocal(at, ctx.input.timeZone);
    return { id: i === kms.length - 1 ? "destination" : `wp${i + 1}`, km, lat: p.lat, lng: p.lng, localDateTime: `${local.date}T${local.time}` };
  });
  const mode = ctx.input.dataMode === "demo" ? "simulated" : "live";
  const readings = await getWeatherProvider(mode, ctx.input.timeZone).getReadings(
    pts.map(({ id, lat, lng, localDateTime }) => ({ id, lat, lng, localDateTime })),
    ctx.input.weatherCondition ?? "cloudy"
  );
  const points = readings.map((r, i) => ({
    id: r.id,
    km: r0(pts[i].km),
    localTime: pts[i].localDateTime.slice(11, 16),
    description: r.description,
    tempC: r.tempC,
    precipProbability: r.precipProbability,
    source: r.source,
    condition: r.condition,
    recordedAt: r.fetchedAt,
    note: r.note
  }));
  const live = points.filter((p) => p.source === "open-meteo");
  const simulated = points.filter((p) => p.source === "simulated");
  const provenance: EvidenceProvenance = live.length ? "live" : simulated.length ? "simulated" : "unavailable";
  const summary = live.length
    ? live
        .map((p) => `${p.id === "destination" ? "destination" : `km ${p.km}`} ${p.localTime}: ${p.description}${p.tempC != null ? ` ${Math.round(p.tempC)}°C` : ""}${p.precipProbability != null ? ` ${p.precipProbability}% precip` : ""}`)
        .join("; ")
    : simulated.length ? `Mock weather snapshot: ${simulated[0].description}; ${simulated[0].note ?? "simulated scenario, not a live forecast"}` : "Forecast unavailable along the remaining route (no live readings).";
  return { tool: "weatherAtWaypoints", summary: clip(summary), provenance, data: { points: live.length ? live : simulated } };
}

/* ------------------------------------------------------------------ arrival */

async function destinationArrivalTool(ctx: ToolContext): Promise<ToolResult<ArrivalData>> {
  const total = ctx.route.totalKm;
  const remainingKm = Math.max(0, total - ctx.input.leadKm);
  const minutes = minutesToKm(ctx, total);
  const arrivalUtc = new Date(ctx.nowUtc.getTime() + minutes * 60_000);
  const dest = ctx.input.routeRef.destination;
  const d = arrivalDaylight({ arrivalUtc, destLat: dest.lat, destLng: dest.lng, timeZone: ctx.input.timeZone });
  const arrivalLocal = formatInZone(arrivalUtc, ctx.input.timeZone);
  const data: ArrivalData = {
    arrivalLocal,
    arrivalElapsed: r0(ctx.input.elapsedMinutes + minutes),
    remainingKm: r0(remainingKm),
    sunsetLocal: d.sunsetLocal,
    afterDark: d.afterDark,
    minutesAfterSunset: d.minutesAfterSunset,
    destinationType: dest.type,
    destinationKm: r1(total)
  };
  const summary = `Arrive ${dest.label} (${dest.type}) ~${arrivalLocal} without further stops, ${r0(remainingKm)} km left; sunset ${d.sunsetLocal ?? "n/a"}${d.afterDark ? `, arrival after dark (${d.minutesAfterSunset} min after sunset)` : ", arrival in daylight"}.`;
  return { tool: "destinationArrival", summary: clip(summary), provenance: "simulated", data };
}

/* ------------------------------------------------------------------ alternatives */

function minDistanceKm(coords: Array<[number, number]>, lng: number, lat: number): number {
  let best = Infinity;
  for (const c of coords) best = Math.min(best, haversineKm(c, [lng, lat]));
  return best;
}

async function routeAlternativesTool(ctx: ToolContext): Promise<ToolResult<AlternativesData>> {
  const tr = ctx.tripRoute;
  if (!tr) {
    return {
      tool: "routeAlternatives",
      summary: "Stored route details (alternatives, border crossings) unavailable for this route id.",
      provenance: "unavailable",
      data: { mainDistanceKm: null, mainDurationMinutes: null, alternatives: [], mainBorderCrossings: [] }
    };
  }
  const crossings = (tr.borderCrossings ?? []).map((b) => ({ km: r1(b.km), name: b.name }));
  const alternatives = (tr.alternatives ?? []).map((a) => ({
    id: a.id,
    summary: a.summary,
    deltaMinutes: r0(a.durationMinutes - tr.durationMinutes),
    deltaKm: r0(a.distanceKm - tr.distanceKm),
    avoidsCrossings: (tr.borderCrossings ?? [])
      .filter((b) => a.coordinates.length > 1 && minDistanceKm(a.coordinates, b.lng, b.lat) > 3)
      .map((b) => b.name ?? `crossing at km ${r0(b.km)}`)
  }));
  const provenance: EvidenceProvenance = tr.source === "osrm" ? "cached" : "recorded";
  const parts = [
    alternatives.length
      ? alternatives.map((a) => `alt ${a.id} (${a.summary}): ${a.deltaMinutes >= 0 ? "+" : ""}${a.deltaMinutes} min, ${a.deltaKm >= 0 ? "+" : ""}${a.deltaKm} km${a.avoidsCrossings.length ? `, avoids ${a.avoidsCrossings.join(", ")}` : ""}`).join("; ")
      : "no alternative routes returned",
    crossings.length ? `main route crosses a border at ${crossings.map((c) => `km ${r0(c.km)}${c.name ? ` (${c.name})` : ""}`).join(", ")}` : "no border crossing on main route"
  ];
  return {
    tool: "routeAlternatives",
    summary: clip(parts.join("; ")),
    provenance,
    data: { mainDistanceKm: r1(tr.distanceKm), mainDurationMinutes: r0(tr.durationMinutes), alternatives, mainBorderCrossings: crossings }
  };
}

/* ------------------------------------------------------------------ border crossing */

async function borderCrossingTool(ctx: ToolContext): Promise<ToolResult<BorderData>> {
  const ahead = (ctx.tripRoute?.borderCrossings ?? []).filter((b) => b.km > ctx.input.leadKm).slice(0, 2);
  if (ahead.length === 0) {
    return { tool: "borderCrossing", summary: "No border crossing ahead on the current route.", provenance: ctx.tripRoute ? "cached" : "unavailable", data: { crossings: [], candidates: [] } };
  }
  if (ctx.input.dataMode === "demo") {
    return {
      tool: "borderCrossing",
      summary: `Border crossing ahead at km ${ahead.map((b) => r0(b.km)).join(", ")}; place counts skipped in demo mode.`,
      provenance: "cached",
      data: { crossings: ahead.map((b) => ({ km: r1(b.km), name: b.name, beforeCount: 0, afterCount: 0, beforeIds: [], afterIds: [] })), candidates: [] }
    };
  }
  const windows = ahead.map((b) => ({ minKm: Math.max(b.km - BORDER_RADIUS_KM, ctx.input.leadKm), maxKm: Math.min(b.km + BORDER_RADIUS_KM, ctx.route.totalKm) }));
  // Cache-only so a slow Overpass never eats the Muse budget; a live lookup warms the cache in the background.
  const { trace, candidates } = await prefetchWindows(ctx.route, windows, { sessionId: ctx.input.sessionId, fetchImpl: ctx.fetchImpl, cacheOnly: !ctx.fetchImpl });
  if (!ctx.fetchImpl) void prefetchWindows(ctx.route, windows, { sessionId: ctx.input.sessionId }).catch(() => undefined);
  const tilesB = coveredTiles(trace);
  // Counts are only meaningful if both sides of each crossing were actually searched.
  const bothSidesCovered = ahead.every((b, i) => coverageOf({ minKm: windows[i].minKm, maxKm: b.km }, tilesB) >= 0.6 && coverageOf({ minKm: b.km, maxKm: windows[i].maxKm }, tilesB) >= 0.6);
  const provenance = bothSidesCovered ? provenanceFromTrace(trace) : "unavailable";
  const places = candidates.filter((c) => c.distanceAlongRouteKm > ctx.input.leadKm && !c.isMock).map(compactPlace).filter(isFoodOrRestroom);
  const crossings = ahead.map((b, i) => {
    const before = places.filter((p) => p.km >= windows[i].minKm && p.km < b.km);
    const after = places.filter((p) => p.km > b.km && p.km <= windows[i].maxKm);
    return {
      km: r1(b.km),
      name: b.name,
      beforeCount: before.length,
      afterCount: after.length,
      beforeIds: before.sort((x, y) => y.km - x.km).slice(0, 4).map((p) => p.id),
      afterIds: after.sort((x, y) => x.km - y.km).slice(0, 4).map((p) => p.id)
    };
  });
  const summary =
    provenance === "unavailable"
      ? `Border crossing ahead at km ${crossings.map((c) => r0(c.km)).join(", ")}; place data near it not available yet — counts unknown.`
      : crossings.map((c) => `Border ${c.name ?? ""} at km ${r0(c.km)}: ${c.beforeCount} food/restroom place(s) within ${BORDER_RADIUS_KM} km before vs ${c.afterCount} after`).join("; ");
  const keep = new Set(crossings.flatMap((c) => [...c.beforeIds, ...c.afterIds]));
  return { tool: "borderCrossing", summary: clip(summary), provenance, data: { crossings, candidates: places.filter((p) => keep.has(p.id)) } };
}

export const DEFAULT_TOOLS: ToolImpls = {
  futureWindows: futureWindowsTool,
  placesInWindows: placesInWindowsTool,
  weatherAtWaypoints: weatherAtWaypointsTool,
  destinationArrival: destinationArrivalTool,
  routeAlternatives: routeAlternativesTool,
  borderCrossing: borderCrossingTool
};

/* ------------------------------------------------------------------ runner */

function toolInput(name: ToolName, ctx: ToolContext): string {
  try {
    return toolInputUnsafe(name, ctx);
  } catch {
    return name;
  }
}

function toolInputUnsafe(name: ToolName, ctx: ToolContext): string {
  switch (name) {
    case "placesInWindows":
      return ctx.windows.map((w) => `km ${r0(w.fromKm)}–${r0(w.toKm)}`).join(", ") || "none";
    case "weatherAtWaypoints":
      return `≤5 waypoints km ${r0(ctx.input.leadKm)}–${r0(ctx.route.totalKm)} + destination, tz ${ctx.input.timeZone}`;
    default:
      return `lead km ${r0(ctx.input.leadKm)} of ${r0(ctx.route.totalKm)}`;
  }
}

/**
 * Run tools with bounded concurrency and a per-tool timeout. A failing / timed-out tool yields
 * an "unavailable" evidence item instead of throwing. Evidence ids are e1..eN in `names` order.
 */
export async function runTools(
  ctx: ToolContext,
  impls: ToolImpls,
  opts: { names?: ToolName[]; concurrency?: number; timeoutMs?: number } = {}
): Promise<{ evidence: Evidence[]; trace: ToolTraceItem[] }> {
  const names = opts.names ?? TOOL_ORDER;
  const limit = Math.max(1, Math.min(opts.concurrency ?? TOOL_CONCURRENCY, TOOL_CONCURRENCY));
  const timeoutMs = Math.min(opts.timeoutMs ?? TOOL_TIMEOUT_MS, TOOL_TIMEOUT_MS);
  const results: Array<{ res: ToolResult; ms: number }> = new Array(names.length);
  let next = 0;
  const runOne = async (idx: number) => {
    const name = names[idx];
    const t0 = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const res = await Promise.race([
        impls[name](ctx),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
        })
      ]);
      results[idx] = { res: { ...res, tool: name, summary: clip(res.summary || "(no summary)") }, ms: Date.now() - t0 };
    } catch (err) {
      results[idx] = { res: { tool: name, summary: clip(`${name} unavailable: ${(err as Error).message}`), provenance: "unavailable", data: null }, ms: Date.now() - t0 };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const workers = Array.from({ length: Math.min(limit, names.length) }, async () => {
    while (next < names.length) await runOne(next++);
  });
  await Promise.all(workers);
  const evidence = results.map((r, i) => ({ id: `e${i + 1}`, ...r.res }));
  const trace = results.map((r, i) => ({ tool: names[i], input: toolInput(names[i], ctx), output: r.res.summary, provenance: r.res.provenance, ms: r.ms }));
  return { evidence, trace };
}
