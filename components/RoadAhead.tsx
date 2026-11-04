"use client";

import type { StopCandidate, WeatherSnapshot } from "@/lib/domain/types";
import type { RouteExit } from "@/lib/route/route";
import { addMinutesToHHMM, CAR_COLORS, type SimCarState } from "@/lib/simulator/simulator";

export interface RoadAheadWaypoint {
  id: string;
  km: number;
  etaMinutes: number;
  reading?: WeatherSnapshot;
}

export interface RoadAheadProps {
  lead: Pick<SimCarState, "id" | "label" | "progressKm" | "speedKph">;
  cars: Array<Pick<SimCarState, "id" | "label" | "progressKm" | "positionUpdatedMinutesAgo">>;
  stops: StopCandidate[];
  exits: RouteExit[];
  recommendedStopIds: string[];
  approvedStopId: string | null;
  excludedStopIds: string[];
  advanceNoticeMinutes: number;
  localTime: string;
  horizonKm: number;
  totalKm: number;
  waypoints: RoadAheadWaypoint[];
  nextOpportunityKm: number | null;
  gapAfterKm: number | null;
  onSelectStop: (id: string) => void;
}

const W = 1000;
const PAD = 28;

function weatherGlyph(r?: WeatherSnapshot): string {
  if (!r) return "…";
  switch (r.condition) {
    case "sunny":
      return "☀";
    case "cloudy":
      return "☁";
    case "rain":
      return "🌧";
    case "snow":
      return "❄";
    case "cold":
      return "🥶";
  }
}

export default function RoadAhead(p: RoadAheadProps) {
  const start = Math.max(0, p.lead.progressKm - 8);
  const end = Math.min(p.totalKm, start + p.horizonKm);
  const span = Math.max(end - start, 1);
  const x = (km: number) => PAD + ((km - start) / span) * (W - 2 * PAD);
  const inView = (km: number) => km >= start && km <= end;
  const speed = Math.max(p.lead.speedKph, 1);
  const etaAt = (km: number) => addMinutesToHHMM(p.localTime, ((km - p.lead.progressKm) / speed) * 60);
  const noticeKm = (speed * p.advanceNoticeMinutes) / 60;

  const ticks: number[] = [];
  for (let k = Math.ceil(start / 25) * 25; k <= end; k += 25) ticks.push(k);

  let lastLabelX = -Infinity;
  const exitLabels = p.exits
    .filter((e) => inView(e.km) && e.km > p.lead.progressKm)
    .map((e) => {
      const ex = x(e.km);
      const show = ex - lastLabelX > 34;
      if (show) lastLabelX = ex;
      return { e, ex, show };
    });

  const gapEnd = p.nextOpportunityKm != null && p.gapAfterKm != null ? p.nextOpportunityKm + p.gapAfterKm : null;

  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <div className="flex items-baseline justify-between px-3 pt-2">
        <h3 className="text-sm font-bold text-navy">Road ahead</h3>
        <span className="text-[11px] text-slate-500">
          next {Math.round(end - p.lead.progressKm)} km from {p.lead.label} · ETAs at {p.lead.speedKph} km/h
        </span>
      </div>
      <svg viewBox={`0 0 ${W} 170`} className="min-w-[640px]" role="img" aria-label="Linear view of the road ahead with exits, stops, cars and weather">
        {/* notice zone: exits here can't be signalled safely */}
        <rect x={x(p.lead.progressKm)} y={54} width={Math.max(x(p.lead.progressKm + noticeKm) - x(p.lead.progressKm), 0)} height={32} fill="#fee2e2" />
        <text x={x(p.lead.progressKm) + 3} y={51} fontSize={10} fill="#b91c1c">
          &lt; {p.advanceNoticeMinutes} min notice
        </text>

        {/* limited-facilities gap */}
        {gapEnd != null && p.gapAfterKm! >= 70 && inView(p.nextOpportunityKm!) && (
          <g>
            <line x1={x(p.nextOpportunityKm!)} x2={x(Math.min(gapEnd, end))} y1={90} y2={90} stroke="#d97706" strokeWidth={3} strokeDasharray="6 4" />
            <text x={x(p.nextOpportunityKm!) + 4} y={102} fontSize={10} fill="#b45309">
              limited facilities: next suitable stop {Math.round(p.gapAfterKm!)} km later
            </text>
          </g>
        )}

        {/* road */}
        <line x1={PAD} x2={W - PAD} y1={70} y2={70} stroke="#0f2a43" strokeWidth={6} strokeLinecap="round" opacity={0.8} />
        {ticks.map((k) => (
          <g key={k}>
            <line x1={x(k)} x2={x(k)} y1={74} y2={80} stroke="#64748b" />
            <text x={x(k)} y={118} fontSize={10} textAnchor="middle" fill="#64748b">
              km {k}
              {k > p.lead.progressKm ? ` · ${etaAt(k)}` : ""}
            </text>
          </g>
        ))}

        {/* exits */}
        {exitLabels.map(({ e, ex, show }) => (
          <g key={e.id}>
            <line x1={ex} x2={ex} y1={62} y2={78} stroke="#0d9488" strokeWidth={2} />
            {show && (
              <text x={ex} y={92} fontSize={9} textAnchor="middle" fill="#0f766e">
                {e.ref ?? "•"}
              </text>
            )}
          </g>
        ))}

        {/* stops */}
        {p.stops
          .filter((s) => inView(s.distanceAlongRouteKm))
          .map((s) => {
            const rankIdx = p.recommendedStopIds.indexOf(s.id);
            const approved = p.approvedStopId === s.id;
            const excluded = p.excludedStopIds.includes(s.id);
            const passed = s.distanceAlongRouteKm <= p.lead.progressKm;
            const fill = approved ? "#0d9488" : rankIdx >= 0 ? "#14b8a6" : excluded || passed ? "#cbd5e1" : s.categories.includes("meal") ? "#f59e0b" : "#64748b";
            return (
              <g key={s.id} onClick={() => p.onSelectStop(s.id)} style={{ cursor: "pointer" }}>
                <title>{`${s.name} — ${s.exitLabel ?? s.exitId}, km ${Math.round(s.distanceAlongRouteKm)}, ${s.categories.join(", ")} (${s.isMock ? "fictional" : "real place, OSM"})`}</title>
                <line x1={x(s.distanceAlongRouteKm)} x2={x(s.distanceAlongRouteKm)} y1={38} y2={64} stroke={fill} strokeWidth={1.5} />
                <circle cx={x(s.distanceAlongRouteKm)} cy={32} r={rankIdx >= 0 || approved ? 9 : 6} fill={fill} stroke="white" strokeWidth={1.5} />
                {(rankIdx >= 0 || approved) && (
                  <text x={x(s.distanceAlongRouteKm)} y={35.5} fontSize={10} fontWeight={700} textAnchor="middle" fill="white">
                    {approved ? "✓" : rankIdx + 1}
                  </text>
                )}
              </g>
            );
          })}

        {/* cars */}
        {p.cars
          .filter((c) => inView(c.progressKm))
          .map((c, i) => (
            <g key={c.id} transform={`translate(${x(c.progressKm)}, ${66 - i * 0})`}>
              <path d="M0 -10 L8 6 L0 2 L-8 6 Z" transform="rotate(90)" fill={CAR_COLORS[c.id] ?? "#334155"} stroke="white" strokeWidth={1.5} opacity={c.positionUpdatedMinutesAgo > 3 ? 0.45 : 1} />
              <text x={0} y={-12 - i * 10} fontSize={10} fontWeight={700} textAnchor="middle" fill={CAR_COLORS[c.id] ?? "#334155"}>
                {c.label.replace(/^Car\s*/i, "")}
              </text>
            </g>
          ))}

        {/* weather at ETA */}
        {p.waypoints
          .filter((w) => inView(w.km))
          .map((w) => (
            <g key={w.id}>
              <text x={x(w.km)} y={142} fontSize={14} textAnchor="middle">
                {weatherGlyph(w.reading)}
              </text>
              <text x={x(w.km)} y={160} fontSize={9.5} textAnchor="middle" fill={w.reading?.source === "open-meteo" ? "#0f2a43" : "#b45309"}>
                {w.reading
                  ? `${w.reading.tempC != null ? `${Math.round(w.reading.tempC)}°C ` : ""}${w.reading.description}${w.reading.precipProbability != null ? ` ${w.reading.precipProbability}%` : ""} @${w.reading.forHour.slice(11, 16)}${w.reading.source !== "open-meteo" ? " (sim)" : w.reading.stale ? " (stale)" : ""}`
                  : "loading…"}
              </text>
            </g>
          ))}
      </svg>
    </div>
  );
}
