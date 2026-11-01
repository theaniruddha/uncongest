"use client";

import scenario from "@/data/scenarios/highway-401.json";
import stopsFixture from "@/data/stops/highway-401.mock.json";
import extendedFixture from "@/data/stops/highway-401.extended.mock.json";
import type { CarState, StopCandidate } from "@/lib/domain/types";
import { routePointAtKm } from "@/lib/simulator/simulator";

const pts = scenario.routeAnchorPoints as Array<[number, number]>;
const stops = [
  ...(stopsFixture as { stops: StopCandidate[] }).stops,
  ...(extendedFixture as { stops: StopCandidate[] }).stops
];

function project(lat: number, lng: number): [number, number] {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const minX = Math.min(...xs, ...stops.map((s) => s.lng)) - 0.15;
  const maxX = Math.max(...xs, ...stops.map((s) => s.lng)) + 0.15;
  const minY = Math.min(...ys, ...stops.map((s) => s.lat)) - 0.15;
  const maxY = Math.max(...ys, ...stops.map((s) => s.lat)) + 0.15;
  const x = ((lng - minX) / (maxX - minX)) * 860 + 20;
  const y = 380 - ((lat - minY) / (maxY - minY)) * 340 - 20;
  return [x, y];
}

const CAR_COLORS: Record<string, string> = {
  car_a: "#0d9488",
  car_b: "#d97706",
  car_c: "#0f2a43"
};

export default function RouteMap({
  cars,
  highlightedStopIds
}: {
  cars: Array<CarState & { lat: number; lng: number }>;
  highlightedStopIds: string[];
}) {
  const routeD = pts
    .map((p, i) => {
      const [x, y] = project(p[1], p[0]);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg viewBox="0 0 900 400" className="h-auto w-full rounded-xl border border-slate-200 bg-[#eef2f0]" role="img" aria-label="Simulated Highway 401 corridor map">
      <text x="20" y="24" className="fill-amber" fontSize="12" fontWeight="700">
        SIMULATION — synthetic route geometry and fictional stops
      </text>
      <path d={routeD} fill="none" stroke="#94a3b8" strokeWidth="10" strokeLinecap="round" />
      <path d={routeD} fill="none" stroke="#0f2a43" strokeWidth="3" strokeDasharray="10 8" strokeLinecap="round" />
      {stops.map((s) => {
        const [x, y] = project(s.lat, s.lng);
        const highlighted = highlightedStopIds.includes(s.id);
        return (
          <g key={s.id}>
            <circle cx={x} cy={y} r={highlighted ? 9 : 6} fill={highlighted ? "#d97706" : "#ffffff"} stroke="#0f2a43" strokeWidth="2" />
            {highlighted && <text x={x + 12} y={y + 4} fontSize="11" fontWeight="600" className="fill-navy">{s.name}</text>}
          </g>
        );
      })}
      {cars.map((car) => {
        const p = routePointAtKm(car.progressKm);
        const [x, y] = project(p.lat, p.lng);
        return (
          <g key={car.id}>
            <circle cx={x} cy={y} r="9" fill={CAR_COLORS[car.id] ?? "#0d9488"} stroke="#ffffff" strokeWidth="2.5" />
            <text x={x + 12} y={y - 6} fontSize="11" fontWeight="700" className="fill-navy">
              {car.label} · {car.speedKph} km/h
            </text>
          </g>
        );
      })}
      <text x="20" y="390" fontSize="11" className="fill-slate-500">
        Toronto → Montréal · eastbound · mock corridor
      </text>
    </svg>
  );
}
