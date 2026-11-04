"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import SetupPanel, { type PresetOption } from "./SetupPanel";
import RecommendationCard from "./RecommendationCard";
import ActiveStopCard from "./ActiveStopCard";
import Inspector, { type Agent1Trace } from "./Inspector";
import StrategicPanel from "./StrategicPanel";
import RouteOptions, { type RouteOptionView } from "./RouteOptions";
import { useStrategic } from "./useStrategic";
import { summarize, versionHash, type WorkflowSample } from "@/lib/agent2/metrics";
import { checkTacticalStaleness, withoutSkipped } from "@/lib/agent2/staleness";
import { strategicContextVersion, tacticalContextVersion, type VersionInput } from "@/lib/agent2/versions";
import RoadAhead, { type RoadAheadWaypoint } from "../RoadAhead";
import { createRouteModel, haversineKm, type RouteModel } from "@/lib/route/model";
import type { TripRoute, TripSetup, StopPlan } from "@/lib/trip/types";
import { MONTREAL, TORONTO, NAMED_PLACES, SCENARIO_PRESETS, getScenarioPreset } from "@/lib/trip/presets";
import { buildTimeline, carStateOnRoute, placeFollower, placeLead, type TripCar } from "@/lib/trip/sim";
import { arrivalDaylight, defaultDwellMinutes, destinationEta, etaImpactOfStop } from "@/lib/trip/eta";
import { localDateTimeToUtc, sunTimes, utcToLocal, formatInZone } from "@/lib/trip/daylight";
import { ACTIVE_STATUSES, autoAdvance, stopReducer, type StopAction } from "@/lib/trip/stopLifecycle";
import { buildAgentContext } from "@/lib/context/builder";
import { opportunityWindows } from "@/lib/trip/opportunityWindows";
import { applyIntentUpdate, clearCoveredNeeds, emptyCarIntent, regexIntentUpdate, toCollective, type CarIntent, type IntentAgentOutput } from "@/lib/domain/carIntent";
import { evaluateUrgency, HORIZON, maxUrgency, type UrgencyLevel, type UrgencyResult } from "@/lib/domain/urgency";
import { EMPTY_MEMORY, watch, type WatchMemory } from "@/lib/domain/watcher";
import { allFixtureStops } from "@/lib/providers/places";
import { todayLocalDate } from "@/lib/providers/weather";
import { CAR_COLORS } from "@/lib/simulator/simulator";
import type { EngineResult, Need, StopCandidate, WeatherSnapshot } from "@/lib/domain/types";

const TripMap = dynamic(() => import("../TripMap"), {
  ssr: false,
  loading: () => <div className="flex h-[440px] items-center justify-center rounded-lg border border-slate-200 bg-slate-100 text-sm text-slate-500">Loading map…</div>
});

const RATES = [1, 10, 60, 120, 300];
const NOTICE_MIN = 10;
/** Early-trip quiet window after leaving Home: routine reminders are held (explicit/urgent needs pass). */
const HOME_QUIET_MIN = Number(process.env.NEXT_PUBLIC_HOME_QUIET_MIN ?? 30);
const URGENCY_STYLE: Record<UrgencyLevel, string> = {
  none: "bg-slate-100 text-slate-600",
  low: "bg-sky-100 text-sky-800",
  moderate: "bg-amber/15 text-amber",
  high: "bg-red-100 text-red-700"
};

type TripResult = EngineResult & {
  dataMode?: string;
  recommendedStops?: StopCandidate[];
  tactical?: { status: string; provider: string; ms: number; totalMs?: number; detail?: string; decision?: string; headline?: string };
  decidedFor?: { elapsedMinutes: number; leadKm: number; contextVersion: string | null };
};

interface Plan {
  route: TripRoute;
  model: RouteModel;
  setup: TripSetup;
  departureUtc: Date;
  tz: string;
  departLocal: string;
  /** Via point(s) when the user chose an alternative route. */
  via?: Array<{ lat: number; lng: number }>;
}

interface LogEntry {
  time: string;
  text: string;
  kind: "info" | "watcher" | "agent1" | "agent2" | "stop" | "error";
}

function defaultSetup(today: string): TripSetup {
  const base = getScenarioPreset("toronto-montreal-demo")!.setup(today);
  return { ...base, departure: { ...base.departure, time: "09:30" }, mood: ["hungry", "relaxed"], mealPreference: "auto" };
}

function intentsFromSetup(setup: TripSetup): Record<string, CarIntent> {
  return Object.fromEntries(
    setup.cars.map((c) => [
      c.id,
      emptyCarIntent(c.id, {
        kids: c.kids > 0,
        dietary: c.dietary,
        maxDetourMinutes: setup.maxDetourMinutes,
        needs: c.initialNeeds.map((n) => ({ need: n, sinceElapsed: 0 }))
      })
    ])
  );
}

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

export default function TripPlanner() {
  const today = useMemo(() => todayLocalDate(), []);
  const [sessionId] = useState(() => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().slice(0, 12) : `s${Date.now()}`));
  const [setup, setSetup] = useState<TripSetup>(() => defaultSetup(today));
  const setupState = setup;
  const planViaRef = useRef<Array<{ lat: number; lng: number }> | undefined>(undefined);
  const [setupOpen, setSetupOpen] = useState(true);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<{ message: string; suggestion?: string } | null>(null);

  // simulation
  const [elapsed, setElapsed] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(60);
  const [offsets, setOffsets] = useState<Record<string, number>>({});
  const [stops, setStops] = useState<StopPlan[]>([]);
  const [intents, setIntents] = useState<Record<string, CarIntent>>({});
  const [knownPlaces, setKnownPlaces] = useState<StopCandidate[]>([]);
  const [prefetchTrace, setPrefetchTrace] = useState<string[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const requestedTiles = useRef(new Set<string>());

  // decisions
  const [result, setResult] = useState<TripResult | null>(null);
  const [lastRequest, setLastRequest] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const loadingRef = useRef(false);
  const [heldForDecision, setHeldForDecision] = useState(false);
  const [weatherOverride, setWeatherOverride] = useState<"live" | "rain" | "snow" | "cold">("live");
  const [timings, setTimings] = useState<{ geometryMs?: number; exitsMs?: number; exitsStatus?: string; placesMs?: number; firstStrategicMs?: number; firstTacticalMs?: number; clickAt?: number }>({});
  const [tacticalState, setTacticalState] = useState<{ status: "idle" | "running" | "muse" | "fallback" | "timeout" | "stale" | "error"; ms?: number; headline?: string; decision?: string; detail?: string }>({ status: "idle" });
  const [tacticalSamples, setTacticalSamples] = useState<WorkflowSample[]>([]);
  const [strategicSamples, setStrategicSamples] = useState<WorkflowSample[]>([]);
  const [staleTactical, setStaleTactical] = useState(0);
  const [strategicUpdate, setStrategicUpdate] = useState<{ title: string; reason: string; toKm: number; contextVersion: string | null } | null>(null);
  const [exitsLoading, setExitsLoading] = useState(false);
  const [altsLoading, setAltsLoading] = useState(false);
  const [altMeal, setAltMeal] = useState<Record<string, { count: number | null; note?: string; checking?: boolean }>>({});
  const [highlightedAlt, setHighlightedAlt] = useState<string | null>(null);
  const playingRef = useRef(false);
  /** Token of the current decision hold; any explicit playback change clears it so it never auto-resumes. */
  const holdRef = useRef<number | null>(null);
  /** Bumped on every reset / re-plan: in-flight Tactical results from an older trip are discarded. */
  const tripGenRef = useRef(0);
  const [tripGen, setTripGen] = useState(0);
  /** Bumped on every planRoute: geometry/exits/places replies for an older route are discarded. */
  const routeGenRef = useRef(0);
  /** Bumped when the shown Strategic plan expires, so the coarse Strategic version changes once. */
  const [strategicEpoch, setStrategicEpoch] = useState(0);
  const [usage, setUsage] = useState<NonNullable<EngineResult["usage"]>>([]);
  const [memory, setMemory] = useState<WatchMemory>(EMPTY_MEMORY);
  const memoryRef = useRef<WatchMemory>(EMPTY_MEMORY);
  const [watcherOn, setWatcherOn] = useState(true);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [dwellDraft, setDwellDraft] = useState<Record<string, number>>({});
  const [participantsDraft, setParticipantsDraft] = useState<Record<string, string[]>>({});
  const [selectedStopId, setSelectedStopId] = useState<string | null>(null);
  const [waypointWeather, setWaypointWeather] = useState<Record<string, WeatherSnapshot>>({});

  // conversation
  const [chatText, setChatText] = useState("");
  const [chatCar, setChatCar] = useState("car_a");
  const [chatSource, setChatSource] = useState<"driver_voice" | "copassenger_text">("copassenger_text");
  const [chatBusy, setChatBusy] = useState(false);
  const [agent1, setAgent1] = useState<Agent1Trace[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);

  // ---------------- derived trip state ----------------
  const model = plan?.model ?? null;
  planViaRef.current = plan?.via;
  const tz = plan?.tz ?? "America/Toronto";
  const tripCars: TripCar[] = useMemo(
    () =>
      (plan?.setup.cars ?? []).map((c, i) => ({
        id: c.id,
        label: c.label,
        role: i === 0 ? "lead" : "follower",
        speedKph: c.speedKph,
        startOffsetMinutes: offsets[c.id] ?? (i === 0 ? 0 : c.startOffsetMinutes),
        kids: c.kids,
        adults: c.adults,
        gpsFrozenAtElapsed: null
      })),
    [plan, offsets]
  );
  const states = useMemo(() => (model ? tripCars.map((c) => carStateOnRoute(c, elapsed, model, stops)) : []), [model, tripCars, elapsed, stops]);
  const lead = states[0];
  const leadCar = tripCars[0];
  const leadKmRef = useRef(0);
  leadKmRef.current = lead?.progressKm ?? 0;
  const nowUtc = plan ? new Date(plan.departureUtc.getTime() + elapsed * 60000) : new Date();
  const nowLocal = plan ? utcToLocal(nowUtc, tz) : { date: today, time: "00:00" };
  const eta = useMemo(
    () => (plan && model && leadCar ? destinationEta({ car: leadCar, route: model, stops, departureUtc: plan.departureUtc, timeZone: tz }) : null),
    [plan, model, leadCar, stops, tz]
  );
  const baselineEta = useMemo(
    () => (plan && model && leadCar ? destinationEta({ car: leadCar, route: model, stops: [], departureUtc: plan.departureUtc, timeZone: tz }) : null),
    [plan, model, leadCar, tz]
  );
  const arrivalLight = useMemo(
    () => (plan && eta ? arrivalDaylight({ arrivalUtc: eta.arrivalUtc, destLat: plan.setup.destination.lat, destLng: plan.setup.destination.lng, timeZone: tz }) : null),
    [plan, eta, tz]
  );
  const maxElapsed = plan && model && leadCar ? Math.ceil(Math.max(...tripCars.map((c) => buildTimeline(c, model, stops).arrivalElapsed))) : 1;
  const activeStop = stops.find((s) => (ACTIVE_STATUSES as readonly string[]).includes(s.status)) ?? null;
  const lastCompleted = [...stops].reverse().find((s) => s.status === "COMPLETED");

  const pushLog = useCallback((kind: LogEntry["kind"], text: string) => {
    setLog((l) => [...l.slice(-80), { time: timeRef.current, text, kind }]);
  }, []);
  const timeRef = useRef(nowLocal.time);
  timeRef.current = nowLocal.time;

  // meal history: unknown stays unknown; confirmed meals come only from completed stops
  const lastMealMinutesAgo = useMemo(() => {
    const meal = [...stops].reverse().find((s) => (s.status === "COMPLETED" || s.status === "RESUMED") && s.satisfiedNeeds.includes("meal"));
    if (meal) return elapsed - (meal.departedAtElapsed ?? meal.arrivedAtElapsed ?? elapsed);
    if (!plan) return null;
    const h = plan.setup.mealHistory;
    if (h.kind === "already_ate") return elapsed;
    if (h.kind === "last_meal_at" && h.time) {
      const before = toMin(plan.departLocal) - toMin(h.time);
      return before >= 0 ? before + elapsed : null;
    }
    return null;
  }, [stops, elapsed, plan]);

  const urgencyByCar: Record<string, UrgencyResult> = useMemo(() => {
    const out: Record<string, UrgencyResult> = {};
    if (!plan) return out;
    states.forEach((st, idx) => {
      const c = tripCars[idx];
      const i = intents[c.id] ?? emptyCarIntent(c.id);
      out[c.id] =
        st.phase === "not_started" || st.phase === "arrived"
          ? { level: "none", reasons: [st.phase === "arrived" ? "arrived at destination" : "not departed yet"], needs: [], reminderOnly: false }
          : evaluateUrgency(
              { needs: i.needs.map((n) => n.need), hungerLevel: i.hungerLevel, restroomUrgent: i.restroomUrgent, notHungry: i.notHungry, kids: c.kids > 0 || i.kids },
              { elapsedMinutes: elapsed, localTime: nowLocal.time, minutesSinceLastStop: st.drivingMinutesSinceRest, lastMealMinutesAgo, mood: plan.setup.mood }
            );
    });
    return out;
  }, [plan, states, tripCars, intents, elapsed, nowLocal.time, lastMealMinutesAgo]);
  const groupUrgency = maxUrgency(Object.values(urgencyByCar));
  const groupDiet = useMemo(() => [...new Set(Object.values(intents).flatMap((i) => i.dietary))].sort(), [intents]);

  // ---------------- versions (stale-result detection) ----------------
  const routeVersion = plan ? `${plan.route.id}:${plan.route.exitsStatus ?? "ready"}` : null;
  const versionInput: VersionInput | null = useMemo(
    () =>
      plan
        ? {
            tripGen,
            routeId: plan.route.id,
            setup: {
              destinationLabel: plan.setup.destination.label,
              departureUtcIso: plan.departureUtc.toISOString(),
              departureMode: plan.setup.departure.mode,
              tz: plan.tz,
              dataMode: plan.setup.dataMode,
              maxDetourMinutes: plan.setup.maxDetourMinutes,
              mood: plan.setup.mood,
              mealPreference: plan.setup.mealPreference,
              mealHistory: plan.setup.mealHistory,
              customMeal: plan.setup.customMeal,
              cars: tripCars.map((c) => ({ id: c.id, speedKph: c.speedKph, startOffsetMinutes: c.startOffsetMinutes }))
            },
            weatherOverride,
            intents,
            stops
          }
        : null,
    [plan, tripGen, tripCars, weatherOverride, intents, stops]
  );
  /** Fine-grained version for Tactical (5 s): setup, speeds/offsets, intents, stop commitments, skipped stops. */
  const contextVersion = useMemo(() => (versionInput ? tacticalContextVersion({ ...versionInput, skipped }) : null), [versionInput, skipped]);
  /** Coarse version for Strategic (30 s): changes on setup/needs/weather, finished stops and plan expiry only. */
  const strategicVersion = useMemo(() => (versionInput ? strategicContextVersion({ ...versionInput, epoch: strategicEpoch }) : null), [versionInput, strategicEpoch]);
  const contextVersionRef = useRef(contextVersion);
  contextVersionRef.current = contextVersion;
  // A displayed recommendation belongs to the context that produced it, too.
  useEffect(() => {
    setResult(null);
    memoryRef.current = EMPTY_MEMORY;
    setMemory(EMPTY_MEMORY);
  }, [contextVersion]);
  const elapsedRef = useRef(elapsed);
  elapsedRef.current = elapsed;
  const skippedRef = useRef(skipped);
  skippedRef.current = skipped;
  const stopsRef = useRef(stops);
  stopsRef.current = stops;
  const cancelHold = () => {
    if (holdRef.current == null) return;
    holdRef.current = null;
    setHeldForDecision(false);
  };

  // ---------------- playback ----------------
  playingRef.current = playing;
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      setElapsed((e) => {
        const next = Math.min(e + (rate * 0.25) / 60, maxElapsed);
        if (next >= maxElapsed) setPlaying(false);
        return next;
      });
    }, 250);
    return () => clearInterval(id);
  }, [playing, rate, maxElapsed]);

  // stop lifecycle driven by simulated positions
  useEffect(() => {
    if (!model || stops.length === 0) return;
    const { plans, transitions } = autoAdvance(stops, tripCars, elapsed, model);
    if (transitions.length === 0) return;
    setStops(plans);
    for (const t of transitions) {
      const p = plans.find((x) => x.stopId === t.stopId);
      pushLog("stop", `${p?.name ?? t.stopId}: ${t.to}`);
      if (t.to === "ARRIVED") {
        cancelHold();
        setPlaying(false);
        setElapsed(t.atElapsed);
      }
    }
  }, [elapsed, model, stops, tripCars, pushLog]);

  // ---------------- plan route ----------------
  const applyPreset = (id: string) => {
    const p = getScenarioPreset(id);
    if (!p) return;
    setSetup(p.setup(today));
    pushLog("info", `Preset “${p.title}” loaded — review, then plan the route.`);
  };

  const resetSim = (s: TripSetup) => {
    // New trip generation: in-flight Tactical/Strategic work from before is discarded, never resumed.
    tripGenRef.current += 1;
    setTripGen(tripGenRef.current);
    cancelHold();
    loadingRef.current = false;
    setLoading(false);
    setTacticalState({ status: "idle" });
    setStrategicEpoch(0);
    setStrategicUpdate(null);
    strategicResetRef.current();
    setElapsed(0);
    setPlaying(false);
    setOffsets({});
    setStops([]);
    setIntents(intentsFromSetup(s));
    setResult(null);
    setError(null);
    setSkipped([]);
    setDwellDraft({});
    setParticipantsDraft({});
    memoryRef.current = EMPTY_MEMORY;
    setMemory(EMPTY_MEMORY);
    requestedTiles.current.clear();
  };

  /** Plan (or re-plan) a route. `via` forces an alternative; `keepIntents` preserves passenger needs on a mid-trip switch. */
  const planRoute = async (opts: { via?: Array<{ lat: number; lng: number }>; setupOverride?: TripSetup; keepIntents?: Record<string, CarIntent>; note?: string } = {}) => {
    const requestedSetup = opts.setupOverride ?? setupState;
    // Fictional 401 stops must never appear on a manually changed corridor.
    const fixtureCorridor = !opts.via?.length &&
      haversineKm([requestedSetup.origin.lng, requestedSetup.origin.lat], [TORONTO.lng, TORONTO.lat]) < 3 &&
      haversineKm([requestedSetup.destination.lng, requestedSetup.destination.lat], [MONTREAL.lng, MONTREAL.lat]) < 3;
    const setup: TripSetup = requestedSetup.dataMode === "demo" && !fixtureCorridor ? { ...requestedSetup, dataMode: "real" } : requestedSetup;
    const clickAt = performance.now();
    const seq = ++routeGenRef.current;
    setPlanning(true);
    setPlanError(null);
    try {
      const res = await fetch("/api/route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Progressive: geometry + baseline ETA first; exits, places, weather and Strategic follow.
        body: JSON.stringify({ origin: setup.origin, destination: setup.destination, sessionId, exits: "defer", ...(opts.via?.length ? { via: opts.via } : {}) })
      });
      const data = await res.json().catch(() => null);
      if (seq !== routeGenRef.current) return; // a newer Plan click superseded this one
      if (!res.ok) {
        setPlanError({ message: data?.error ?? `Route lookup failed (HTTP ${res.status})`, suggestion: data?.suggestion });
        return;
      }
      const route = data as TripRoute;
      const geometryMs = Math.round(performance.now() - clickAt);
      setTimings({ clickAt, geometryMs });
      const m = createRouteModel({
        id: route.id,
        source: route.source,
        attribution: route.attribution,
        origin: setup.origin.label,
        destination: setup.destination.label,
        coordinates: route.coordinates,
        exits: route.exits,
        durationMinutes: route.durationMinutes
      });
      const tzone = route.timezone || "America/Toronto";
      const speed = setup.cars[0].speedKph;
      const driveMin = (m.totalKm / speed) * 60;
      const anchorUtc = localDateTimeToUtc(setup.departure.date, setup.departure.time, tzone);
      const departureUtc = setup.departure.mode === "arrive_by" ? new Date(anchorUtc.getTime() - driveMin * 60000) : anchorUtc;
      const departLocal = formatInZone(departureUtc, tzone);
      setPlan({ route, model: m, setup, departureUtc, tz: tzone, departLocal, via: opts.via });
      resetSim(setup);
      if (opts.keepIntents) setIntents(opts.keepIntents);
      setAltMeal({});
      setHighlightedAlt(null);
      setDiscovering(false);
      setExitsLoading(false);
      if (!opts.keepIntents) {
        setLog([]);
        setAgent1([]);
      }
      if (opts.note) pushLog("info", opts.note);
      setSetupOpen(false);
      const demo = setup.dataMode === "demo";
      setKnownPlaces(demo ? allFixtureStops() : []);
      setPrefetchTrace([]);
      pushLog(
        "info",
        `Route ${setup.origin.label} → ${setup.destination.label}: ${m.totalKm.toFixed(0)} km (${route.source}, shown in ${geometryMs} ms). Depart ${departLocal}${
          setup.departure.mode === "arrive_by" ? ` to arrive by ${setup.departure.time}` : ""
        }.${route.exitsStatus === "pending" ? " Loading exits…" : ` ${m.exits().length} exits.`}`
      );
      setStrategicUpdate(null);
      setTacticalState({ status: "idle" });
      if (route.exitsStatus === "pending") void loadExits(route, setup, clickAt, opts.via);
      if (!demo) void loadAlternatives(route, setup, opts.via);
      else setTimings((t) => ({ ...t, exitsMs: geometryMs, exitsStatus: route.exitsStatus }));
      if (!demo) {
        const windows = opportunityWindows({
          routeKm: m.totalKm,
          speedKph: speed,
          departureLocal: departLocal,
          mood: setup.mood,
          mealPreference: setup.mealPreference,
          mealHistory: setup.mealHistory
        });
        const ws = windows.length ? windows : [{ minKm: (speed * NOTICE_MIN) / 60, maxKm: Math.min(m.totalKm, 60), reason: "first stretch" }];
        void discover(route, ws, setup, m, clickAt);
      }
    } catch (e) {
      if (seq !== routeGenRef.current) return;
      setPlanError({ message: `Couldn't reach the route service: ${(e as Error).message}`, suggestion: "Try the Toronto → Montréal demo preset" });
    } finally {
      if (seq === routeGenRef.current) setPlanning(false);
    }
  };

  const routeRef = (p: { route: TripRoute; setup: TripSetup; via?: Array<{ lat: number; lng: number }> }) => ({
    id: p.route.id,
    origin: { label: p.setup.origin.label, lat: p.setup.origin.lat, lng: p.setup.origin.lng, type: p.setup.origin.type },
    destination: { label: p.setup.destination.label, lat: p.setup.destination.lat, lng: p.setup.destination.lng, type: p.setup.destination.type },
    ...(p.via?.length ? { via: p.via } : {})
  });

  /** Exits + border crossings arrive after the map is already usable. */
  const loadExits = async (route: TripRoute, s: TripSetup, clickAt: number, via?: Array<{ lat: number; lng: number }>) => {
    const gen = routeGenRef.current;
    const isOld = () => gen !== routeGenRef.current;
    setExitsLoading(true);
    try {
      const res = await fetch("/api/route/exits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: route.id, origin: s.origin, destination: s.destination, sessionId, ...(via?.length ? { via } : {}) })
      });
      const data = await res.json().catch(() => null);
      if (isOld()) return; // the user planned another route meanwhile
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      const full = data as TripRoute;
      const m = createRouteModel({
        id: full.id,
        source: full.source,
        attribution: full.attribution,
        origin: s.origin.label,
        destination: s.destination.label,
        coordinates: full.coordinates,
        exits: full.exits,
        durationMinutes: full.durationMinutes
      });
      // Keep alternatives that may have arrived first.
      setPlan((p) => (p && p.route.id === full.id ? { ...p, route: { ...full, alternatives: p.route.alternatives?.length ? p.route.alternatives : full.alternatives }, model: m } : p));
      const exitsMs = Math.round(performance.now() - clickAt);
      setTimings((t) => ({ ...t, exitsMs, exitsStatus: full.exitsStatus }));
      pushLog(
        "info",
        `Exits ready after ${(exitsMs / 1000).toFixed(1)} s: ${full.exits.length} exits${full.borderCrossings.length ? `, border crossing at km ${Math.round(full.borderCrossings[0].km)}` : ""}${full.exitsStatus === "degraded" ? " (OSM junctions unavailable — OSRM ramp steps)" : ""}.`
      );
    } catch (e) {
      if (isOld()) return;
      pushLog("error", `Exits unavailable: ${(e as Error).message}. The simulation continues without exit labels.`);
    } finally {
      if (!isOld()) setExitsLoading(false);
    }
  };

  /** Real alternative routes (OSRM native or via-point), loaded in the background — never blocks the map. */
  const loadAlternatives = async (route: TripRoute, s: TripSetup, via?: Array<{ lat: number; lng: number }>) => {
    const gen = routeGenRef.current;
    setAltsLoading(true);
    try {
      const res = await fetch("/api/route/alternatives", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: route.id, origin: s.origin, destination: s.destination, sessionId, ...(via?.length ? { via } : {}) })
      });
      const data = await res.json().catch(() => null);
      if (gen !== routeGenRef.current) return;
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      const alts = (data?.alternatives ?? []) as TripRoute["alternatives"];
      setPlan((p) => (p && p.route.id === route.id ? { ...p, route: { ...p.route, alternatives: alts } } : p));
      pushLog("info", alts.length ? `${alts.length} alternative route(s): ${alts.map((a) => `${a.summary || a.id} (${a.durationMinutes - route.durationMinutes >= 0 ? "+" : ""}${Math.round(a.durationMinutes - route.durationMinutes)} min)`).join("; ")}` : "No meaningfully different alternative route found.");
    } catch (e) {
      if (gen === routeGenRef.current) pushLog("info", `Alternative routes unavailable: ${(e as Error).message}`);
    } finally {
      if (gen === routeGenRef.current) setAltsLoading(false);
    }
  };

  /** Switch to an alternative route: before departure re-plan normally; mid-trip re-plan from the car's current position, keeping needs. */
  const switchToAlternative = (altId: string) => {
    if (!plan || !lead) return;
    const alt = plan.route.alternatives.find((a) => a.id === altId) as (TripRoute["alternatives"][number] & { via?: Array<{ lat: number; lng: number }> }) | undefined;
    if (!alt?.via?.length) {
      pushLog("info", "This alternative has no via point to re-plan with.");
      return;
    }
    if (lead.progressKm < 1) {
      void planRoute({ via: alt.via, setupOverride: plan.setup, note: `Switched to alternative route: ${alt.summary}.` });
      return;
    }
    const here = { label: `Current position (km ${Math.round(lead.progressKm)})`, lat: lead.lat, lng: lead.lng, type: "other" as const, source: "current_location" as const };
    const viaAhead = alt.via.filter((v) => plan.model.nearestKm(v.lat, v.lng).km > lead.progressKm + 5);
    const s2: TripSetup = { ...plan.setup, origin: here, departure: { mode: "depart_at", date: nowLocal.date, time: nowLocal.time }, mealHistory: lastMealMinutesAgo == null ? plan.setup.mealHistory : { kind: "already_ate" } };
    void planRoute({
      via: viaAhead.length ? viaAhead : alt.via,
      setupOverride: s2,
      keepIntents: intents,
      note: `Re-planned from km ${Math.round(lead.progressKm)} via ${alt.summary}. Passenger needs kept; rest/meal timers restart from here.`
    });
  };

  const discover = async (route: TripRoute, windows: Array<{ minKm: number; maxKm: number; reason?: string }>, s: TripSetup, m: RouteModel, clickAt?: number) => {
    const fresh = windows.filter((w) => {
      const k = `${Math.floor(w.minKm / 30)}-${Math.floor(w.maxKm / 30)}`;
      if (requestedTiles.current.has(k)) return false;
      requestedTiles.current.add(k);
      return true;
    });
    if (!fresh.length) return;
    const gen = routeGenRef.current;
    const isOld = () => gen !== routeGenRef.current;
    setDiscovering(true);
    pushLog("info", `Discovering real places in ${fresh.length} likely stop window(s): ${fresh.map((w) => `km ${Math.round(w.minKm)}–${Math.round(w.maxKm)}${w.reason ? ` (${w.reason})` : ""}`).join(", ")}`);
    try {
      const res = await fetch("/api/places/prefetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ route: routeRef({ route, setup: s, via: planViaRef.current }), sessionId, windows: fresh.slice(0, 3).map((w) => ({ minKm: Math.max(0, w.minKm), maxKm: Math.min(m.totalKm, w.maxKm), reason: w.reason })) })
      });
      const data = await res.json().catch(() => null);
      if (isOld()) return; // places for a previous route never leak into the new one
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      const found = (data.candidates ?? []) as StopCandidate[];
      setKnownPlaces((prev) => {
        const ids = new Set(prev.map((p) => p.id));
        return [...prev, ...found.filter((f) => !ids.has(f.id))].sort((a, b) => a.distanceAlongRouteKm - b.distanceAlongRouteKm);
      });
      setPrefetchTrace((t) => [...t, ...(data.trace ?? [])]);
      if (data.usage?.length) setUsage(data.usage);
      if (clickAt != null) setTimings((t) => (t.placesMs ? t : { ...t, placesMs: Math.round(performance.now() - clickAt) }));
      pushLog("info", `Found ${found.length} real place(s) from OpenStreetMap${(data.trace ?? []).some((x: string) => x.includes("failed")) ? " (some lookups failed — see inspector)" : ""}.`);
    } catch (e) {
      if (isOld()) return;
      pushLog("error", `Real-place discovery unavailable: ${(e as Error).message}. Agent 2 will retry selectively when needed.`);
    } finally {
      if (!isOld()) setDiscovering(false);
    }
  };

  // Lazy, selective discovery: only when a need is active and nothing is known in the horizon ahead.
  useEffect(() => {
    if (!plan || !model || !lead || plan.setup.dataMode === "demo" || groupUrgency.level === "none" || discovering) return;
    const from = lead.progressKm + (leadCar.speedKph * NOTICE_MIN) / 60;
    const to = Math.min(model.totalKm, lead.progressKm + Math.min(HORIZON[groupUrgency.level].maxKm, 90));
    if (to - from < 5) return;
    const known = knownPlaces.some((p) => p.distanceAlongRouteKm >= from && p.distanceAlongRouteKm <= to && groupUrgency.needs.some((n) => p.categories.includes(n)));
    if (!known) void discover(plan.route, [{ minKm: from, maxKm: to, reason: `${groupUrgency.level} urgency ahead` }], plan.setup, model);
  }, [Math.floor((lead?.progressKm ?? 0) / 15), groupUrgency.level, plan?.route.id, discovering]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------- Agent 2 · Strategic Planner (background, never blocks) ----------------
  const buildStrategicInput = useCallback(() => {
    if (!plan || !lead || !routeVersion || !strategicVersion) return null;
    const allNeeds = Object.fromEntries(plan.setup.cars.map((c) => [c.id, (intents[c.id]?.needs ?? []).map((n) => n.need)]));
    return {
      routeRef: routeRef(plan),
      routeVersion,
      contextVersion: strategicVersion,
      sessionId,
      timeZone: tz,
      departureUtc: plan.departureUtc.toISOString(),
      elapsedMinutes: Math.round(elapsed),
      leadKm: Math.round(lead.progressKm * 10) / 10,
      leadSpeedKph: leadCar.speedKph,
      localTime: nowLocal.time,
      needs: allNeeds,
      mood: plan.setup.mood,
      mealPreference: plan.setup.mealPreference,
      mealHistory: plan.setup.mealHistory,
      dietary: groupDiet,
      kids: plan.setup.cars.some((c) => c.kids > 0 || intents[c.id]?.kids),
      weatherCondition: weatherOverride === "live" ? "sunny" : weatherOverride,
      lastMealMinutesAgo: lastMealMinutesAgo == null ? null : Math.round(lastMealMinutesAgo),
      drivingMinutesSinceRest: Math.round(lead.drivingMinutesSinceRest),
      dataMode: plan.setup.dataMode
    };
  }, [plan, lead, routeVersion, strategicVersion, intents, sessionId, tz, elapsed, leadCar, nowLocal.time, groupDiet, lastMealMinutesAgo, weatherOverride]); // eslint-disable-line react-hooks/exhaustive-deps

  const strategic = useStrategic({
    enabled: Boolean(plan),
    routeVersion,
    contextVersion: strategicVersion,
    buildInput: buildStrategicInput,
    // One run per route, not one for the geometry-only stage and another once exits arrive.
    hold: exitsLoading,
    leadKm: lead && lead.phase !== "arrived" ? lead.progressKm : null,
    elapsedMinutes: lead && lead.phase !== "arrived" ? elapsed : null,
    routeTotalKm: model?.totalKm ?? null,
    onResult: (st, outcome) => {
      if (st.ms != null) setStrategicSamples((x) => [...x.slice(-50), { ms: st.ms!, status: outcome === "accepted" ? st.status : outcome, at: Date.now() }]);
      setTimings((t) => (t.firstStrategicMs || t.clickAt == null ? t : { ...t, firstStrategicMs: Math.round(performance.now() - t.clickAt) }));
      if (outcome === "error") {
        pushLog("error", `Strategic planning failed (${st.error ?? "unknown error"}) — will retry; Tactical still works.`);
        return;
      }
      if (outcome === "stale") {
        pushLog("info", `Strategic result discarded — computed for an older route/context (${st.plan?.contextVersion}); re-planning.`);
        return;
      }
      pushLog("info", `Strategic plan (${st.meta?.status}, ${((st.ms ?? 0) / 1000).toFixed(1)} s): ${st.plan?.summary ?? ""}`);
      // A better future opportunity than the current tactical pick → suggest, never silently replace.
      // Not while a stop is already selected / en route / in progress, and only for opportunities still ahead.
      if (stopsRef.current.some((x) => (ACTIVE_STATUSES as readonly string[]).includes(x.status))) return;
      const top = st.plan?.opportunities.find((o) => o.priority === "high" && o.candidateIds.length > 0 && o.toKm >= leadKmRef.current);
      const currentIds = resultRef.current?.recommendations.map((r) => r.stopId) ?? [];
      if (top && resultRef.current && currentIds.length && !top.candidateIds.some((id) => currentIds.includes(id))) {
        setStrategicUpdate({
          title: top.title,
          reason: `${top.reason} (Tactical currently suggests ${resultRef.current.recommendations[0]?.name ?? "another stop"}.)`,
          toKm: top.toKm,
          contextVersion: st.contextVersion
        });
      }
    }
  });
  const strategicResetRef = useRef(strategic.reset);
  strategicResetRef.current = strategic.reset;
  // Plan expired (lead passed expiresAtKm or clock passed expiresAtElapsed) → one coarse version bump → one re-plan.
  useEffect(() => {
    if (strategic.expired) {
      pushLog("info", "Strategic plan expired — re-planning for the road ahead.");
      setStrategicEpoch((e) => e + 1);
    }
  }, [strategic.expired]); // eslint-disable-line react-hooks/exhaustive-deps
  // The "Strategic update" banner is dropped once it stops being relevant.
  useEffect(() => {
    if (!strategicUpdate) return;
    if (activeStop || strategicUpdate.contextVersion !== strategicVersion || (lead && strategicUpdate.toKm < lead.progressKm)) setStrategicUpdate(null);
  }, [strategicUpdate, Boolean(activeStop), strategicVersion, Math.floor((lead?.progressKm ?? 0) / 5)]); // eslint-disable-line react-hooks/exhaustive-deps
  const strategicHints = useMemo(() => {
    if (!strategic.isCurrent || !strategic.state.plan || !lead) return [];
    return strategic.state.plan.opportunities
      .filter((o) => o.toKm >= lead.progressKm)
      .slice(0, 6)
      .map((o) => ({ id: o.id, kind: o.kind, title: o.title, fromKm: o.fromKm, toKm: o.toKm, candidateIds: o.candidateIds, priority: o.priority, watchFor: o.watchFor }));
  }, [strategic.isCurrent, strategic.state.plan, Math.floor((lead?.progressKm ?? 0) / 5)]); // eslint-disable-line react-hooks/exhaustive-deps
  const resultRef = useRef<TripResult | null>(null);
  resultRef.current = result;

  // ---------------- context + Agent 2 ----------------
  const agentContext = useMemo(() => {
    if (!plan || !model || !lead || !eta || !arrivalLight) return null;
    return buildAgentContext({
      elapsedMinutes: elapsed,
      localTime: nowLocal.time,
      route: { totalKm: model.totalKm, remainingKm: Math.max(0, model.totalKm - lead.progressKm), remainingMinutes: Math.max(0, (eta.arrivalUtc.getTime() - nowUtc.getTime()) / 60000) },
      origin: plan.setup.origin,
      destination: plan.setup.destination,
      arrival: {
        local: eta.arrivalLocal,
        minutesFromNow: Math.max(0, (eta.arrivalUtc.getTime() - nowUtc.getTime()) / 60000),
        sunsetLocal: arrivalLight.sunsetLocal,
        afterDark: arrivalLight.afterDark,
        minutesAfterSunset: arrivalLight.minutesAfterSunset
      },
      weatherAtDestination: waypointWeather.dest ? { condition: waypointWeather.dest.condition, tempC: waypointWeather.dest.tempC, description: waypointWeather.dest.description } : null,
      cars: states.map((st, i) => {
        const c = plan.setup.cars[i];
        const it = intents[c.id] ?? emptyCarIntent(c.id);
        return {
          id: c.id,
          label: c.label,
          role: i === 0 ? ("lead" as const) : ("follower" as const),
          adults: c.adults,
          kids: c.kids,
          dietary: it.dietary,
          maxDetourMinutes: it.maxDetourMinutes,
          progressKm: st.progressKm,
          speedKph: st.speedKph,
          phase: st.phase,
          atStopId: st.atStopId,
          positionUpdatedMinutesAgo: st.positionUpdatedMinutesAgo,
          drivingMinutesSinceRest: st.drivingMinutesSinceRest,
          needs: it.needs.map((n) => n.need),
          hungerLevel: it.hungerLevel,
          restroomUrgent: it.restroomUrgent,
          notHungry: it.notHungry,
          recentUtterances: it.history
        };
      }),
      stops,
      mealHistory: plan.setup.mealHistory,
      drivingMinutesSinceRest: lead.drivingMinutesSinceRest,
      mood: plan.setup.mood,
      mealPreference: plan.setup.mealPreference,
      foodOptionsAhead: knownPlaces.filter((p) => p.distanceAlongRouteKm > lead.progressKm && p.categories.includes("meal")).length
    });
  }, [plan, model, lead, eta, arrivalLight, elapsed, nowLocal.time, waypointWeather.dest, states, intents, stops, knownPlaces]); // eslint-disable-line react-hooks/exhaustive-deps

  const buildRequest = useCallback(() => {
    if (!plan || !model || !lead) return null;
    const collective = toCollective(plan.setup.cars.map((c) => ({ ...(intents[c.id] ?? emptyCarIntent(c.id)), kids: c.kids > 0 || (intents[c.id]?.kids ?? false) })));
    const sun = sunTimes(localDateTimeToUtc(nowLocal.date, "12:00", tz), lead.lat, lead.lng).sunset;
    const daylightMinutes = sun ? Math.max(0, Math.round((sun.getTime() - nowUtc.getTime()) / 60000)) : 0;
    return {
      trip: {
        destination: plan.setup.destination.label,
        direction: "toward destination",
        highway: "route",
        elapsedMinutes: Math.round(elapsed),
        localTime: nowLocal.time,
        minutesSinceLastStop: Math.round(lead.drivingMinutesSinceRest),
        localDate: nowLocal.date,
        lastMealMinutesAgo: lastMealMinutesAgo == null ? null : Math.round(lastMealMinutesAgo),
        overrideInitialQuiet: overrideQuietRef.current
      },
      config: {
        avoidRegion: null,
        noOptionalStopsFirstMinutes: plan.setup.origin.type === "home" ? HOME_QUIET_MIN : 10,
        maximumDetourMinutesPerCar: plan.setup.maxDetourMinutes,
        maximumRegroupWaitMinutes: 20,
        advanceNoticeMinutes: NOTICE_MIN,
        requiredDiet: [],
        groceriesCompleted: true,
        passengerLed: true
      },
      cars: states.map((st, i) => {
        const c = plan.setup.cars[i];
        return {
          id: c.id,
          label: c.label,
          role: i === 0 ? ("lead" as const) : ("passenger" as const),
          progressKm: Math.round(st.progressKm * 10) / 10,
          speedKph: c.speedKph,
          passengers: c.adults + c.kids,
          kids: c.kids > 0 || Boolean(intents[c.id]?.kids),
          ev: false,
          positionUpdatedMinutesAgo: st.positionUpdatedMinutesAgo,
          needs: (intents[c.id]?.needs ?? []).map((n) => n.need),
          lat: st.lat,
          lng: st.lng,
          headingDeg: Math.round(st.headingDeg)
        };
      }),
      collectiveIntent: { ...collective, notHungry: plan.setup.cars.every((c) => intents[c.id]?.notHungry) },
      environment: { weather: weatherOverride === "live" ? ("sunny" as const) : weatherOverride, trafficDelayMinutes: 0, daylightMinutes },
      options: { weatherMode: weatherOverride === "live" ? ("live" as const) : ("simulated" as const), excludeStopIds: skipped },
      context: {
        route: routeRef(plan),
        sessionId,
        dataMode: plan.setup.dataMode,
        timeZone: tz,
        mood: plan.setup.mood,
        mealPreference: plan.setup.mealPreference,
        customMeal: plan.setup.customMeal,
        agentContext: agentContext?.context,
        tomtomVerifyTop: 0,
        workflow: "tactical" as const,
        contextVersion: contextVersion ?? undefined,
        strategicHints
      }
    };
  }, [plan, model, lead, intents, nowLocal, tz, nowUtc, elapsed, lastMealMinutesAgo, states, skipped, sessionId, agentContext, weatherOverride, contextVersion, strategicHints]); // eslint-disable-line react-hooks/exhaustive-deps

  const runDecision = useCallback(
    async (trigger: "watcher" | "manual", key?: string) => {
      const body = buildRequest();
      if (!body || loadingRef.current) return;
      const gen = tripGenRef.current;
      const isOld = () => gen !== tripGenRef.current;
      loadingRef.current = true;
      setLoading(true);
      setLastRequest(body);
      setTacticalState({ status: "running" });
      const t0 = performance.now();
      // Simulated time holds while Uncongest decides, so a slow lookup never lets the car drive past the exit.
      // The hold token lets any explicit playback change (pause, scrub, reset, arrival) win over the auto-resume.
      let holdToken: number | null = null;
      if (playingRef.current) {
        holdToken = Date.now() + Math.random();
        holdRef.current = holdToken;
        setPlaying(false);
        setHeldForDecision(true);
      }
      if (key) {
        memoryRef.current = { ...memoryRef.current, lastKey: key, lastCallElapsed: elapsed };
        setMemory(memoryRef.current);
      }
      const recordFailure = (detail: string) => {
        const ms = Math.round(performance.now() - t0);
        setTacticalSamples((x) => [...x.slice(-100), { ms, status: "error", at: Date.now() }]);
        setTacticalState({ status: "error", ms, detail });
      };
      const discardAsStale = (ms: number, detail: string, logReason: string) => {
        setStaleTactical((n) => n + 1);
        setTacticalSamples((x) => [...x.slice(-100), { ms, status: "stale", at: Date.now() }]);
        setTacticalState({ status: "stale", ms, detail });
        pushLog("info", `Tactical result discarded as stale (${logReason}) — re-deciding.`);
        memoryRef.current = { ...memoryRef.current, lastKey: null, lastCallElapsed: null, lastRecommendedKm: null, lastRecommendedStopId: null };
        setMemory(memoryRef.current);
      };
      try {
        const res = await fetch("/api/recommend-stops", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const data = await res.json().catch(() => null);
        if (isOld()) {
          pushLog("info", "Tactical result discarded — the trip was reset or re-planned while deciding.");
          return;
        }
        if (!res.ok) {
          const msg = data?.error ?? `HTTP ${res.status}`;
          setError(`${msg}${data?.issues ? ` — ${data.issues.map((i: { path: string[]; message: string }) => `${i.path.join(".")}: ${i.message}`).join("; ")}` : ""}`);
          recordFailure(String(msg));
          pushLog("error", `Agent 2 failed: ${data?.error ?? res.status}`);
          return;
        }
        const r = data as TripResult;
        const clientMs = Math.round(performance.now() - t0);
        const tac = r.tactical;
        if (r.usage?.length) setUsage(r.usage);
        setTimings((t) => (t.firstTacticalMs || t.clickAt == null ? t : { ...t, firstTacticalMs: Math.round(performance.now() - t.clickAt) }));
        // ---- staleness: context changed, time went backwards, or the car passed the suggested exit while we waited ----
        const curLead = leadKmRef.current;
        const noticeKm = (leadCar.speedKph * NOTICE_MIN) / 60;
        const verdict = checkTacticalStaleness(r, contextVersionRef.current, curLead, noticeKm, elapsedRef.current);
        if (verdict.stale) {
          const why = verdict.reason === "context_changed" ? "situation changed while deciding" : verdict.reason === "time_reversed" ? "the trip was reset or rewound while deciding" : "the car passed the suggested exit";
          const logWhy = verdict.reason === "context_changed" ? "context changed" : verdict.reason === "time_reversed" ? "decided for a later point of the trip" : "exit no longer reachable with notice";
          discardAsStale(clientMs, why, logWhy);
          return;
        }
        if (verdict.dropped.length) r.recommendations = r.recommendations.filter((x) => verdict.keepStopIds.includes(x.stopId)).map((x, i) => ({ ...x, rank: i + 1 }));
        // Stops skipped while the request was in flight never come back.
        const hadRecs = r.recommendations.length > 0;
        r.recommendations = withoutSkipped(r.recommendations, skippedRef.current);
        if (hadRecs && r.recommendations.length === 0) {
          discardAsStale(clientMs, "every suggested stop was skipped while deciding", "suggested stops were skipped");
          return;
        }
        setError(null);
        setResult(r);
        const status = tac?.status === "muse" ? "muse" : tac?.status === "timeout" ? "timeout" : tac ? "fallback" : "fallback";
        setTacticalSamples((x) => [...x.slice(-100), { ms: tac?.totalMs ?? clientMs, status, at: Date.now() }]);
        setTacticalState({ status, ms: clientMs, headline: tac?.headline, decision: tac?.decision, detail: tac?.detail });
        if (tac?.decision === "SEARCH_FARTHER" && plan && model && lead && plan.setup.dataMode !== "demo") {
          const known = knownPlaces.some((k) => k.distanceAlongRouteKm > lead.progressKm);
          const from = lead.progressKm + (known ? 60 : (leadCar.speedKph * NOTICE_MIN) / 60);
          void discover(plan.route, [{ minKm: from, maxKm: Math.min(model.totalKm, from + 60), reason: "Tactical asked to search farther" }], plan.setup, model);
        }
        if (r.recommendedStops?.length) {
          const skippedNow = new Set(skippedRef.current);
          setKnownPlaces((prev) => {
            const ids = new Set(prev.map((p) => p.id));
            return [...prev, ...r.recommendedStops!.filter((s) => !ids.has(s.id) && !skippedNow.has(s.id))].sort((a, b) => a.distanceAlongRouteKm - b.distanceAlongRouteKm);
          });
        }
        const top = r.recommendations[0];
        const topStop = r.recommendedStops?.find((s) => s.id === top?.stopId);
        memoryRef.current = { ...memoryRef.current, lastRecommendedKm: topStop?.distanceAlongRouteKm ?? null, lastRecommendedStopId: top?.stopId ?? null };
        setMemory(memoryRef.current);
        pushLog(
          r.action === "STAY_SILENT" ? "info" : "agent2",
          r.action === "STAY_SILENT"
            ? r.tactical?.decision === "SEARCH_FARTHER"
              ? `Agent 2 (${r.provider}) → no suitable place known yet [${r.urgency?.level}] — searching farther`
              : `Agent 2 (${r.provider}) → stay quiet [${r.urgency?.level}]`
            : `Agent 2 (${r.provider}) → ${r.recommendations.map((x) => `#${x.rank} ${x.name}`).join(", ")} [${r.urgency?.level} urgency, ${trigger}]`
        );
      } catch (e) {
        if (isOld()) return;
        setError(`network error: ${(e as Error).message}`);
        recordFailure((e as Error).message);
      } finally {
        if (!isOld()) {
          loadingRef.current = false;
          setLoading(false);
        }
        // Resume only if this decision's hold is still the active one (no pause/scrub/reset/arrival meanwhile).
        if (holdToken != null && holdRef.current === holdToken) {
          holdRef.current = null;
          setHeldForDecision(false);
          setPlaying(true);
        }
      }
    },
    [buildRequest, elapsed, pushLog, leadCar, plan, model, lead] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const runRef = useRef(runDecision);
  runRef.current = runDecision;


  // ---------------- ambient watcher ----------------
  const watchDecision = useMemo(() => {
    if (!lead || !leadCar || !model) return null;
    return watch({
      elapsedMinutes: elapsed,
      lead: { id: lead.id, progressKm: lead.progressKm, speedKph: leadCar.speedKph },
      urgency: groupUrgency,
      stops: knownPlaces,
      advanceNoticeMinutes: NOTICE_MIN,
      routeTotalKm: model.totalKm,
      excludedStopIds: skipped,
      confirmedStopPending: Boolean(activeStop) || lead.phase !== "driving",
      requiredDiet: groupDiet as CarIntent["dietary"],
      avoidRegion: null,
      departureQuiet: plan?.setup.origin.type === "home" ? { untilElapsed: HOME_QUIET_MIN, reason: "just left home" } : undefined,
      memory
    });
  }, [lead, leadCar, model, elapsed, groupUrgency, knownPlaces, skipped, activeStop, groupDiet, memory, plan?.setup.origin.type]);
  const overrideQuietRef = useRef(false);
  overrideQuietRef.current = Boolean(watchDecision?.overrideInitialQuiet);

  useEffect(() => {
    if (!watcherOn || !watchDecision?.shouldCall || loadingRef.current) return;
    pushLog("watcher", `Watcher → Agent 2: ${watchDecision.reasons.join("; ")}`);
    void runRef.current("watcher", watchDecision.key);
  }, [watcherOn, watchDecision?.shouldCall, watchDecision?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------- weather along the road + at destination ----------------
  const waypoints: RoadAheadWaypoint[] = useMemo(() => {
    if (!lead || !leadCar || !model) return [];
    return [0, 40, 80, 120]
      .map((d) => Math.min(lead.progressKm + d, model.totalKm))
      .filter((km, i, a) => a.indexOf(km) === i)
      .map((km, i) => ({ id: `wp${i}`, km, etaMinutes: ((km - lead.progressKm) / leadCar.speedKph) * 60 }));
  }, [lead, leadCar, model]);
  const weatherKey = `${plan?.route.id}|${weatherOverride}|${Math.floor((lead?.progressKm ?? 0) / 20)}|${nowLocal.time.slice(0, 2)}|${eta?.arrivalLocal}`;
  useEffect(() => {
    if (!plan || !model || !eta) return;
    const ctrl = new AbortController();
    const pts = [
      ...waypoints.map((w) => {
        const p = model.pointAtKm(w.km);
        const t = utcToLocal(new Date(nowUtc.getTime() + w.etaMinutes * 60000), tz);
        return { id: w.id, lat: p.lat, lng: p.lng, localDateTime: `${t.date}T${t.time}` };
      }),
      (() => {
        const t = utcToLocal(eta.arrivalUtc, tz);
        return { id: "dest", lat: plan.setup.destination.lat, lng: plan.setup.destination.lng, localDateTime: `${t.date}T${t.time}` };
      })()
    ];
    fetch("/api/weather", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: weatherOverride === "live" ? "live" : "simulated", fallback: weatherOverride === "live" ? "sunny" : weatherOverride, timeZone: tz, points: pts }), signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { readings: WeatherSnapshot[] }) => setWaypointWeather(Object.fromEntries(d.readings.map((r) => [r.id, r]))))
      .catch(() => undefined);
    return () => ctrl.abort();
  }, [weatherKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------- stop actions ----------------
  const dispatchStop = (action: StopAction, note?: string) => {
    const r = stopReducer(stops, action);
    if (r.error) {
      pushLog("error", `Stop action refused: ${r.error}`);
      return false;
    }
    setStops(r.plans);
    if (note) pushLog("stop", note);
    return true;
  };

  const selectRec = (stopId: string) => {
    const rec = result?.recommendations.find((r) => r.stopId === stopId);
    const stop = result?.recommendedStops?.find((s) => s.id === stopId) ?? knownPlaces.find((s) => s.id === stopId);
    if (!rec || !stop || !plan) return;
    const dwell = dwellDraft[stopId] ?? defaultDwellMinutes(stop.categories, plan.setup.mealPreference);
    const participants = participantsDraft[stopId] ?? plan.setup.cars.map((c) => c.id);
    const ok = dispatchStop(
      {
        type: "select",
        plan: {
          stopId,
          name: rec.name,
          km: stop.distanceAlongRouteKm,
          lat: stop.lat,
          lng: stop.lng,
          categories: stop.categories,
          status: "PROPOSED",
          detourMinutes: Math.max(...Object.values(rec.detourMinutesByCar).filter(Number.isFinite), stop.accessMinutes),
          plannedDwellMinutes: dwell,
          participants,
          satisfiedNeeds: []
        }
      },
      `Selected ${rec.name} for ${dwell} min (${participants.length} car${participants.length > 1 ? "s" : ""})`
    );
    if (ok) setSelectedStopId(stopId);
  };

  const timelineArrival = (p: StopPlan) => {
    if (!model || !leadCar) return elapsed;
    const car = tripCars.find((c) => p.participants.includes(c.id)) ?? leadCar;
    const seg = buildTimeline(car, model, stops).segments.find((s) => s.phase === "exiting" && s.stop?.stopId === p.stopId);
    return seg ? seg.end : elapsed;
  };

  const completeStop = (satisfied: Need[]) => {
    if (!activeStop) return;
    const ok = dispatchStop(
      { type: "complete", stopId: activeStop.stopId, elapsed, satisfiedNeeds: satisfied },
      `Completed ${activeStop.name} after ${Math.round(elapsed - (activeStop.arrivedAtElapsed ?? elapsed))} min; confirmed: ${satisfied.join(", ") || "nothing"}`
    );
    if (!ok) return;
    setIntents((prev) => Object.fromEntries(Object.entries(prev).map(([id, it]) => [id, activeStop.participants.includes(id) ? clearCoveredNeeds(it, satisfied) : it])));
    memoryRef.current = EMPTY_MEMORY;
    setMemory(EMPTY_MEMORY);
    setResult(null);
  };

  const onPlaceCar = (carId: string, lat: number, lng: number) => {
    if (!model) return;
    const { km } = model.nearestKm(lat, lng);
    const car = tripCars.find((c) => c.id === carId);
    if (!car) return;
    if (car.role === "lead") {
      const r = placeLead(car, km, model, stops);
      setElapsed(r.elapsed);
      memoryRef.current = EMPTY_MEMORY;
      setMemory(EMPTY_MEMORY);
      pushLog("info", `${car.label} moved to km ${r.km.toFixed(0)} → clock ${utcToLocal(new Date(plan!.departureUtc.getTime() + r.elapsed * 60000), tz).time}`);
    } else {
      const r = placeFollower(car, km, elapsed, model, stops);
      setOffsets((o) => ({ ...o, [carId]: r.car.startOffsetMinutes }));
      pushLog("info", r.clamped ? `${car.label} can't be that far yet — placed at km ${r.km.toFixed(0)}` : `${car.label} moved to km ${r.km.toFixed(0)}`);
    }
  };

  // ---------------- Agent 1 conversation ----------------
  const quickSay = async (text: string) => {
    await sendMessage(text);
  };

  const sendMessage = async (override?: string) => {
    const t = (override ?? chatText).trim();
    if (!t || chatBusy || !plan) return;
    const generation = tripGenRef.current;
    const version = contextVersionRef.current;
    const speaker = chatCar;
    setChatBusy(true);
    const body = {
      carId: chatCar,
      source: chatSource,
      text: t,
      localTime: nowLocal.time,
      cars: plan.setup.cars.map((c) => ({ id: c.id, label: c.label })),
      current: Object.fromEntries(
        plan.setup.cars.map((c) => {
          const i = intents[c.id] ?? emptyCarIntent(c.id);
          return [c.id, { needs: i.needs.map((n) => n.need), hungerLevel: i.hungerLevel, restroomUrgent: i.restroomUrgent, notHungry: i.notHungry, dietary: i.dietary, kids: i.kids || c.kids > 0, history: i.history.slice(-2) }];
        })
      )
    };
    let out: IntentAgentOutput & { provider: string; isMock?: boolean };
    try {
      const res = await fetch("/api/intent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      out = data;
    } catch (e) {
      out = { ...regexIntentUpdate(chatCar, t), provider: `client fallback (${(e as Error).message})` };
    }
    if (generation !== tripGenRef.current || version !== contextVersionRef.current) {
      pushLog("info", "Agent 1 response discarded because the trip context changed; send the message again.");
      setChatBusy(false);
      return;
    }
    setIntents((prev) => {
      const next = { ...prev };
      for (const u of out.updates) if (next[u.carId]) next[u.carId] = applyIntentUpdate(next[u.carId], u, elapsedRef.current, u.carId === speaker ? t : undefined);
      return next;
    });
    const providerLabel = `${out.isMock === false ? "Live" : "Mock"} · ${out.provider}`;
    setAgent1((a) => [...a.slice(-20), { time: nowLocal.time, carId: speaker, source: chatSource, text: t, provider: providerLabel, understood: out.understood }]);
    pushLog("agent1", `Agent 1 (${providerLabel}) ${speaker}: “${t}” → ${out.understood.join("; ") || "no change"}`);
    setChatText("");
    setChatBusy(false);
  };

  // ---------------- route alternatives: compare food options in the meal window ----------------
  const mealWindow = useMemo(() => {
    if (!plan || !model) return null;
    const ws = opportunityWindows({
      routeKm: model.totalKm,
      speedKph: plan.setup.cars[0].speedKph,
      departureLocal: plan.departLocal,
      mood: plan.setup.mood,
      mealPreference: plan.setup.mealPreference,
      mealHistory: plan.setup.mealHistory
    });
    const w = ws.find((x) => /lunch|dinner/.test(x.reason));
    return w ? { minKm: w.minKm, maxKm: w.maxKm, label: /dinner/.test(w.reason) ? "dinner window" : "lunch window" } : null;
  }, [plan, model]);

  const mainMeal = useMemo((): { count: number | null; note?: string } => {
    if (!mealWindow) return { count: null, note: "no meal window on this trip" };
    if (plan?.setup.dataMode === "demo") return { count: null, note: "demo fixtures" };
    const n = knownPlaces.filter((p) => p.categories.includes("meal") && p.distanceAlongRouteKm >= mealWindow.minKm && p.distanceAlongRouteKm <= mealWindow.maxKm).length;
    const lookedUp = prefetchTrace.some((t) => /prefetch km \d+/.test(t));
    const failed = prefetchTrace.length > 0 && prefetchTrace.every((t) => !/place\(s\), (live|cached)/.test(t));
    if (n === 0 && (failed || !lookedUp)) return { count: null, note: failed ? "unknown (place data unavailable)" : discovering ? "checking…" : "not checked yet" };
    return { count: n };
  }, [mealWindow, knownPlaces, prefetchTrace, discovering, plan?.setup.dataMode]);

  const checkAlternative = async (altId: string) => {
    if (!plan || !mealWindow) return;
    const alt = plan.route.alternatives.find((a) => a.id === altId) as (TripRoute["alternatives"][number] & { via?: Array<{ lat: number; lng: number }> }) | undefined;
    if (!alt) return;
    const gen = routeGenRef.current;
    setAltMeal((m) => ({ ...m, [altId]: { count: null, checking: true } }));
    // Same time window → roughly the same km range on the alternative (scaled by its length).
    const scale = alt.distanceKm / Math.max(plan.route.distanceKm, 1);
    const w = { minKm: mealWindow.minKm * scale, maxKm: Math.min(alt.distanceKm, mealWindow.maxKm * scale), reason: `${mealWindow.label} on ${alt.summary}` };
    try {
      const res = await fetch("/api/places/prefetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ route: { ...routeRef(plan), id: alt.id, ...(alt.via?.length ? { via: alt.via } : {}) }, sessionId, windows: [w] })
      });
      const data = await res.json().catch(() => null);
      if (gen !== routeGenRef.current) return;
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      const trace: string[] = data.trace ?? [];
      const ok = trace.some((t) => /place\(s\), (live|cached)/.test(t));
      const n = ((data.candidates ?? []) as StopCandidate[]).filter((c) => c.categories.includes("meal")).length;
      setAltMeal((m) => ({ ...m, [altId]: ok ? { count: n } : { count: null, note: "unknown (place data unavailable)" } }));
    } catch (e) {
      if (gen === routeGenRef.current) setAltMeal((m) => ({ ...m, [altId]: { count: null, note: `unknown (${(e as Error).message})` } }));
    }
  };

  const routeOptions = useMemo(() => {
    if (!plan) return null;
    const decisions = strategic.state.plan?.routeDecisions ?? [];
    const alts: RouteOptionView[] = (plan.route.alternatives ?? []).map((a) => {
      const d = decisions.find((x) => x.alternativeRouteId === a.id);
      const m = altMeal[a.id];
      return { id: a.id, summary: a.summary, durationMinutes: a.durationMinutes, distanceKm: a.distanceKm, mealOptions: m?.count ?? null, mealNote: m?.note, checking: m?.checking, strategicReason: d ? `Strategic: ${d.detail}` : undefined };
    });
    const main: RouteOptionView = { id: plan.route.id, summary: "", durationMinutes: plan.route.durationMinutes, distanceKm: plan.route.distanceKm, mealOptions: mainMeal.count, mealNote: mainMeal.note };
    // Suggest only on evidence: current route's count is KNOWN and thin, and an alternative clearly has more.
    let suggestion: { altId: string; text: string } | null = null;
    const better = alts.filter((a) => a.mealOptions != null && main.mealOptions != null && main.mealOptions < 3 && a.mealOptions >= main.mealOptions + 2).sort((x, y) => (y.mealOptions ?? 0) - (x.mealOptions ?? 0))[0];
    if (better && mealWindow) {
      suggestion = { altId: better.id, text: `Food options look thin on the current route in the ${mealWindow.label} (${main.mealOptions}); via ${better.summary} has ${better.mealOptions} (${better.durationMinutes - main.durationMinutes >= 0 ? "+" : ""}${Math.round(better.durationMinutes - main.durationMinutes)} min).` };
    } else {
      const d = decisions.find((x) => x.alternativeRouteId && alts.some((a) => a.id === x.alternativeRouteId));
      if (d) suggestion = { altId: d.alternativeRouteId!, text: `Strategic: ${d.title} — ${d.detail}` };
    }
    return { main, alts, suggestion };
  }, [plan, altMeal, mainMeal, strategic.state.plan, mealWindow]);

  // Auto-check alternatives once (bounded: ≤ 2 lookups) when the current route's meal window looks thin.
  const autoChecked = useRef<string | null>(null);
  useEffect(() => {
    if (!plan || !routeOptions || plan.setup.dataMode === "demo") return;
    if (autoChecked.current === plan.route.id) return;
    if (routeOptions.main.mealOptions == null || routeOptions.main.mealOptions >= 3 || routeOptions.alts.length === 0) return;
    autoChecked.current = plan.route.id;
    for (const a of routeOptions.alts.slice(0, 2)) void checkAlternative(a.id);
  }, [plan?.route.id, routeOptions?.main.mealOptions, routeOptions?.alts.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------- render ----------------
  const presets: PresetOption[] = SCENARIO_PRESETS.map((p) => ({ id: p.id, title: p.title, blurb: p.blurb }));
  const recIds = result?.recommendations.map((r) => r.stopId) ?? [];
  const weatherByStop = Object.fromEntries((result?.weather?.stops ?? []).map((w) => [w.id, w]));
  const demo = plan?.setup.dataMode === "demo";

  const impactFor = (stopId: string, km: number, detour: number, dwell: number) => {
    if (!plan || !model || !leadCar) return null;
    const imp = etaImpactOfStop({ km, detourMinutes: detour, stopId }, dwell, { car: leadCar, route: model, stops, departureUtc: plan.departureUtc, timeZone: tz });
    const light = arrivalDaylight({ arrivalUtc: imp.newArrivalUtc, destLat: plan.setup.destination.lat, destLng: plan.setup.destination.lng, timeZone: tz });
    return { ...imp, afterDark: light.afterDark, sunsetLocal: light.sunsetLocal };
  };

  return (
    <div className="grid gap-3 p-3 lg:grid-cols-[320px_minmax(0,1fr)] xl:grid-cols-[320px_minmax(0,1fr)_400px]">
      {/* LEFT — setup */}
      <aside className="min-w-0 lg:row-span-2 xl:row-span-1">
        <div className="rounded-xl border border-slate-200 bg-white p-3 lg:sticky lg:top-2 lg:max-h-[calc(100vh-1rem)] lg:overflow-y-auto">
          <button type="button" onClick={() => setSetupOpen((o) => !o)} className="flex w-full items-center justify-between text-left lg:hidden" aria-expanded={setupOpen}>
            <span className="text-base font-bold text-navy">Trip setup</span>
            <span className="text-xs text-slate-500">{setupOpen ? "hide" : "edit"}</span>
          </button>
          <div className={`${setupOpen ? "block" : "hidden"} lg:block`}>
            <SetupPanel
              setup={setup}
              onChange={setSetup}
              presets={presets}
              onApplyPreset={applyPreset}
              placePresets={NAMED_PLACES}
              onPlan={() => void planRoute()}
              planning={planning}
              planError={planError}
              canStart={Boolean(setup.origin && setup.destination)}
            />
          </div>
        </div>
      </aside>

      {/* CENTER — map */}
      <section className="min-w-0 space-y-3">
        <div className="rounded-xl border border-slate-200 bg-white p-3">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                cancelHold();
                setPlaying((p) => !p);
              }}
              disabled={!plan || heldForDecision}
              title={heldForDecision ? "Simulated time is paused while Agent 2 decides; it resumes automatically." : undefined}
              className="focus-ring rounded-md bg-navy px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-40"
            >
              {heldForDecision ? "Deciding…" : playing ? "Pause" : "Play"}
            </button>
            <button type="button" onClick={() => plan && resetSim(plan.setup)} disabled={!plan} className="focus-ring rounded-md border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-40">
              Reset
            </button>
            <button type="button" onClick={() => setElapsed((e) => Math.min(e + 5, maxElapsed))} disabled={!plan} className="focus-ring rounded-md border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-40">
              +5 min
            </button>
            <label className="text-sm text-slate-600">
              Speed{" "}
              <select value={rate} onChange={(e) => setRate(Number(e.target.value))} className="focus-ring rounded border border-slate-300 px-1 py-0.5 text-sm" aria-label="Simulation speed">
                {RATES.map((r) => (
                  <option key={r} value={r}>
                    {r === 1 ? "1× real time" : `${r}×`}
                  </option>
                ))}
              </select>
            </label>
            <label className="inline-flex items-center gap-1 text-xs text-slate-600">
              <input type="checkbox" checked={watcherOn} onChange={(e) => setWatcherOn(e.target.checked)} /> ambient watcher
            </label>
            <label className="text-xs text-slate-600">
              Weather{" "}
              <select value={weatherOverride} onChange={(e) => setWeatherOverride(e.target.value as typeof weatherOverride)} className="rounded border border-slate-300 px-1 py-0.5 text-xs" aria-label="Weather override">
                <option value="live">live forecast</option>
                <option value="rain">rain (simulated)</option>
                <option value="snow">snow (simulated)</option>
                <option value="cold">cold (simulated)</option>
              </select>
            </label>
            {exitsLoading && <span className="text-[11px] text-sky-700" data-testid="exits-loading">loading exits…</span>}
            <div className="ml-auto text-right text-sm">
              <div className="font-semibold text-navy" data-testid="sim-clock">
                {plan ? `${nowLocal.time} · t+${Math.floor(elapsed)} min` : "—"}
              </div>
              {eta && (
                <div className="text-xs text-slate-600" data-testid="dest-eta">
                  ETA {eta.arrivalLocal}
                  {baselineEta && eta.arrivalLocal !== baselineEta.arrivalLocal ? ` (was ${baselineEta.arrivalLocal})` : ""} ·{" "}
                  <span className={arrivalLight?.afterDark ? "text-amber" : ""}>{arrivalLight?.afterDark ? `after dark (sunset ${arrivalLight.sunsetLocal})` : `before sunset ${arrivalLight?.sunsetLocal ?? ""}`}</span>
                </div>
              )}
            </div>
          </div>
          {plan && (
            <input
              type="range"
              min={0}
              max={maxElapsed}
              step={1}
              value={Math.floor(elapsed)}
              onChange={(e) => {
                cancelHold();
                setPlaying(false);
                setElapsed(Number(e.target.value));
              }}
              className="mt-2 w-full"
              aria-label="Scrub simulation time"
            />
          )}
          <p className="mt-1 text-[11px] text-slate-500" data-testid="data-badge">
            {!plan
              ? "Set up a trip on the left, then plan the route."
              : demo
                ? "FIXTURE EVIDENCE · recorded 401 route & exits · FICTIONAL businesses · dated mock weather · simulated driving"
                : `Route (${plan.route.source}) · OpenStreetMap places${discovering ? " (discovering…)" : ""} · weather source shown at each waypoint · simulated driving`}
          </p>
        </div>

        {model ? (
          <TripMap
            route={model}
            cars={states}
            stops={knownPlaces}
            upcomingExitIds={lead ? model.exitsAhead(lead.progressKm + (leadCar.speedKph * NOTICE_MIN) / 60, 60).map((e) => e.id) : []}
            recommendedStopIds={recIds}
            approvedStopId={activeStop?.stopId ?? null}
            excludedStopIds={skipped}
            placingCarId={null}
            followCarId={lead?.id ?? null}
            selectedStopId={selectedStopId}
            detourStopIds={stops.filter((s) => s.status !== "CANCELLED").map((s) => s.stopId)}
            onPlaceCar={onPlaceCar}
            onSelectStop={setSelectedStopId}
            alternatives={(plan?.route.alternatives ?? []).map((a) => ({
              id: a.id,
              coordinates: a.coordinates,
              label: `Alternative: ${a.summary} · ${a.durationMinutes - (plan?.route.durationMinutes ?? 0) >= 0 ? "+" : ""}${Math.round(a.durationMinutes - (plan?.route.durationMinutes ?? 0))} min (click to compare)`
            }))}
            highlightedAltId={highlightedAlt}
            onSelectAlternative={(id) => setHighlightedAlt(id)}
            heightClass="h-[360px] sm:h-[460px]"
            caption={`${model.origin} → ${model.destination} · ${model.totalKm.toFixed(0)} km · ${model.exits().length} exits · ${model.attribution}. Drag a car to reposition it.`}
          />
        ) : (
          <div className="flex h-[360px] items-center justify-center rounded-lg border border-dashed border-slate-300 bg-white text-sm text-slate-500 sm:h-[460px]">
            The real route appears here after you plan a trip.
          </div>
        )}

        {model && lead && (
          <RoadAhead
            lead={{ ...lead, speedKph: leadCar.speedKph }}
            cars={states}
            stops={knownPlaces}
            exits={model.exitsAhead(lead.progressKm - 8, 220)}
            recommendedStopIds={recIds}
            approvedStopId={activeStop?.stopId ?? null}
            excludedStopIds={skipped}
            advanceNoticeMinutes={NOTICE_MIN}
            localTime={nowLocal.time}
            horizonKm={Math.min(160, model.totalKm)}
            totalKm={model.totalKm}
            waypoints={waypoints.map((w) => ({ ...w, reading: waypointWeather[w.id] }))}
            nextOpportunityKm={watchDecision?.nextOpportunity?.km ?? null}
            gapAfterKm={watchDecision?.gapAfterKm ?? null}
            onSelectStop={setSelectedStopId}
          />
        )}
        {routeOptions && plan?.setup.dataMode !== "demo" && (
          <RouteOptions
            main={routeOptions.main}
            alternatives={routeOptions.alts}
            loading={altsLoading}
            highlightedId={highlightedAlt}
            onHighlight={setHighlightedAlt}
            onCheck={(id) => void checkAlternative(id)}
            onUse={(id) => switchToAlternative(id)}
            mealWindowLabel={mealWindow?.label ?? null}
            suggestion={routeOptions.suggestion}
          />
        )}
        {selectedStopId &&
          (() => {
            const s = knownPlaces.find((x) => x.id === selectedStopId);
            if (!s) return null;
            return (
              <div className="rounded-lg border border-slate-200 bg-white p-2 text-xs">
                <div className="flex justify-between">
                  <strong className="text-navy">{s.name}</strong>
                  <button type="button" className="underline" onClick={() => setSelectedStopId(null)}>
                    close
                  </button>
                </div>
                <p className="text-slate-600">
                  {s.exitLabel} · km {Math.round(s.distanceAlongRouteKm)} · {s.categories.join(", ")} · {s.isMock ? "FICTIONAL demo business" : `real place (${s.source}${s.osmId ? ` ${s.osmId}` : ""})`} · hours{" "}
                  {s.open24h ? "24/7" : s.hoursVerified ? `${s.opensLocal}–${s.closesLocal}` : s.openingHoursRaw ? `unverified: ${s.openingHoursRaw}` : "unknown"} · ~{s.accessMinutes} min detour
                </p>
              </div>
            );
          })()}
      </section>

      {/* RIGHT — decisions */}
      <aside className="min-w-0 space-y-3 lg:col-start-2 xl:col-start-3 xl:row-start-1">
        <section className="rounded-xl border border-slate-200 bg-white p-3" data-testid="urgency">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-bold text-navy">Right now · Tactical</h2>
            <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${URGENCY_STYLE[groupUrgency.level]}`}>urgency: {groupUrgency.level}</span>
          </div>
          <p className="mt-1 text-[11px]" data-testid="tactical-status">
            <span className="font-semibold text-navy">Tactical:</span>{" "}
            {tacticalState.status === "idle"
              ? "waiting for a reason to decide"
              : tacticalState.status === "running"
                ? "deciding now…"
                : tacticalState.status === "muse"
                  ? `Live Muse decision${tacticalState.decision ? ` ${tacticalState.decision}` : ""} in ${((tacticalState.ms ?? 0) / 1000).toFixed(1)} s`
                  : tacticalState.status === "stale"
                    ? `last result discarded as stale (${tacticalState.detail})`
                    : tacticalState.status === "error"
                      ? `error: ${tacticalState.detail}`
                      : `Recorded/Mock · deterministic ranking (${tacticalState.status}${tacticalState.detail ? `: ${tacticalState.detail.slice(0, 80)}` : ""}) in ${((tacticalState.ms ?? 0) / 1000).toFixed(1)} s`}
          </p>
          {tacticalState.headline && tacticalState.status === "muse" && <p className="mt-0.5 text-xs font-medium text-navy">“{tacticalState.headline}”</p>}
          {plan && (
            <div className="mt-2 flex flex-wrap gap-1" aria-label="Demo quick actions">
              <button type="button" onClick={() => void quickSay("we're all getting really hungry now")} disabled={chatBusy} className="rounded-full border border-slate-300 px-2 py-0.5 text-[11px] hover:bg-slate-50 disabled:opacity-40">
                😋 Hungry now
              </button>
              <button type="button" onClick={() => void quickSay("the kids really need a washroom asap")} disabled={chatBusy} className="rounded-full border border-slate-300 px-2 py-0.5 text-[11px] hover:bg-slate-50 disabled:opacity-40">
                🚻 Urgent washroom
              </button>
              <button type="button" onClick={() => setWeatherOverride((w) => (w === "rain" ? "live" : "rain"))} className={`rounded-full border px-2 py-0.5 text-[11px] ${weatherOverride === "rain" ? "border-navy bg-navy text-white" : "border-slate-300 hover:bg-slate-50"}`}>
                🌧 {weatherOverride === "rain" ? "Rain on" : "Make it rain"}
              </button>
              <button type="button" onClick={() => setSetupOpen(true)} className="rounded-full border border-slate-300 px-2 py-0.5 text-[11px] hover:bg-slate-50 lg:hidden">
                📍 Change trip
              </button>
            </div>
          )}
          <ul className="mt-1 space-y-0.5 text-xs text-slate-600">
            {(groupUrgency.reasons.length ? groupUrgency.reasons : ["no active need"]).map((r) => (
              <li key={r}>• {r}</li>
            ))}
          </ul>
          {watchDecision && <p className="mt-1 text-[11px] text-slate-500">Watcher: {watchDecision.reasons.join("; ")}</p>}
          {states.length > 1 && (
            <ul className="mt-2 grid grid-cols-3 gap-1 text-[11px]">
              {states.map((st) => (
                <li key={st.id} className="rounded bg-slate-50 px-1.5 py-1" style={{ borderLeft: `3px solid ${CAR_COLORS[st.id]}` }}>
                  <strong>{st.label}</strong> · {urgencyByCar[st.id]?.level}
                  <br />
                  km {Math.round(st.progressKm)} · {st.phase.replace("_", " ")}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-1 text-[11px] text-slate-500">
            {lead ? `Driving ${Math.round(lead.drivingMinutesSinceRest)} min since last rest · last meal ${lastMealMinutesAgo == null ? "unknown" : `${Math.round(lastMealMinutesAgo)} min ago`}${lastCompleted ? ` · last stop ${lastCompleted.name}` : ""}` : ""}
          </p>
        </section>

        {activeStop && (
          <ActiveStopCard
            plan={activeStop}
            elapsed={elapsed}
            minutesToStop={timelineArrival(activeStop) - elapsed}
            arrivalLocal={eta?.arrivalLocal ?? "—"}
            onGo={() => {
              cancelHold();
              setPlaying(true);
            }}
            onJump={() => setElapsed(Math.min(timelineArrival(activeStop), maxElapsed))}
            onSpend={() => setElapsed((activeStop.arrivedAtElapsed ?? elapsed) + activeStop.plannedDwellMinutes)}
            onDwell={(m) => dispatchStop({ type: "setDwell", stopId: activeStop.stopId, minutes: m })}
            onComplete={completeStop}
            onResume={() => undefined}
            onCancel={() => dispatchStop({ type: "cancel", stopId: activeStop.stopId }, `Cancelled ${activeStop.name}`)}
          />
        )}
        {lastCompleted && !activeStop && (
          <ActiveStopCard
            plan={lastCompleted}
            elapsed={elapsed}
            minutesToStop={0}
            arrivalLocal={eta?.arrivalLocal ?? "—"}
            onGo={() => undefined}
            onJump={() => undefined}
            onSpend={() => undefined}
            onDwell={() => undefined}
            onComplete={() => undefined}
            onResume={() => {
              if (dispatchStop({ type: "resume", stopId: lastCompleted.stopId, elapsed }, `Resumed driving from ${lastCompleted.name}`)) {
                cancelHold();
                setPlaying(true);
              }
            }}
            onCancel={() => undefined}
          />
        )}

        <section className="rounded-xl border border-slate-200 bg-white p-3">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-bold text-navy">Recommended stops</h2>
            <button type="button" onClick={() => void runDecision("manual")} disabled={!plan || loading} className="focus-ring rounded-md border border-navy/20 px-2 py-1 text-xs font-semibold text-navy disabled:opacity-40">
              {loading ? "Deciding…" : "Replan now"}
            </button>
          </div>
          {loading && (
            <p className="mt-1 text-xs text-slate-500">
              Agent 2 is checking available places and weather evidence at arrival…{heldForDecision ? " (simulated time paused meanwhile)" : ""}
            </p>
          )}
          {error && (
            <p className="mt-1 rounded bg-red-50 p-2 text-xs text-red-800" role="alert">
              Couldn’t get a decision — this is an error, not “no stop needed”. {error}
            </p>
          )}
          {!result && !loading && !error && <p className="mt-1 text-xs text-slate-500">{plan ? "Watching the trip — Agent 2 is called only when a stop decision is useful." : "Plan a trip to start."}</p>}
          {result?.action === "STAY_SILENT" && (
            <p className="mt-1 rounded bg-slate-100 p-2 text-xs text-slate-700" data-testid="stay-silent">
              {result.triggerReasons.length === 0
                ? "No stop needed right now — staying quiet."
                : result.tactical?.decision === "SEARCH_FARTHER" || (result.urgency && result.urgency.level !== "low" && result.urgency.level !== "none")
                  ? `No suitable reachable place is known yet for this ${result.urgency?.level}-urgency need — searching the road ahead${discovering ? " (discovering places…)" : ""}. ${result.rejected.length ? `${result.rejected.length} place(s) were checked and didn't fit.` : ""}`
                  : `Nothing worth interrupting for yet (${result.urgency?.level} urgency).`}
            </p>
          )}
          <div className="mt-2 space-y-2">
            {result?.action !== "STAY_SILENT" &&
              result?.recommendations.map((rec) => {
                const stop = result.recommendedStops?.find((s) => s.id === rec.stopId) ?? knownPlaces.find((s) => s.id === rec.stopId);
                const dwell = dwellDraft[rec.stopId] ?? defaultDwellMinutes(stop?.categories ?? [], plan?.setup.mealPreference);
                const detour = Math.max(...Object.values(rec.detourMinutesByCar).filter(Number.isFinite), 0);
                return (
                  <RecommendationCard
                    key={rec.stopId}
                    rec={rec}
                    stop={stop}
                    minutesToExit={stop && lead ? ((stop.distanceAlongRouteKm - lead.progressKm) / leadCar.speedKph) * 60 : 0}
                    weather={weatherByStop[rec.stopId]}
                    dwell={dwell}
                    onDwell={(m) => setDwellDraft((d) => ({ ...d, [rec.stopId]: m }))}
                    impact={stop ? impactFor(rec.stopId, stop.distanceAlongRouteKm, detour, dwell) : null}
                    cars={plan?.setup.cars ?? []}
                    participants={participantsDraft[rec.stopId] ?? plan?.setup.cars.map((c) => c.id) ?? []}
                    onParticipants={(ids) => setParticipantsDraft((p) => ({ ...p, [rec.stopId]: ids }))}
                    onSelect={() => selectRec(rec.stopId)}
                    onSkip={() => {
                      setSkipped((s) => [...s, rec.stopId]);
                      memoryRef.current = { ...memoryRef.current, lastKey: null, lastCallElapsed: null, lastRecommendedKm: null, lastRecommendedStopId: null };
                      setMemory(memoryRef.current);
                      setResult((r) => (r ? { ...r, recommendations: r.recommendations.filter((x) => x.stopId !== rec.stopId) } : r));
                      pushLog("stop", `Skipped ${rec.name}`);
                    }}
                    disabled={Boolean(activeStop)}
                  />
                );
              })}
          </div>
        </section>

        {plan && (
          <StrategicPanel
            state={strategic.state}
            isCurrent={strategic.isCurrent}
            expired={strategic.expired}
            leadKm={lead?.progressKm ?? 0}
            placeName={(id) => knownPlaces.find((p) => p.id === id)?.name ?? null}
            update={strategicUpdate}
            onAskTactical={() => {
              setStrategicUpdate(null);
              if (activeStop) return; // never re-decide in the middle of a detour
              memoryRef.current = { ...memoryRef.current, lastKey: null, lastCallElapsed: null };
              setMemory(memoryRef.current);
              void runRef.current("manual");
            }}
            onDismissUpdate={() => setStrategicUpdate(null)}
          />
        )}

        <section className="rounded-xl border border-slate-200 bg-white p-3">
          <h2 className="text-base font-bold text-navy">Talk to Uncongest</h2>
          <div className="mt-1 flex flex-wrap gap-1 text-xs">
            <select value={chatCar} onChange={(e) => setChatCar(e.target.value)} className="rounded border border-slate-300 px-1 py-0.5" aria-label="Speaking car">
              {(plan?.setup.cars ?? setup.cars).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
            <select value={chatSource} onChange={(e) => setChatSource(e.target.value as typeof chatSource)} className="rounded border border-slate-300 px-1 py-0.5" aria-label="Message source">
              <option value="copassenger_text">💬 passenger text</option>
              <option value="driver_voice">🎙 driver voice transcript</option>
            </select>
          </div>
          <div className="mt-1 flex gap-1">
            <input
              value={chatText}
              onChange={(e) => setChatText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void sendMessage()}
              placeholder='e.g. "kids really need a washroom"'
              className="focus-ring min-w-0 flex-1 rounded-md border border-slate-300 px-2 py-1 text-sm"
              aria-label="Message"
              disabled={!plan}
            />
            <button type="button" onClick={() => void sendMessage()} disabled={!plan || chatBusy} className="rounded-md bg-teal px-3 py-1 text-sm font-semibold text-white disabled:opacity-40">
              {chatBusy ? "…" : "Send"}
            </button>
          </div>
        </section>

        <Inspector
          perf={{
            tactical: summarize(tacticalSamples, 5000),
            strategic: summarize(strategicSamples, 30000),
            staleTactical,
            staleStrategic: strategic.state.staleRejected,
            timings,
            strategicStatus: strategic.state.status,
            strategicTrace: strategic.state.meta?.toolTrace ?? [],
            strategicMuse: strategic.state.meta?.muse
          }}
          result={result} usage={usage} request={lastRequest} agent1={agent1} contextIncluded={agentContext?.includedBecause ?? []} prefetchTrace={prefetchTrace} />

        <section className="rounded-xl border border-slate-200 bg-white p-3">
          <h2 className="text-sm font-bold text-navy">Trip log</h2>
          <ul className="mt-1 max-h-56 space-y-0.5 overflow-auto text-[11px]" data-testid="trip-log">
            {log.length === 0 && <li className="text-slate-500">Nothing yet.</li>}
            {log.map((l, i) => (
              <li key={i} className={l.kind === "error" ? "text-red-700" : l.kind === "agent2" ? "font-semibold text-teal" : l.kind === "watcher" ? "text-sky-700" : l.kind === "stop" ? "text-navy" : "text-slate-600"}>
                <span className="font-mono text-slate-400">{l.time}</span> {l.text}
              </li>
            ))}
          </ul>
        </section>
      </aside>
    </div>
  );
}
