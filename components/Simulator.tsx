"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import RoadAhead, { type RoadAheadWaypoint } from "./RoadAhead";
import {
  CAR_COLORS,
  CAR_IDS,
  carStateAt,
  defaultSimCar,
  loadScenario,
  localTimeAt,
  placeCar,
  placeFollowerPlausibly,
  elapsedToReach,
  arrivalElapsed,
  ROUTE_TOTAL_KM,
  type SimCar,
  type SimCarState
} from "@/lib/simulator/simulator";
import { exitsAhead, nearestKm, pointAtKm } from "@/lib/route/route";
import { allFixtureStops } from "@/lib/providers/places";
import {
  applyIntentUpdate,
  clearCoveredNeeds,
  emptyCarIntent,
  expireNeeds,
  regexIntentUpdate,
  toCollective,
  type CarIntent,
  type IntentAgentOutput
} from "@/lib/domain/carIntent";
import { evaluateUrgency, HORIZON, maxUrgency, type UrgencyLevel, type UrgencyResult } from "@/lib/domain/urgency";
import { EMPTY_MEMORY, watch, type WatchMemory } from "@/lib/domain/watcher";
import { addMinutesLocal, todayLocalDate } from "@/lib/providers/weather";
import type { EngineResult, Recommendation, Weather, WeatherSnapshot } from "@/lib/domain/types";

const TripMap = dynamic(() => import("./TripMap"), {
  ssr: false,
  loading: () => <div className="flex h-[420px] items-center justify-center rounded-lg border border-slate-200 bg-slate-100 text-sm text-slate-500 sm:h-[480px]">Loading map…</div>
});

const WEATHERS: Weather[] = ["sunny", "cloudy", "rain", "snow", "cold"];
const RATES = [1, 10, 60, 120, 300];
const CHIPS: Array<{ text: string; source: "driver_voice" | "copassenger_text" }> = [
  { text: "kids really need a washroom", source: "copassenger_text" },
  { text: "we're getting hungry, vegetarian please", source: "copassenger_text" },
  { text: "quick coffee at the next good spot", source: "driver_voice" },
  { text: "actually no coffee", source: "driver_voice" },
  { text: "we already ate", source: "copassenger_text" },
  { text: "halal food for us", source: "copassenger_text" }
];
const SUNSET = "17:00"; // approx. early-November sunset on the corridor
const STOPS = allFixtureStops();

interface LogEntry {
  time: string;
  text: string;
  kind: "info" | "watcher" | "agent1" | "agent2" | "approval" | "silent" | "error";
}
interface ChatMessage {
  time: string;
  carId: string;
  source: "driver_voice" | "copassenger_text";
  text: string;
  understood: string[];
  provider: string;
}
interface ApiError {
  status: number;
  message: string;
  issues?: Array<{ path: Array<string | number>; message: string }>;
}
interface Inspect {
  request: unknown;
  status: number | null;
  response: unknown;
}

const URGENCY_STYLE: Record<UrgencyLevel, string> = {
  none: "bg-slate-100 text-slate-600",
  low: "bg-sky-100 text-sky-800",
  moderate: "bg-amber/15 text-amber",
  high: "bg-red-100 text-red-700"
};

function initialIntents(): Record<string, CarIntent> {
  return { car_a: emptyCarIntent("car_a", { kids: true, dietary: ["vegetarian"] }) };
}

function toMin(hhmm: string) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export default function Simulator({ autoDemo = false }: { autoDemo?: boolean }) {
  const sc = loadScenario();
  const localDate = useMemo(() => todayLocalDate(), []);

  // ---- authoritative trip state ----
  const [departure, setDeparture] = useState("09:30");
  const [elapsed, setElapsed] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(60);
  const [simCars, setSimCars] = useState<SimCar[]>([defaultSimCar("car_a")]);
  const [intents, setIntents] = useState<Record<string, CarIntent>>(initialIntents);
  const [weatherMode, setWeatherMode] = useState<"live" | "simulated">("live");
  const [simWeather, setSimWeather] = useState<Weather>("sunny");
  const [traffic, setTraffic] = useState(5);
  const [mealHistory, setMealHistory] = useState<"unknown" | "before_departure">("unknown");
  const [lastStop, setLastStop] = useState<{ elapsed: number; stopId: string; meal: boolean } | null>(null);
  const [watcherOn, setWatcherOn] = useState(true);
  const [placingCarId, setPlacingCarId] = useState<string | null>(null);
  const [followLead, setFollowLead] = useState(true);
  const [selectedStopId, setSelectedStopId] = useState<string | null>(null);

  // ---- decision state ----
  const [result, setResult] = useState<EngineResult | null>(null);
  const [resultStale, setResultStale] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const [approved, setApproved] = useState<string | null>(null);
  const [votes, setVotes] = useState<Record<string, Record<string, "join" | "skip">>>({});
  const [skipped, setSkipped] = useState<string[]>([]);
  const [memory, setMemory] = useState<WatchMemory>(EMPTY_MEMORY);
  const memoryRef = useRef<WatchMemory>(EMPTY_MEMORY);
  const loadingRef = useRef(false);

  // ---- conversation / UI ----
  const [chatText, setChatText] = useState("");
  const [chatCar, setChatCar] = useState("car_a");
  const [chatSource, setChatSource] = useState<"driver_voice" | "copassenger_text">("copassenger_text");
  const [chatBusy, setChatBusy] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [voiceOn, setVoiceOn] = useState(false);
  const [listening, setListening] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [inspectTab, setInspectTab] = useState<"agent2" | "agent1">("agent2");
  const [agent2Inspect, setAgent2Inspect] = useState<Inspect | null>(null);
  const [agent1Inspect, setAgent1Inspect] = useState<Inspect | null>(null);
  const [waypointWeather, setWaypointWeather] = useState<Record<string, WeatherSnapshot>>({});
  const spokenRef = useRef<string | null>(null);

  const localTime = localTimeAt(elapsed, departure);
  const cars: SimCarState[] = useMemo(() => simCars.map((c) => carStateAt(c, elapsed)), [simCars, elapsed]);
  const lead = cars.find((c) => c.role === "lead") ?? cars[0];
  const pushLog = useCallback((kind: LogEntry["kind"], text: string, time?: string) => {
    setLog((l) => [...l.slice(-80), { time: time ?? "", text, kind }]);
  }, []);
  const timeRef = useRef(localTime);
  timeRef.current = localTime;
  const logNow = useCallback((kind: LogEntry["kind"], text: string) => pushLog(kind, text, timeRef.current), [pushLog]);

  // Fixed trip scale: departure → last car's arrival in Montréal.
  const maxElapsed = useMemo(() => Math.ceil(Math.max(...simCars.map(arrivalElapsed))), [simCars]);
  const leadSim = simCars.find((c) => c.role === "lead") ?? simCars[0];
  const leadArrivalLocal = localTimeAt(arrivalElapsed(leadSim), departure);

  // ---- playback: 1× is real time (1 simulated second per real second) ----
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

  // ---- derived context ----
  const minutesSinceLastStop = elapsed - (lastStop?.elapsed ?? 0);
  const lastMealMinutesAgo = lastStop?.meal ? elapsed - lastStop.elapsed : mealHistory === "before_departure" ? elapsed : null;
  const daylightMinutes = Math.max(0, toMin(SUNSET) - toMin(localTime));
  const activeIntents = cars.map((c) => intents[c.id] ?? emptyCarIntent(c.id));

  const urgencyByCar: Record<string, UrgencyResult> = useMemo(() => {
    const out: Record<string, UrgencyResult> = {};
    for (const c of cars) {
      const i = intents[c.id] ?? emptyCarIntent(c.id);
      out[c.id] = evaluateUrgency(
        {
          needs: i.needs.map((n) => n.need),
          hungerLevel: i.hungerLevel,
          restroomUrgent: i.restroomUrgent,
          notHungry: i.notHungry,
          kids: c.kids || i.kids,
          ev: c.ev,
          batteryPercent: c.batteryPercent
        },
        { elapsedMinutes: elapsed, localTime, minutesSinceLastStop, lastMealMinutesAgo }
      );
    }
    return out;
  }, [cars, intents, elapsed, localTime, minutesSinceLastStop, lastMealMinutesAgo]);
  const groupUrgency = maxUrgency(Object.values(urgencyByCar));

  const approvedStop = approved ? STOPS.find((s) => s.id === approved) ?? null : null;
  const groupDietKey = [...new Set(activeIntents.flatMap((i) => i.dietary))].sort().join(",");
  const groupDiet = useMemo(() => (groupDietKey ? (groupDietKey.split(",") as CarIntent["dietary"]) : []), [groupDietKey]);
  const watchDecision = useMemo(
    () =>
      watch({
        elapsedMinutes: elapsed,
        lead: { id: lead.id, progressKm: lead.progressKm, speedKph: lead.speedKph },
        urgency: groupUrgency,
        stops: STOPS,
        advanceNoticeMinutes: sc.config.advanceNoticeMinutes,
        routeTotalKm: ROUTE_TOTAL_KM,
        excludedStopIds: skipped,
        confirmedStopPending: Boolean(approvedStop && approvedStop.distanceAlongRouteKm > lead.progressKm),
        requiredDiet: groupDiet,
        avoidRegion: sc.config.avoidRegion,
        memory
      }),
    [elapsed, lead.id, lead.progressKm, lead.speedKph, groupUrgency, skipped, approvedStop, memory, sc.config.advanceNoticeMinutes, sc.config.avoidRegion, groupDiet]
  );

  const noticeKm = (lead.speedKph * sc.config.advanceNoticeMinutes) / 60;
  const upcomingExits = useMemo(() => exitsAhead(lead.progressKm + noticeKm, 60), [lead.progressKm, noticeKm]);

  // ---- Agent 2 call ----
  const buildRequest = useCallback(() => {
    const collective = toCollective(activeIntents.map((i, idx) => ({ ...i, kids: i.kids || cars[idx].kids })));
    return {
      trip: {
        destination: sc.destination,
        direction: "eastbound" as const,
        highway: "401",
        elapsedMinutes: Math.round(elapsed),
        localTime,
        minutesSinceLastStop: Math.round(minutesSinceLastStop),
        localDate,
        lastMealMinutesAgo: lastMealMinutesAgo == null ? null : Math.round(lastMealMinutesAgo)
      },
      config: { ...sc.config, requiredDiet: [] },
      cars: cars.map((c) => ({
        id: c.id,
        label: c.label,
        role: c.role,
        progressKm: c.progressKm,
        speedKph: c.speedKph,
        passengers: c.passengers,
        kids: c.kids || (intents[c.id]?.kids ?? false),
        ev: c.ev,
        connector: c.connector,
        batteryPercent: c.batteryPercent,
        positionUpdatedMinutesAgo: c.positionUpdatedMinutesAgo,
        needs: (intents[c.id]?.needs ?? []).map((n) => n.need),
        lat: c.lat,
        lng: c.lng,
        headingDeg: c.headingDeg
      })),
      collectiveIntent: { ...collective, notHungry: activeIntents.length > 0 && activeIntents.every((i) => i.notHungry) },
      environment: { weather: simWeather, trafficDelayMinutes: traffic, daylightMinutes },
      options: { weatherMode, excludeStopIds: skipped }
    };
  }, [activeIntents, cars, intents, sc, elapsed, localTime, minutesSinceLastStop, localDate, lastMealMinutesAgo, simWeather, traffic, daylightMinutes, weatherMode, skipped]);

  const runRecommendation = useCallback(
    async (trigger: "watcher" | "manual", key?: string) => {
      if (loadingRef.current) return;
      loadingRef.current = true;
      setLoading(true);
      const body = buildRequest();
      setAgent2Inspect({ request: body, status: null, response: null });
      if (key) {
        memoryRef.current = { ...memoryRef.current, lastKey: key, lastCallElapsed: elapsed };
        setMemory(memoryRef.current);
      }
      try {
        const res = await fetch("/api/recommend-stops", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        const data = await res.json().catch(() => null);
        setAgent2Inspect({ request: body, status: res.status, response: data });
        if (!res.ok) {
          const err: ApiError = { status: res.status, message: data?.error ?? `HTTP ${res.status}`, issues: data?.issues };
          setError(err);
          setResultStale(true);
          logNow("error", `Agent 2 FAILED (HTTP ${res.status}: ${err.message}${err.issues?.length ? ` — ${err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` : ""})`);
          return;
        }
        const r = data as EngineResult;
        setError(null);
        setResult(r);
        setResultStale(false);
        const top = r.recommendations[0];
        const topStop = top ? STOPS.find((s) => s.id === top.stopId) : null;
        memoryRef.current = {
          ...memoryRef.current,
          lastRecommendedKm: topStop ? topStop.distanceAlongRouteKm : null,
          lastRecommendedStopId: top?.stopId ?? null
        };
        setMemory(memoryRef.current);
        if (r.action === "STAY_SILENT") {
          logNow("silent", `Agent 2 (${r.provider}) → STAY_SILENT [${r.urgency?.level ?? "?"}]: ${r.triggerReasons.join("; ") || "no active trigger"}`);
        } else {
          logNow("agent2", `Agent 2 (${r.provider}) → ${r.action} [${r.urgency?.level ?? "?"} urgency, ${trigger}]: ${r.recommendations.map((x) => `#${x.rank} ${x.name}`).join(", ")}`);
          const speak = r.speakMessage || (top ? `Uncongest suggests ${top.name}.` : "");
          if (voiceOn && speak && spokenRef.current !== top?.stopId) {
            spokenRef.current = top?.stopId ?? null;
            try {
              window.speechSynthesis.cancel();
              window.speechSynthesis.speak(new SpeechSynthesisUtterance(speak));
            } catch {
              /* speech unsupported */
            }
          }
        }
      } catch (err) {
        setError({ status: 0, message: `network error: ${(err as Error).message}` });
        setResultStale(true);
        logNow("error", `Agent 2 FAILED (network: ${(err as Error).message})`);
      } finally {
        loadingRef.current = false;
        setLoading(false);
      }
    },
    [buildRequest, elapsed, logNow, voiceOn]
  );
  const runRef = useRef(runRecommendation);
  runRef.current = runRecommendation;

  // ---- Ambient Trip Watcher: deterministic, triggers Agent 2 only when a decision is needed ----
  useEffect(() => {
    if (!watcherOn || !watchDecision.shouldCall || loadingRef.current) return;
    logNow("watcher", `Watcher → call Agent 2: ${watchDecision.reasons.join("; ")}`);
    void runRef.current("watcher", watchDecision.key);
  }, [watcherOn, watchDecision.shouldCall, watchDecision.key]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- confirmed stop reached: clear covered needs, record last stop / meal ----
  useEffect(() => {
    if (!approvedStop || lead.progressKm < approvedStop.distanceAlongRouteKm) return;
    const covered = approvedStop.categories;
    setIntents((prev) => Object.fromEntries(Object.entries(prev).map(([id, i]) => [id, clearCoveredNeeds(i, covered)])));
    setLastStop({ elapsed, stopId: approvedStop.id, meal: covered.includes("meal") });
    setApproved(null);
    setResult(null);
    memoryRef.current = EMPTY_MEMORY;
    setMemory(EMPTY_MEMORY);
    logNow("approval", `Reached confirmed stop ${approvedStop.name} — cleared [${covered.join(", ")}]; last stop reset`);
  }, [lead.progressKm, approvedStop]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- expire stale temporary needs ----
  const fiveMin = Math.floor(elapsed / 5);
  useEffect(() => {
    setIntents((prev) => {
      let changed = false;
      const next = Object.fromEntries(
        Object.entries(prev).map(([id, i]) => {
          const e = expireNeeds(i, elapsed);
          if (e !== i) changed = true;
          return [id, e];
        })
      );
      return changed ? next : prev;
    });
  }, [fiveMin]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- weather at waypoints along the road ahead (ETA-based), cached server-side ----
  const waypoints: RoadAheadWaypoint[] = useMemo(() => {
    const speed = Math.max(lead.speedKph, 1);
    return [0, 40, 80, 120]
      .map((d) => Math.min(lead.progressKm + d, ROUTE_TOTAL_KM))
      .filter((km, i, arr) => arr.indexOf(km) === i)
      .map((km, i) => ({ id: `wp${i}`, km, etaMinutes: ((km - lead.progressKm) / speed) * 60 }));
  }, [lead.progressKm, lead.speedKph]);
  const weatherKey = `${weatherMode}|${simWeather}|${Math.floor(lead.progressKm / 10)}|${localTime.slice(0, 2)}`;
  useEffect(() => {
    const ctrl = new AbortController();
    const pts = waypoints.map((w) => {
      const p = pointAtKm(w.km);
      return { id: w.id, lat: p.lat, lng: p.lng, localDateTime: addMinutesLocal(localDate, localTime, w.etaMinutes) };
    });
    fetch("/api/weather", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: weatherMode, fallback: simWeather, points: pts }),
      signal: ctrl.signal
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { readings: WeatherSnapshot[] }) => setWaypointWeather(Object.fromEntries(d.readings.map((r) => [r.id, r]))))
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setWaypointWeather({});
      });
    return () => ctrl.abort();
  }, [weatherKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- scripted demo: one car, early start, lunch passing, watcher on ----
  useEffect(() => {
    if (!autoDemo) return;
    setRate(120);
    setPlaying(true);
    logNow("info", "Scripted demo: Car A left Toronto at 09:30; meal history unknown; watcher on at 120×.");
  }, [autoDemo]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- actions ----
  const reset = () => {
    setPlaying(false);
    setElapsed(0);
    setSimCars([defaultSimCar("car_a")]);
    setIntents(initialIntents());
    setResult(null);
    setResultStale(false);
    setError(null);
    setApproved(null);
    setVotes({});
    setSkipped([]);
    setLastStop(null);
    setMessages([]);
    setLog([]);
    setAgent1Inspect(null);
    setAgent2Inspect(null);
    setPlacingCarId(null);
    setSelectedStopId(null);
    memoryRef.current = EMPTY_MEMORY;
    setMemory(EMPTY_MEMORY);
    spokenRef.current = null;
    if (autoDemo) setPlaying(true);
  };

  const updateCar = (id: string, fn: (c: SimCar) => SimCar) => setSimCars((prev) => prev.map((c) => (c.id === id ? fn(c) : c)));

  const onPlaceCar = (carId: string, lat: number, lng: number) => {
    const { km, offRouteKm } = nearestKm(lat, lng);
    const snapped = offRouteKm > 1 ? ` (snapped ${offRouteKm.toFixed(1)} km to the route)` : "";
    const target = simCars.find((c) => c.id === carId);
    setPlacingCarId(null);
    if (!target) return;
    if (target.role === "lead") {
      // The lead car departed Toronto at the departure time: its position defines the clock.
      const newElapsed = elapsedToReach(km, target.speedKph);
      setSimCars((prev) =>
        prev.map((c) => {
          if (c.id === carId) return { ...c, anchorKm: 0, anchorElapsed: 0, gpsFrozenAtElapsed: c.gpsFrozenAtElapsed != null ? newElapsed : null };
          // other cars keep their place on the road, limited to what they could have reached by then
          return placeFollowerPlausibly(c, carStateAt(c, elapsed).progressKm, newElapsed).car;
        })
      );
      setElapsed(newElapsed);
      if (lastStop && lastStop.elapsed > newElapsed) setLastStop(null);
      memoryRef.current = EMPTY_MEMORY;
      setMemory(EMPTY_MEMORY);
      setResult(null);
      setApproved(null);
      pushLog(
        "info",
        `${target.label} placed at km ${km.toFixed(1)}${snapped} → clock ${localTimeAt(newElapsed, departure)} (t+${Math.floor(newElapsed)}), consistent with departing ${departure} at ${target.speedKph} km/h; watcher re-evaluates`,
        localTimeAt(newElapsed, departure)
      );
      return;
    }
    const placed = placeFollowerPlausibly(target, km, elapsed);
    updateCar(carId, () => placed.car);
    logNow(
      "info",
      placed.clamped
        ? `${target.label} can't be at km ${km.toFixed(0)} by ${localTime} (left ${departure} at ${target.speedKph} km/h) — placed at the farthest reachable point, km ${placed.km.toFixed(1)}`
        : `${target.label} placed at km ${placed.km.toFixed(1)}${snapped}`
    );
  };

  const addCar = () => {
    const id = CAR_IDS.find((x) => !simCars.some((c) => c.id === x));
    if (!id) return;
    const lastKm = Math.min(...cars.map((c) => c.progressKm));
    const car = placeFollowerPlausibly(defaultSimCar(id), Math.max(lastKm - 6, 0), elapsed).car;
    setSimCars((p) => [...p, car]);
    setIntents((p) => ({ ...p, [id]: p[id] ?? emptyCarIntent(id) }));
    logNow("info", `${car.label} joined at km ${car.anchorKm.toFixed(0)}`);
  };
  const removeCar = (id: string) => {
    setSimCars((p) => p.filter((c) => c.id !== id));
    setVotes((v) => Object.fromEntries(Object.entries(v).map(([s, byCar]) => [s, Object.fromEntries(Object.entries(byCar).filter(([c]) => c !== id))])));
    logNow("info", `${id} left the trip`);
  };

  const sendMessage = async (text: string, carId = chatCar, source = chatSource) => {
    const t = text.trim();
    if (!t || chatBusy) return;
    setChatBusy(true);
    const body = {
      carId,
      source,
      text: t,
      localTime,
      cars: cars.map((c) => ({ id: c.id, label: c.label })),
      current: Object.fromEntries(
        activeIntents.map((i, idx) => [
          i.carId,
          {
            needs: i.needs.map((n) => n.need),
            hungerLevel: i.hungerLevel,
            restroomUrgent: i.restroomUrgent,
            notHungry: i.notHungry,
            dietary: i.dietary,
            kids: i.kids || cars[idx].kids,
            history: i.history
          }
        ])
      )
    };
    setAgent1Inspect({ request: body, status: null, response: null });
    let out: (IntentAgentOutput & { provider: string }) | null = null;
    try {
      const res = await fetch("/api/intent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => null);
      setAgent1Inspect({ request: body, status: res.status, response: data });
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      out = data;
    } catch (err) {
      out = { ...regexIntentUpdate(carId, t), provider: `client regex fallback (${(err as Error).message})` };
    }
    const result = out!;
    setIntents((prev) => {
      const next = { ...prev };
      for (const u of result.updates) {
        const cur = next[u.carId] ?? emptyCarIntent(u.carId);
        next[u.carId] = applyIntentUpdate(cur, u, elapsed, u.carId === carId ? t : undefined);
      }
      return next;
    });
    for (const u of result.updates) if (u.kids === true) updateCar(u.carId, (c) => ({ ...c, kids: true }));
    setMessages((m) => [...m.slice(-30), { time: localTime, carId, source, text: t, understood: result.understood, provider: result.provider }]);
    logNow("agent1", `Agent 1 (${result.provider}) ${carId} ${source === "driver_voice" ? "🎙 driver" : "💬 passenger"}: "${t}" → ${result.understood.join("; ") || "no change"}`);
    setChatText("");
    setChatBusy(false);
  };

  const startVoice = () => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      logNow("info", "Speech recognition isn't available in this browser — type the driver transcript instead.");
      return;
    }
    const rec = new SR();
    rec.lang = "en-CA";
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    setListening(true);
    rec.onresult = (e: any) => {
      const transcript = e.results?.[0]?.[0]?.transcript ?? "";
      setChatSource("driver_voice");
      void sendMessage(transcript, chatCar, "driver_voice");
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    rec.start();
  };

  const approve = (stopId: string) => {
    setApproved(stopId);
    setVotes((v) => ({ ...v, [stopId]: { ...(v[stopId] ?? {}), [lead.id]: "join" } }));
    logNow("approval", `Lead approved ${stopId}; Maps handoff ready; watcher quiet until reached`);
  };
  const skipStop = (stopId: string) => {
    setSkipped((s) => (s.includes(stopId) ? s : [...s, stopId]));
    if (approved === stopId) setApproved(null);
    logNow("approval", `Group skipped ${stopId}; re-planning without it`);
    memoryRef.current = { ...memoryRef.current, lastKey: null, lastCallElapsed: null };
    setMemory(memoryRef.current);
  };
  const vote = (stopId: string, carId: string, v: "join" | "skip") => {
    setVotes((prev) => ({ ...prev, [stopId]: { ...(prev[stopId] ?? {}), [carId]: v } }));
    logNow("approval", `${carId} voted ${v.toUpperCase()} on ${stopId}`);
  };

  // Re-plan immediately after a skip (state settles first).
  const skippedKey = skipped.join(",");
  useEffect(() => {
    if (skipped.length && result) void runRef.current("manual");
  }, [skippedKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const recIds = result && !resultStale ? result.recommendations.map((r) => r.stopId) : [];
  const weatherByStop = Object.fromEntries((result?.weather?.stops ?? []).map((w) => [w.id, w]));

  const card = (r: Recommendation) => {
    const stop = STOPS.find((s) => s.id === r.stopId);
    const w = weatherByStop[r.stopId];
    const stopVotes = votes[r.stopId] ?? {};
    return (
      <div key={r.stopId} className={`rounded-xl border bg-white p-4 shadow-sm ${approved === r.stopId ? "border-teal" : "border-slate-200"}`}>
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-teal">
              #{r.rank} · {r.kind}
            </p>
            <h3 className="text-lg font-bold text-navy">{r.name}</h3>
            <p className="text-xs text-slate-500">
              {stop?.exitLabel ?? stop?.exitId} · km {stop?.distanceAlongRouteKm} · lead reaches exit in ~
              {Math.round(((stop?.distanceAlongRouteKm ?? 0) - lead.progressKm) / Math.max(lead.speedKph, 1) * 60)} min
            </p>
          </div>
          <span className="rounded bg-amber/15 px-2 py-1 text-[10px] font-semibold text-amber">FICTIONAL BUSINESS</span>
        </div>
        <p className="mt-2 text-sm text-slate-700">{r.reason}</p>
        <ul className="mt-2 space-y-1 text-sm text-slate-600">
          {r.tradeoffs.map((t) => (
            <li key={t}>• {t}</li>
          ))}
        </ul>
        {w && (
          <p className={`mt-2 text-xs ${w.source === "open-meteo" ? "text-navy" : "text-amber"}`}>
            Weather at arrival ({w.forHour.slice(11, 16)}): {w.tempC != null ? `${Math.round(w.tempC)}°C, ` : ""}
            {w.description}
            {w.precipProbability != null ? `, ${w.precipProbability}% precip.` : ""} · {w.source === "open-meteo" ? `Open-Meteo${w.stale ? " (stale)" : ""}` : w.note ?? "simulated"}
          </p>
        )}
        <p className="mt-1 text-xs text-slate-500">
          Detour: {Object.entries(r.detourMinutesByCar).map(([k, v]) => `${k.replace("car_", "").toUpperCase()} +${Number.isFinite(v) ? v.toFixed(0) : "∞"}m`).join(" · ")}
          {cars.length > 1 && ` · group wait ${r.maxGroupWaitMinutes.toFixed(0)}m`}
        </p>
        {r.risks.length > 0 && (
          <ul className="mt-2 space-y-0.5 text-xs text-amber">
            {r.risks.map((risk) => (
              <li key={risk}>⚠ {risk}</li>
            ))}
          </ul>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <button onClick={() => approve(r.stopId)} className="focus-ring rounded-md bg-teal px-3 py-2 text-sm font-semibold text-white hover:bg-teal/90">
            {approved === r.stopId ? "Approved ✓" : "Lead approve"}
          </button>
          <a href={r.mapsUrl} target="_blank" rel="noreferrer" className="focus-ring rounded-md border border-navy/20 px-3 py-2 text-sm font-semibold text-navy hover:bg-slate-50">
            Open in Google Maps
          </a>
          <button onClick={() => skipStop(r.stopId)} className="focus-ring rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50">
            Skip this stop
          </button>
        </div>
        {approved === r.stopId && cars.length > 1 && (
          <div className="mt-3 flex flex-wrap gap-3 rounded-lg bg-teal/10 p-2 text-xs text-teal">
            {cars.map((c) => (
              <span key={c.id} className="inline-flex items-center gap-1">
                <strong>{c.label}</strong>
                <button className="focus-ring rounded border border-teal/40 px-1.5" onClick={() => vote(r.stopId, c.id, "join")}>
                  join
                </button>
                <button className="focus-ring rounded border border-teal/40 px-1.5" onClick={() => vote(r.stopId, c.id, "skip")}>
                  skip
                </button>
                {stopVotes[c.id] ? `(${stopVotes[c.id]})` : ""}
              </span>
            ))}
          </div>
        )}
      </div>
    );
  };

  const nextOpp = watchDecision.nextOpportunity;
  const nextOppStop = nextOpp ? STOPS.find((s) => s.id === nextOpp.stopId) : null;

  return (
    <div className="grid gap-4 p-3 sm:p-4 xl:grid-cols-[1fr_400px]">
      <section className="min-w-0 space-y-4">
        {/* ---- playback ---- */}
        <div className="rounded-xl border border-slate-200 bg-white p-3 sm:p-4">
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => setPlaying((p) => !p)} className="focus-ring rounded-md bg-navy px-3 py-2 text-sm font-semibold text-white">
              {playing ? "Pause" : "Play"}
            </button>
            <button onClick={reset} className="focus-ring rounded-md border border-slate-300 px-3 py-2 text-sm">
              Reset
            </button>
            <button onClick={() => setElapsed((e) => Math.min(e + 5, maxElapsed))} className="focus-ring rounded-md border border-slate-300 px-3 py-2 text-sm">
              +5 min
            </button>
            <label className="text-sm text-slate-600">
              Rate
              <select value={rate} onChange={(e) => setRate(Number(e.target.value))} className="focus-ring ml-1 rounded border border-slate-300 px-2 py-1 text-sm">
                {RATES.map((s) => (
                  <option key={s} value={s}>
                    {s === 1 ? "1× (real time)" : `${s}×`}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm text-slate-600">
              Departed
              <input type="time" value={departure} onChange={(e) => setDeparture(e.target.value || "09:30")} className="focus-ring ml-1 rounded border border-slate-300 px-1 py-0.5 text-sm" aria-label="Departure time" />
            </label>
            <span className="ml-auto text-sm font-semibold text-navy">
              {localTime} · t+{Math.floor(elapsed)} min
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={maxElapsed}
            step={1}
            value={Math.floor(elapsed)}
            onChange={(e) => {
              setPlaying(false);
              setElapsed(Number(e.target.value));
            }}
            className="mt-3 w-full"
            aria-label="Scrub simulation time"
          />
          <div className="flex justify-between text-[11px] text-slate-500">
            <span>{departure} depart Toronto</span>
            <span>
              {lead.label} {Math.round((lead.progressKm / ROUTE_TOTAL_KM) * 100)}% of route · km {lead.progressKm.toFixed(0)}
            </span>
            <span>~{leadArrivalLocal} arrive Montréal</span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-slate-600">
            <label className="inline-flex items-center gap-1">
              <input type="checkbox" checked={followLead} onChange={(e) => setFollowLead(e.target.checked)} /> follow lead car
            </label>
            <label className="inline-flex items-center gap-1">
              <input type="checkbox" checked={watcherOn} onChange={(e) => setWatcherOn(e.target.checked)} /> ambient watcher
            </label>
            <span>simulated clock; date {localDate}; positions simulated on real geometry</span>
          </div>
        </div>

        <TripMap
          cars={cars}
          stops={STOPS}
          upcomingExitIds={upcomingExits.map((e) => e.id)}
          recommendedStopIds={recIds}
          approvedStopId={approved}
          excludedStopIds={skipped}
          placingCarId={placingCarId}
          followCarId={followLead ? lead.id : null}
          selectedStopId={selectedStopId}
          onPlaceCar={onPlaceCar}
          onSelectStop={setSelectedStopId}
        />

        <RoadAhead
          lead={lead}
          cars={cars}
          stops={STOPS}
          exits={exitsAhead(lead.progressKm - 8, HORIZON.low.maxKm)}
          recommendedStopIds={recIds}
          approvedStopId={approved}
          excludedStopIds={skipped}
          advanceNoticeMinutes={sc.config.advanceNoticeMinutes}
          localTime={localTime}
          horizonKm={160}
          totalKm={ROUTE_TOTAL_KM}
          waypoints={waypoints.map((w) => ({ ...w, reading: waypointWeather[w.id] }))}
          nextOpportunityKm={nextOpp?.km ?? null}
          gapAfterKm={watchDecision.gapAfterKm}
          onSelectStop={setSelectedStopId}
        />

        {selectedStopId && (() => {
          const s = STOPS.find((x) => x.id === selectedStopId);
          if (!s) return null;
          return (
            <div className="rounded-lg border border-slate-200 bg-white p-3 text-sm">
              <div className="flex justify-between">
                <strong className="text-navy">{s.name}</strong>
                <button className="text-xs underline" onClick={() => setSelectedStopId(null)}>close</button>
              </div>
              <p className="text-xs text-slate-600">
                {s.exitLabel} · km {s.distanceAlongRouteKm} · {s.categories.join(", ")} · {s.open24h ? "24h" : `${s.opensLocal}–${s.closesLocal}`} · access +{s.accessMinutes} min ·
                vegetarian {s.vegetarianVerified === true ? "verified" : "unverified"} · fictional business, real exit location
              </p>
              {skipped.includes(s.id) && (
                <button className="mt-1 text-xs text-teal underline" onClick={() => setSkipped((k) => k.filter((x) => x !== s.id))}>
                  restore (un-skip)
                </button>
              )}
            </div>
          );
        })()}

        {/* ---- recommendations ---- */}
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-bold text-navy">Recommendations</h2>
            <button onClick={() => void runRecommendation("manual")} disabled={loading} className="focus-ring rounded-md border border-navy/20 px-3 py-1.5 text-sm font-semibold text-navy hover:bg-slate-50 disabled:opacity-50">
              {loading ? "Deciding…" : "Ask now"}
            </button>
          </div>
          {loading && <p className="mt-2 text-sm text-slate-500">Agent 2 is comparing reachable exits… (a live model can take ~20 s)</p>}
          {error && (
            <div className="mt-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
              <p className="font-semibold">Couldn’t get a decision {error.status ? `(HTTP ${error.status})` : ""} — this is an error, not “no stop needed”.</p>
              <p className="text-xs">{error.message}</p>
              {error.issues && (
                <ul className="mt-1 text-xs">
                  {error.issues.map((i, k) => (
                    <li key={k}>
                      <code>{i.path.join(".")}</code>: {i.message}
                    </li>
                  ))}
                </ul>
              )}
              <button onClick={() => void runRecommendation("manual")} className="mt-2 rounded border border-red-300 px-2 py-1 text-xs font-semibold">
                Retry
              </button>
            </div>
          )}
          {!result && !error && !loading && (
            <p className="mt-2 text-sm text-slate-500">
              {watcherOn ? "Watching the trip. Agent 2 is called only when a decision is needed." : "Watcher off — press “Ask now”."}
            </p>
          )}
          {result && resultStale && <p className="mt-2 text-xs text-amber">Showing the previous decision — the latest request failed.</p>}
          {result && result.action === "STAY_SILENT" && (
            <div className="mt-2 rounded-lg bg-slate-100 p-3 text-sm text-slate-700">
              {result.triggerReasons.length === 0
                ? "No stop needed right now — staying quiet."
                : result.recommendations.length === 0 && result.rejected.length > 0 && result.urgency && result.urgency.level !== "low"
                  ? `Unable to recommend: needs are active (${result.triggerReasons.join("; ")}) but no reachable stop passed the checks. See rejections in the inspector.`
                  : `Staying quiet for now (${result.urgency?.level ?? "low"} urgency): ${result.triggerReasons.join("; ")}`}
            </div>
          )}
          {result && result.action !== "STAY_SILENT" && (
            <div className={`mt-3 space-y-3 ${resultStale ? "opacity-60" : ""}`} aria-live="polite">
              {result.recommendations.map(card)}
            </div>
          )}
          {skipped.length > 0 && (
            <p className="mt-3 text-xs text-slate-500">
              Skipped: {skipped.join(", ")} ·{" "}
              <button className="underline" onClick={() => setSkipped([])}>
                restore all
              </button>
            </p>
          )}
        </div>
      </section>

      <aside className="min-w-0 space-y-4">
        {/* ---- watcher / urgency ---- */}
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold text-navy">Ambient watcher</h2>
            <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${URGENCY_STYLE[groupUrgency.level]}`}>group: {groupUrgency.level}</span>
          </div>
          <ul className="mt-2 space-y-0.5 text-xs text-slate-600">
            {groupUrgency.reasons.length ? groupUrgency.reasons.map((r) => <li key={r}>• {r}</li>) : <li>• no active need</li>}
          </ul>
          <p className="mt-2 text-xs text-slate-600">
            {nextOpp && nextOppStop
              ? `Next suitable stop: ${nextOppStop.exitLabel} in ~${Math.round(nextOpp.minutesAhead)} min${watchDecision.gapAfterKm != null && watchDecision.gapAfterKm >= 70 ? ` · then ${Math.round(watchDecision.gapAfterKm)} km with nothing suitable` : ""}`
              : groupUrgency.level === "none"
                ? "Nothing to look for."
                : "No suitable stop ahead with enough notice."}
          </p>
          <p className="mt-1 text-[11px] text-slate-500">Watcher: {watchDecision.reasons.join("; ")}</p>
          <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
            <label>
              Meal history
              <select value={mealHistory} onChange={(e) => setMealHistory(e.target.value as typeof mealHistory)} className="focus-ring mt-0.5 w-full rounded border border-slate-300 px-1 py-0.5">
                <option value="unknown">unknown</option>
                <option value="before_departure">ate before departure</option>
              </select>
            </label>
            <div>
              Last stop
              <p className="mt-0.5 text-slate-700">{lastStop ? `${lastStop.stopId}, ${Math.round(minutesSinceLastStop)} min ago` : `departure, ${Math.round(minutesSinceLastStop)} min ago`}</p>
            </div>
          </div>
        </div>

        {/* ---- cars ---- */}
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold text-navy">Cars</h2>
            <button onClick={addCar} disabled={simCars.length >= 3} className="focus-ring rounded-md border border-slate-300 px-2 py-1 text-xs font-semibold disabled:opacity-40">
              + Add car
            </button>
          </div>
          <ul className="mt-2 space-y-2 text-sm">
            {cars.map((c) => {
              const sim = simCars.find((s) => s.id === c.id)!;
              const i = intents[c.id] ?? emptyCarIntent(c.id);
              const u = urgencyByCar[c.id];
              return (
                <li key={c.id} className="rounded-lg border border-slate-100 bg-slate-50 p-2" style={{ borderLeft: `4px solid ${CAR_COLORS[c.id]}` }}>
                  <div className="flex flex-wrap items-center justify-between gap-1">
                    <span className="font-semibold">
                      {c.label} {c.role === "lead" && "★"} {c.ev && `⚡${c.batteryPercent}%`}
                    </span>
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${URGENCY_STYLE[u.level]}`}>{u.level}</span>
                  </div>
                  <p className="text-xs text-slate-600">
                    km {c.progressKm.toFixed(0)} / {ROUTE_TOTAL_KM.toFixed(0)} · {c.speedKph} km/h · heading {c.headingDeg}°
                    {c.positionUpdatedMinutesAgo > 3 && <span className="text-amber"> · GPS stale {c.positionUpdatedMinutesAgo} min</span>}
                  </p>
                  <p className="text-xs text-slate-600">
                    needs: {i.needs.map((n) => n.need).join(", ") || "—"} · hunger {i.hungerLevel}/3{i.restroomUrgent && " · restroom URGENT"}
                    {i.notHungry && " · not hungry"} · diet: {i.dietary.join(", ") || "—"}
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                    <button onClick={() => setPlacingCarId(placingCarId === c.id ? null : c.id)} className={`focus-ring rounded border px-1.5 py-0.5 ${placingCarId === c.id ? "border-navy bg-navy text-white" : "border-slate-300"}`}>
                      {placingCarId === c.id ? "click map…" : "Place on map"}
                    </button>
                    <label className="inline-flex items-center gap-1">
                      {sim.speedKph} km/h
                      <input
                        type="range"
                        min={60}
                        max={120}
                        step={2}
                        value={sim.speedKph}
                        onChange={(e) => updateCar(c.id, (s) => ({ ...placeCar(s, c.progressKm, elapsed), speedKph: Number(e.target.value) }))}
                        aria-label={`${c.label} speed`}
                        className="w-20"
                      />
                    </label>
                    <label className="inline-flex items-center gap-1">
                      <input type="checkbox" checked={c.kids} onChange={(e) => updateCar(c.id, (s) => ({ ...s, kids: e.target.checked }))} /> kids
                    </label>
                    <label className="inline-flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={sim.gpsFrozenAtElapsed != null}
                        onChange={(e) => updateCar(c.id, (s) => ({ ...s, gpsFrozenAtElapsed: e.target.checked ? elapsed : null }))}
                      />{" "}
                      freeze GPS
                    </label>
                    {c.role !== "lead" && (
                      <button onClick={() => removeCar(c.id)} className="text-red-600 underline">
                        remove
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
            <label>
              Weather source
              <select value={weatherMode} onChange={(e) => setWeatherMode(e.target.value as "live" | "simulated")} className="focus-ring mt-0.5 w-full rounded border border-slate-300 px-1 py-0.5">
                <option value="live">live (Open-Meteo)</option>
                <option value="simulated">simulated (offline)</option>
              </select>
            </label>
            <label>
              {weatherMode === "live" ? "Fallback weather" : "Simulated weather"}
              <select value={simWeather} onChange={(e) => setSimWeather(e.target.value as Weather)} className="focus-ring mt-0.5 w-full rounded border border-slate-300 px-1 py-0.5">
                {WEATHERS.map((w) => (
                  <option key={w}>{w}</option>
                ))}
              </select>
            </label>
            <label className="col-span-2">
              Traffic delay (sim): {traffic} min
              <input type="range" min={0} max={60} value={traffic} onChange={(e) => setTraffic(Number(e.target.value))} className="w-full" />
            </label>
          </div>
        </div>

        {/* ---- conversation (Agent 1) ---- */}
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <h2 className="text-lg font-bold text-navy">Conversation</h2>
          <p className="text-[11px] text-slate-500">Agent 1 interprets each message into per-car intent; corrections overwrite earlier requests.</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {CHIPS.map((c) => (
              <button
                key={c.text}
                onClick={() => {
                  setChatText(c.text);
                  setChatSource(c.source);
                }}
                className="focus-ring rounded-full border border-teal/40 bg-teal/10 px-2 py-0.5 text-[11px] font-semibold text-teal hover:bg-teal/20"
              >
                {c.source === "driver_voice" ? "🎙 " : "💬 "}
                {c.text}
              </button>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            <select value={chatCar} onChange={(e) => setChatCar(e.target.value)} className="focus-ring rounded border border-slate-300 px-1 py-1" aria-label="Speaking car">
              {cars.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
            <select value={chatSource} onChange={(e) => setChatSource(e.target.value as typeof chatSource)} className="focus-ring rounded border border-slate-300 px-1 py-1" aria-label="Message source">
              <option value="copassenger_text">💬 co-passenger text</option>
              <option value="driver_voice">🎙 driver voice transcript</option>
            </select>
            <button onClick={startVoice} disabled={listening || chatBusy} className="focus-ring rounded border border-slate-300 px-2 py-1 disabled:opacity-50" title="Speech recognition (Chrome, active tab only)">
              {listening ? "listening…" : "🎙 speak"}
            </button>
            <button
              onClick={() => {
                setVoiceOn((v) => !v);
                if (voiceOn) window.speechSynthesis?.cancel();
              }}
              aria-pressed={voiceOn}
              className={`focus-ring rounded border px-2 py-1 ${voiceOn ? "border-teal bg-teal/10 text-teal" : "border-slate-300"}`}
            >
              {voiceOn ? "🔊 read aloud" : "🔇 silent"}
            </button>
          </div>
          <div className="mt-2 flex gap-2">
            <input
              value={chatText}
              onChange={(e) => setChatText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void sendMessage(chatText)}
              placeholder='e.g. "kids need a washroom soon"'
              className="focus-ring min-w-0 flex-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              aria-label="Message"
            />
            <button onClick={() => void sendMessage(chatText)} disabled={chatBusy} className="focus-ring rounded-md bg-teal px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50">
              {chatBusy ? "…" : "Send"}
            </button>
          </div>
          <ul className="mt-2 max-h-40 space-y-1 overflow-auto text-xs">
            {messages.map((m, k) => (
              <li key={k} className="rounded bg-slate-50 px-2 py-1">
                <span className="font-mono text-slate-400">{m.time}</span> <strong style={{ color: CAR_COLORS[m.carId] }}>{m.carId.replace("car_", "").toUpperCase()}</strong>{" "}
                {m.source === "driver_voice" ? "🎙" : "💬"} “{m.text}”
                <div className="text-slate-500">→ {m.understood.join("; ") || "no change"} · {m.provider}</div>
              </li>
            ))}
          </ul>
        </div>

        {/* ---- inspector ---- */}
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex gap-2 text-sm">
            <button onClick={() => setInspectTab("agent2")} className={`rounded px-2 py-0.5 ${inspectTab === "agent2" ? "bg-navy text-white" : "border border-slate-300"}`}>
              Agent 2 decision
            </button>
            <button onClick={() => setInspectTab("agent1")} className={`rounded px-2 py-0.5 ${inspectTab === "agent1" ? "bg-navy text-white" : "border border-slate-300"}`}>
              Agent 1 intent
            </button>
          </div>
          {inspectTab === "agent2" && result && (
            <div className="mt-2 space-y-2 text-xs text-slate-600">
              <p>
                provider: <strong>{result.provider}</strong> · urgency: {result.urgency?.level ?? "?"} · decided {result.decidedAtLocal}
              </p>
              <details open>
                <summary className="cursor-pointer font-semibold text-navy">Exploration trace</summary>
                <ul className="mt-1 space-y-0.5">
                  {result.exploration.map((u) => (
                    <li key={u}>• {u}</li>
                  ))}
                </ul>
              </details>
              <details>
                <summary className="cursor-pointer font-semibold text-navy">Verified checks</summary>
                <ul className="mt-1 space-y-0.5">
                  {result.verifiedChecks.map((u) => (
                    <li key={u}>✓ {u}</li>
                  ))}
                </ul>
              </details>
              <details>
                <summary className="cursor-pointer font-semibold text-navy">Rejected / caveats ({result.rejected.length})</summary>
                <ul className="mt-1 space-y-0.5">
                  {result.rejected.map((r) => (
                    <li key={r.stopId}>
                      <strong>{r.stopId}</strong>: {r.reasons.join("; ")}
                    </li>
                  ))}
                </ul>
              </details>
              {result.weather && (
                <details>
                  <summary className="cursor-pointer font-semibold text-navy">Weather context ({result.weather.mode})</summary>
                  <ul className="mt-1 space-y-0.5">
                    {[...result.weather.cars, ...result.weather.stops].map((w) => (
                      <li key={`${w.id}${w.forHour}`}>
                        {w.id} @{w.forHour.slice(11, 16)}: {w.description}
                        {w.tempC != null ? ` ${w.tempC}°C` : ""} [{w.source}
                        {w.stale ? ", stale" : ""}]{w.note ? ` — ${w.note}` : ""}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
          {(() => {
            const ins = inspectTab === "agent2" ? agent2Inspect : agent1Inspect;
            if (!ins) return <p className="mt-2 text-xs text-slate-500">No request yet.</p>;
            return (
              <div className="mt-2 space-y-1">
                <p className="text-xs text-slate-500">HTTP {ins.status ?? "pending…"}</p>
                <details>
                  <summary className="cursor-pointer text-xs font-semibold text-navy">Request JSON</summary>
                  <pre className="mt-1 max-h-56 overflow-auto rounded bg-slate-900 p-2 text-[10px] text-slate-100">{JSON.stringify(ins.request, null, 2)}</pre>
                </details>
                <details>
                  <summary className="cursor-pointer text-xs font-semibold text-navy">Response JSON</summary>
                  <pre className="mt-1 max-h-56 overflow-auto rounded bg-slate-900 p-2 text-[10px] text-slate-100">{JSON.stringify(ins.response, null, 2)}</pre>
                </details>
              </div>
            );
          })()}
        </div>

        {/* ---- log ---- */}
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <h2 className="text-lg font-bold text-navy">Event log</h2>
          <ul className="mt-2 max-h-72 space-y-1 overflow-auto text-xs">
            {log.length === 0 && <li className="text-slate-500">Nothing yet.</li>}
            {log.map((l, k) => (
              <li key={k} className="rounded bg-slate-50 px-2 py-1">
                <span className="font-mono text-slate-400">{l.time}</span>{" "}
                <span
                  className={
                    l.kind === "agent2"
                      ? "font-semibold text-teal"
                      : l.kind === "agent1"
                        ? "text-indigo-700"
                        : l.kind === "watcher"
                          ? "text-sky-700"
                          : l.kind === "approval"
                            ? "font-semibold text-navy"
                            : l.kind === "error"
                              ? "font-semibold text-red-700"
                              : l.kind === "silent"
                                ? "text-slate-500"
                                : ""
                  }
                >
                  {l.text}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </div>
  );
}
