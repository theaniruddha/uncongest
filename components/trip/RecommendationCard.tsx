"use client";

import type { Recommendation, StopCandidate, WeatherSnapshot } from "@/lib/domain/types";

export interface CardImpact {
  addedMinutes: number;
  newArrivalLocal: string;
  baselineArrivalLocal: string;
  afterDark: boolean;
  sunsetLocal: string | null;
}

export default function RecommendationCard({
  rec,
  stop,
  minutesToExit,
  weather,
  dwell,
  onDwell,
  impact,
  cars,
  participants,
  onParticipants,
  onSelect,
  onSkip,
  disabled
}: {
  rec: Recommendation;
  stop?: StopCandidate;
  minutesToExit: number;
  weather?: WeatherSnapshot;
  dwell: number;
  onDwell: (m: number) => void;
  impact: CardImpact | null;
  cars: Array<{ id: string; label: string }>;
  participants: string[];
  onParticipants: (ids: string[]) => void;
  onSelect: () => void;
  onSkip: () => void;
  disabled: boolean;
}) {
  const real = stop ? !stop.isMock : !rec.mock;
  const detour = Math.max(...Object.values(rec.detourMinutesByCar).filter(Number.isFinite), 0);
  return (
    <article className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm" data-testid="rec-card">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-teal">
            #{rec.rank} · {rec.kind.replace("_", " ")}
          </p>
          <h3 className="truncate text-base font-bold text-navy">{rec.name}</h3>
          <p className="text-xs text-slate-500">
            {stop?.exitLabel ?? "near route"} · exit in ~{Math.max(0, Math.round(minutesToExit))} min{stop?.brand && stop.brand !== rec.name ? ` · ${stop.brand}` : ""}
          </p>
        </div>
        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${real ? "bg-teal/10 text-teal" : "bg-amber/15 text-amber"}`}>
          {real ? `REAL · ${stop?.source === "tomtom" ? "TomTom" : "OSM"}${stop?.provenance === "cached" ? " cached" : ""}` : "FICTIONAL DEMO"}
        </span>
      </div>
      <p className="mt-1.5 text-sm text-slate-700">{rec.reason}</p>
      {rec.tradeoffs.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-xs text-slate-600">
          {rec.tradeoffs.slice(0, 3).map((t) => (
            <li key={t}>• {t}</li>
          ))}
        </ul>
      )}
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <dt className="text-slate-500">Detour</dt>
        <dd className="font-semibold text-navy">+{Math.round(detour)} min driving</dd>
        <dt className="text-slate-500">Stop length</dt>
        <dd>
          <label className="inline-flex items-center gap-1">
            <input
              type="number"
              min={2}
              max={180}
              value={dwell}
              onChange={(e) => onDwell(Math.max(2, Math.min(180, Number(e.target.value) || 0)))}
              className="w-14 rounded border border-slate-300 px-1 py-0.5"
              aria-label={`Minutes at ${rec.name}`}
            />
            min
          </label>
        </dd>
        <dt className="text-slate-500">Arrival</dt>
        <dd className="font-semibold text-navy" data-testid="eta-impact">
          {impact ? `${impact.baselineArrivalLocal} → ${impact.newArrivalLocal} (+${Math.round(impact.addedMinutes)} min)` : "—"}
        </dd>
        {impact && (
          <>
            <dt className="text-slate-500">At destination</dt>
            <dd className={impact.afterDark ? "text-amber" : "text-slate-700"}>{impact.afterDark ? `after dark (sunset ${impact.sunsetLocal ?? "?"})` : `daylight (sunset ${impact.sunsetLocal ?? "?"})`}</dd>
          </>
        )}
        <dt className="text-slate-500">Weather there</dt>
        <dd className={weather && weather.source !== "open-meteo" ? "text-amber" : "text-slate-700"}>
          {weather
            ? `${weather.tempC != null ? `${Math.round(weather.tempC)}°C ` : ""}${weather.description} @${weather.forHour.slice(11, 16)} (${weather.forHour.slice(5, 10)}) · ${weather.source === "open-meteo" ? "Open-Meteo forecast" : weather.note ?? "simulated"}`
            : "—"}
        </dd>
      </dl>
      {rec.risks.length > 0 && (
        <details className="mt-1 text-xs text-amber">
          <summary className="cursor-pointer">⚠ {rec.risks.length} caveat(s)</summary>
          <ul className="mt-1 space-y-0.5">
            {rec.risks.map((r) => (
              <li key={r}>• {r}</li>
            ))}
          </ul>
        </details>
      )}
      {cars.length > 1 && (
        <fieldset className="mt-2 text-xs">
          <legend className="text-slate-500">Who stops</legend>
          <div className="mt-0.5 flex flex-wrap gap-2">
            {cars.map((c) => (
              <label key={c.id} className="inline-flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={participants.includes(c.id)}
                  onChange={(e) => onParticipants(e.target.checked ? [...participants, c.id] : participants.filter((x) => x !== c.id))}
                />
                {c.label}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" onClick={onSelect} disabled={disabled || participants.length === 0} className="focus-ring rounded-md bg-teal px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50">
          Select stop
        </button>
        <a href={rec.mapsUrl} target="_blank" rel="noreferrer" className="focus-ring rounded-md border border-navy/20 px-3 py-1.5 text-sm font-semibold text-navy">
          Maps
        </a>
        <button type="button" onClick={onSkip} className="focus-ring rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-600">
          Skip
        </button>
      </div>
    </article>
  );
}
