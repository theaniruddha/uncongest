"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import RouteMap from "./RouteMap";
import { stateAt, loadScenario, ROUTE_TOTAL_KM } from "@/lib/simulator/simulator";
import { parseIntent, mergeCollectiveIntent } from "@/lib/domain/intent";
import type { CollectiveIntent, EngineResult, Need, Weather } from "@/lib/domain/types";

const WEATHERS: Weather[] = ["sunny", "cloudy", "rain", "snow", "cold"];
const CHIPS = ["Quick coffee", "All very hungry", "Kids need washrooms", "EV charge and lunch", "We need groceries"];

interface LogEntry {
  time: string;
  text: string;
  kind: "info" | "trigger" | "decision" | "approval" | "silent";
}

export default function Simulator() {
  const sc = loadScenario();
  const [elapsed, setElapsed] = useState(30);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(10);
  const [weather, setWeather] = useState<Weather>("sunny");
  const [traffic, setTraffic] = useState(10);
  const [hunger, setHunger] = useState<0 | 1 | 2 | 3>(1);
  const [chat, setChat] = useState("");
  const [needs, setNeeds] = useState<Need[]>([]);
  const [result, setResult] = useState<EngineResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approved, setApproved] = useState<string | null>(null);
  const [votes, setVotes] = useState<Record<string, "join" | "skip">>({});
  const [log, setLog] = useState<LogEntry[]>([
    { time: "13:30", text: "Simulation started: 3 cars, Toronto → Montréal, GTA excluded, vegetarian required.", kind: "info" }
  ]);
  const [voiceOn, setVoiceOn] = useState(false);
  const [lastRequest, setLastRequest] = useState<unknown>(null);
  const [showInspector, setShowInspector] = useState(false);
  const spokenRef = useRef<string | null>(null);

  const sim = useMemo(() => stateAt(elapsed), [elapsed]);
  const cars = sim.cars as Array<(typeof sim.cars)[number] & { lat: number; lng: number }>;

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      setElapsed((e) => {
        const next = e + speed / 6;
        return next >= 240 ? (setPlaying(false), e) : next;
      });
    }, 100);
    return () => clearInterval(id);
  }, [playing, speed]);

  const pushLog = useCallback((entry: LogEntry) => setLog((l) => [...l.slice(-60), entry]), []);

  const daylight = Math.max(0, 120 - Math.max(0, elapsed - 120));

  const baseIntent = useMemo<CollectiveIntent>(
    () => ({
      need: needs,
      hungerLevel: hunger,
      dietary: ["vegetarian"],
      maxDetourMinutes: sc.config.maximumDetourMinutesPerCar,
      kids: true
    }),
    [needs, hunger, sc.config.maximumDetourMinutesPerCar]
  );

  const runRecommendation = useCallback(
    async (intentOverride?: CollectiveIntent, note?: string) => {
      setLoading(true);
      setError(null);
      const intent = intentOverride ?? baseIntent;
      const body = {
        trip: {
          destination: sc.destination,
          direction: "eastbound" as const,
          highway: "401",
          elapsedMinutes: Math.round(sim.elapsedMinutes),
          localTime: sim.localTime
        },
        config: { ...sc.config },
        cars: cars.map(({ lat, lng, ...c }) => c),
        collectiveIntent: intent,
        environment: { weather, trafficDelayMinutes: traffic, daylightMinutes: daylight }
      };
      setLastRequest(body);
      try {
        const res = await fetch("/api/recommend-stops", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as EngineResult;
        setResult(data);
        if (note) pushLog({ time: sim.localTime, text: note, kind: "info" });
        if (data.action === "STAY_SILENT") {
          pushLog({ time: sim.localTime, text: `STAY_SILENT — ${data.triggerReasons.length ? data.triggerReasons.join("; ") : "no active trigger"}; no interruption needed.`, kind: "silent" });
        } else {
          pushLog({
            time: sim.localTime,
            text: `PROPOSE_STOP via ${data.provider}: ${data.recommendations.map((r) => `#${r.rank} ${r.name}`).join(", ")}`,
            kind: "decision"
          });
          if (voiceOn && data.recommendations[0] && spokenRef.current !== data.recommendations[0].stopId) {
            spokenRef.current = data.recommendations[0].stopId;
            try {
              const u = new SpeechSynthesisUtterance(
                `Uncongest suggests ${data.recommendations[0].name}.`
              );
              u.rate = 1;
              window.speechSynthesis.cancel();
              window.speechSynthesis.speak(u);
            } catch {
              /* speech unsupported */
            }
          }
        }
      } catch (err) {
        setError((err as Error).message);
        pushLog({ time: sim.localTime, text: `Request failed: ${(err as Error).message}`, kind: "info" });
      } finally {
        setLoading(false);
      }
    },
    [baseIntent, cars, sim, weather, traffic, daylight, voiceOn, pushLog, sc]
  );

  const sendChat = () => {
    const text = chat.trim();
    if (!text) return;
    const parsed = parseIntent(text);
    const merged = mergeCollectiveIntent(parsed, baseIntent);
    setNeeds(merged.need);
    if (parsed.hungerLevel > hunger) setHunger(parsed.hungerLevel);
    setChat("");
    pushLog({ time: sim.localTime, text: `Chat: "${text}" → needs [${parsed.needs.join(", ") || "none"}], hunger ${parsed.hungerLevel}`, kind: "trigger" });
    void runRecommendation(merged, "Chat intent applied.");
  };

  const approve = (stopId: string) => {
    setApproved(stopId);
    pushLog({ time: sim.localTime, text: `Lead approved stop ${stopId}; Maps handoff ready.`, kind: "approval" });
  };

  const vote = (carId: string, v: "join" | "skip") => {
    setVotes((prev) => ({ ...prev, [carId]: v }));
    pushLog({ time: sim.localTime, text: `${carId} voted ${v.toUpperCase()}`, kind: "approval" });
  };

  const card = (r: NonNullable<EngineResult>["recommendations"][number]) => (
    <div key={r.stopId} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-teal">{r.kind} · rank {r.rank}</p>
          <h3 className="text-lg font-bold text-navy">{r.name}</h3>
        </div>
        <span className="rounded bg-amber/15 px-2 py-1 text-xs font-semibold text-amber">SIMULATED</span>
      </div>
      <p className="mt-2 text-sm text-slate-700">{r.reason}</p>
      <ul className="mt-2 space-y-1 text-sm text-slate-600">
        {r.tradeoffs.map((t) => (
          <li key={t}>• {t}</li>
        ))}
      </ul>
      <div className="mt-2 text-xs text-slate-500">
        Detour by car: {Object.entries(r.detourMinutesByCar).map(([k, v]) => `${k} +${isFinite(v) ? v.toFixed(0) : "∞"}m`).join(" · ")}
        {" · group wait "}
        {r.maxGroupWaitMinutes.toFixed(0)}m
      </div>
      {r.risks.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs text-amber">
          {r.risks.map((risk) => (
            <li key={risk}>⚠ {risk}</li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          onClick={() => approve(r.stopId)}
          className="focus-ring rounded-md bg-teal px-3 py-2 text-sm font-semibold text-white hover:bg-teal/90"
        >
          {approved === r.stopId ? "Approved ✓" : "Lead approve"}
        </button>
        <a
          href={r.mapsUrl}
          target="_blank"
          rel="noreferrer"
          className="focus-ring rounded-md border border-navy/20 px-3 py-2 text-sm font-semibold text-navy hover:bg-slate-50"
        >
          Open in Google Maps
        </a>
        <button
          onClick={() => pushLog({ time: sim.localTime, text: `Skipped ${r.name}`, kind: "info" })}
          className="focus-ring rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"
        >
          Skip
        </button>
      </div>
      {approved === r.stopId && (
        <div className="mt-3 rounded-lg bg-teal/10 p-2 text-xs text-teal">
          Group votes:
          {cars.map((c) => (
            <span key={c.id} className="ml-2 inline-flex gap-1">
              {c.label}:
              <button className="underline" onClick={() => vote(c.id, "join")}>join</button>/
              <button className="underline" onClick={() => vote(c.id, "skip")}>skip</button>
              {votes[c.id] ? ` (${votes[c.id]})` : ""}
            </span>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div className="grid gap-4 p-4 lg:grid-cols-[1fr_360px]">
      <section className="space-y-4">
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => setPlaying((p) => !p)} className="focus-ring rounded-md bg-navy px-3 py-2 text-sm font-semibold text-white">
              {playing ? "Pause" : "Play"}
            </button>
            <button onClick={() => { setPlaying(false); setElapsed(30); }} className="focus-ring rounded-md border border-slate-300 px-3 py-2 text-sm">Reset</button>
            <button onClick={() => setElapsed((e) => Math.min(e + 5, 240))} className="focus-ring rounded-md border border-slate-300 px-3 py-2 text-sm">+5 min</button>
            <label className="ml-2 text-sm text-slate-600">
              Speed
              <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} className="focus-ring ml-2 rounded border border-slate-300 px-2 py-1 text-sm">
                {[1, 10, 30].map((s) => (
                  <option key={s} value={s}>{s}×</option>
                ))}
              </select>
            </label>
            <span className="ml-auto text-sm font-semibold text-navy">
              t+{Math.round(sim.elapsedMinutes)} min · {sim.localTime} local
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={240}
            value={elapsed}
            onChange={(e) => { setPlaying(false); setElapsed(Number(e.target.value)); }}
            className="mt-3 w-full"
            aria-label="Scrub simulation time"
          />
          <RouteMap cars={cars} highlightedStopIds={result?.recommendations.map((r) => r.stopId) ?? []} />
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <h2 className="text-lg font-bold text-navy">Chat with the group</h2>
          <div className="mt-2 flex flex-wrap gap-2">
            {CHIPS.map((c) => (
              <button
                key={c}
                onClick={() => { setChat(c); }}
                className="focus-ring rounded-full border border-teal/40 bg-teal/10 px-3 py-1 text-xs font-semibold text-teal hover:bg-teal/20"
              >
                {c}
              </button>
            ))}
          </div>
          <div className="mt-3 flex gap-2">
            <input
              value={chat}
              onChange={(e) => setChat(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendChat()}
              placeholder='e.g. "all very hungry, kids need washrooms"'
              className="focus-ring flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm"
              aria-label="Chat message"
            />
            <button onClick={sendChat} disabled={loading} className="focus-ring rounded-md bg-teal px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
              {loading ? "…" : "Send"}
            </button>
            <button
              onClick={() => { setVoiceOn((v) => !v); if (voiceOn) window.speechSynthesis?.cancel(); }}
              className={`focus-ring rounded-md border px-3 py-2 text-sm ${voiceOn ? "border-teal bg-teal/10 font-semibold text-teal" : "border-slate-300 text-slate-600"}`}
              aria-pressed={voiceOn}
            >
              {voiceOn ? "🔊 voice on" : "🔇 voice off"}
            </button>
          </div>
          <p className="mt-1 text-xs text-slate-500">Voice reads recommendations aloud only while this page is active and voice is enabled.</p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <h2 className="text-lg font-bold text-navy">Recommendations</h2>
          {error && <p className="mt-2 rounded bg-red-50 p-2 text-sm text-red-700">Error: {error}</p>}
          {!result && !loading && <p className="mt-2 text-sm text-slate-500">Monitoring — no interruption needed. Send a chat message or press “Ask now”.</p>}
          {loading && <p className="mt-2 text-sm text-slate-500">Evaluating candidates…</p>}
          {result && result.action === "STAY_SILENT" && (
            <p className="mt-2 rounded-lg bg-slate-100 p-3 text-sm text-slate-700">
              Monitoring — no interruption needed. {result.triggerReasons.length === 0 && "No active trigger."}
            </p>
          )}
          {result && result.action !== "STAY_SILENT" && (
            <div className="mt-3 space-y-3" aria-live="polite">{result.recommendations.map(card)}</div>
          )}
          <button onClick={() => void runRecommendation()} disabled={loading} className="focus-ring mt-3 rounded-md border border-navy/20 px-3 py-2 text-sm font-semibold text-navy hover:bg-slate-50 disabled:opacity-50">
            Ask now
          </button>
        </div>
      </section>

      <aside className="space-y-4">
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <h2 className="text-lg font-bold text-navy">Cars</h2>
          <ul className="mt-2 space-y-2 text-sm">
            {cars.map((c) => (
              <li key={c.id} className="flex justify-between rounded-lg bg-slate-50 px-3 py-2">
                <span className="font-semibold">{c.label} {c.role === "lead" && "★ lead"}{c.ev && " ⚡"}{c.kids && " 👨‍👩‍👧"}</span>
                <span className="text-slate-600">{c.progressKm.toFixed(0)} km · {c.speedKph} km/h</span>
              </li>
            ))}
          </ul>
          <div className="mt-3 space-y-2 text-sm">
            <label className="block">Weather
              <select value={weather} onChange={(e) => setWeather(e.target.value as Weather)} className="focus-ring mt-1 w-full rounded border border-slate-300 px-2 py-1">
                {WEATHERS.map((w) => <option key={w}>{w}</option>)}
              </select>
            </label>
            <label className="block">Traffic delay: {traffic} min
              <input type="range" min={0} max={60} value={traffic} onChange={(e) => setTraffic(Number(e.target.value))} className="w-full" />
            </label>
            <label className="block">Hunger: {hunger}/3
              <input type="range" min={0} max={3} value={hunger} onChange={(e) => setHunger(Number(e.target.value) as 0 | 1 | 2 | 3)} className="w-full" />
            </label>
            <p className="text-xs text-slate-500">Daylight remaining (sim): {daylight} min</p>
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <button onClick={() => setShowInspector((v) => !v)} className="focus-ring text-sm font-semibold text-navy underline">
            {showInspector ? "Hide" : "Show"} request/response inspector
          </button>
          {showInspector && (
            <pre className="mt-2 max-h-64 overflow-auto rounded bg-slate-900 p-2 text-[11px] text-slate-100">
              {JSON.stringify(lastRequest, null, 2)}
            </pre>
          )}
          {result && (
            <div className="mt-3">
              <h3 className="text-sm font-bold text-navy">Why / rejections</h3>
              <p className="mt-1 text-xs text-slate-500">Triggers: {result.triggerReasons.join("; ") || "none"} · provider: {result.provider}</p>
              <ul className="mt-2 space-y-1 text-xs text-slate-600">
                {result.rejected.map((r) => (
                  <li key={r.stopId}><strong>{r.stopId}</strong>: {r.reasons.join("; ")}</li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <h2 className="text-lg font-bold text-navy">Event log</h2>
          <ul className="mt-2 max-h-72 space-y-1 overflow-auto text-xs">
            {log.map((l, i) => (
              <li key={i} className="rounded bg-slate-50 px-2 py-1">
                <span className="font-mono text-slate-400">{l.time}</span>{" "}
                <span className={l.kind === "decision" ? "font-semibold text-teal" : l.kind === "approval" ? "font-semibold text-navy" : l.kind === "silent" ? "text-slate-500" : ""}>{l.text}</span>
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </div>
  );
}
