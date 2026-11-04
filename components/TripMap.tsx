"use client";

import { useEffect, useRef, useState } from "react";
import type * as Leaflet from "leaflet";
import "leaflet/dist/leaflet.css";
import { exitLabel, TORONTO_MONTREAL } from "@/lib/route/route";
import type { RouteModel } from "@/lib/route/model";
import type { StopCandidate } from "@/lib/domain/types";
import { CAR_COLORS, type SimCarState } from "@/lib/simulator/simulator";

export interface TripMapProps {
  /** Route to draw; defaults to the cached Toronto → Montréal demo route. */
  route?: RouteModel;
  /** Draw a dashed detour line from the route to these stops (selected / active). */
  detourStopIds?: string[];
  /** Small caption under the map (data provenance). */
  caption?: string;
  heightClass?: string;
  /** Real alternative routes (dashed); click to inspect/choose. */
  alternatives?: Array<{ id: string; coordinates: Array<[number, number]>; label: string }>;
  highlightedAltId?: string | null;
  onSelectAlternative?: (id: string) => void;
  cars: Array<Pick<SimCarState, "id" | "label" | "lat" | "lng" | "headingDeg" | "speedKph" | "positionUpdatedMinutesAgo">>;
  stops: StopCandidate[];
  upcomingExitIds: string[];
  recommendedStopIds: string[];
  approvedStopId: string | null;
  excludedStopIds: string[];
  placingCarId: string | null;
  followCarId: string | null;
  selectedStopId: string | null;
  onPlaceCar: (carId: string, lat: number, lng: number) => void;
  onSelectStop: (stopId: string | null) => void;
}

function carIcon(L: typeof Leaflet, car: TripMapProps["cars"][number], stale: boolean): Leaflet.DivIcon {
  const color = CAR_COLORS[car.id] ?? "#334155";
  const letter = car.label.replace(/^Car\s*/i, "");
  return L.divIcon({
    className: "",
    iconSize: [34, 34],
    iconAnchor: [17, 17],
    html: `<div style="position:relative;width:34px;height:34px">
      <svg width="34" height="34" viewBox="0 0 34 34" style="transform:rotate(${car.headingDeg}deg);transition:transform .3s">
        <circle cx="17" cy="17" r="13" fill="${color}" stroke="white" stroke-width="2.5" opacity="${stale ? 0.45 : 1}"/>
        <path d="M17 6 L23 21 L17 18 L11 21 Z" fill="white"/>
      </svg>
      <div style="position:absolute;left:30px;top:2px;white-space:nowrap;font:600 11px system-ui;color:#0f2a43;background:rgba(255,255,255,.92);border:1px solid ${color};border-radius:6px;padding:1px 5px">
        ${letter} · ${car.speedKph} km/h${stale ? ` · GPS ${car.positionUpdatedMinutesAgo}m old` : ""}
      </div>
    </div>`
  });
}

function stopStyle(stop: StopCandidate, rank: number | null, approved: boolean, excluded: boolean, selected: boolean) {
  if (approved) return { color: "#0d9488", fillColor: "#0d9488", radius: 10, weight: 3, fillOpacity: 0.9 };
  if (rank != null) return { color: "#0f2a43", fillColor: "#14b8a6", radius: 9, weight: 3, fillOpacity: 0.9 };
  if (excluded) return { color: "#94a3b8", fillColor: "#e2e8f0", radius: 5, weight: 1, fillOpacity: 0.8 };
  const food = stop.categories.includes("meal");
  return {
    color: selected ? "#0f2a43" : "#ffffff",
    fillColor: food ? "#f59e0b" : stop.categories.includes("ev_charge") ? "#8b5cf6" : "#64748b",
    radius: selected ? 8 : 6,
    weight: selected ? 3 : 1.5,
    fillOpacity: 0.95
  };
}

export default function TripMap(props: TripMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Leaflet.Map | null>(null);
  const LRef = useRef<typeof Leaflet | null>(null);
  const carMarkers = useRef(new Map<string, Leaflet.Marker>());
  const stopLayer = useRef<Leaflet.LayerGroup | null>(null);
  const exitLayer = useRef<Leaflet.LayerGroup | null>(null);
  const routeLayer = useRef<Leaflet.LayerGroup | null>(null);
  const fittedRouteId = useRef<string | null>(null);
  const altLayer = useRef<Leaflet.LayerGroup | null>(null);
  const route = props.route ?? TORONTO_MONTREAL;
  const propsRef = useRef(props);
  propsRef.current = props;
  const [ready, setReady] = useState(false);
  const [tilesFailed, setTilesFailed] = useState(false);

  // ---- create the map once ----
  useEffect(() => {
    let cancelled = false;
    void import("leaflet").then((L) => {
      if (cancelled || !containerRef.current || mapRef.current) return;
      LRef.current = L;
      const map = L.map(containerRef.current, { zoomControl: true, attributionControl: true }).setView([44.3, -77.2], 7);
      const tiles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 18,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      }).addTo(map);
      let tileErrors = 0;
      tiles.on("tileerror", () => {
        tileErrors += 1;
        if (tileErrors >= 4) setTilesFailed(true);
      });
      tiles.on("tileload", () => setTilesFailed(false));

      altLayer.current = L.layerGroup().addTo(map);
      routeLayer.current = L.layerGroup().addTo(map);
      exitLayer.current = L.layerGroup().addTo(map);
      stopLayer.current = L.layerGroup().addTo(map);

      map.on("click", (e: Leaflet.LeafletMouseEvent) => {
        const p = propsRef.current;
        if (p.placingCarId) p.onPlaceCar(p.placingCarId, e.latlng.lat, e.latlng.lng);
        else p.onSelectStop(null);
      });
      mapRef.current = map;
      setReady(true);
    });
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
      carMarkers.current.clear();
    };
  }, []);

  // ---- route line (redrawn when the route changes) ----
  useEffect(() => {
    const L = LRef.current;
    const map = mapRef.current;
    if (!ready || !L || !map || !routeLayer.current) return;
    routeLayer.current.clearLayers();
    const line = L.polyline(route.latLngs(), { color: "#0f2a43", weight: 5, opacity: 0.75 }).addTo(routeLayer.current);
    // Fit only for a new route; progressive updates (exits arriving later) keep the user's view.
    if (fittedRouteId.current !== route.id) {
      map.fitBounds(line.getBounds(), { padding: [20, 20] });
      fittedRouteId.current = route.id;
    }
  }, [ready, route]);

  // ---- alternative routes (under the main route) ----
  const altKey = `${(props.alternatives ?? []).map((a) => a.id).join(",")}|${props.highlightedAltId ?? ""}`;
  useEffect(() => {
    const L = LRef.current;
    if (!ready || !L || !altLayer.current) return;
    altLayer.current.clearLayers();
    for (const a of props.alternatives ?? []) {
      const hi = props.highlightedAltId === a.id;
      L.polyline(
        a.coordinates.map(([lng, lat]) => [lat, lng] as [number, number]),
        { color: hi ? "#7c3aed" : "#64748b", weight: hi ? 5 : 4, opacity: hi ? 0.9 : 0.55, dashArray: "8 7" }
      )
        .bindTooltip(a.label, { sticky: true })
        .on("click", (ev: Leaflet.LeafletMouseEvent) => {
          L.DomEvent.stopPropagation(ev);
          propsRef.current.onSelectAlternative?.(a.id);
        })
        .addTo(altLayer.current);
    }
  }, [ready, altKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- exits (exits along the route; upcoming reachable ones emphasised) ----
  const upcomingKey = props.upcomingExitIds.join(",");
  useEffect(() => {
    const L = LRef.current;
    if (!ready || !L || !exitLayer.current) return;
    exitLayer.current.clearLayers();
    const upcoming = new Set(props.upcomingExitIds);
    for (const e of route.exits()) {
      const up = upcoming.has(e.id);
      L.circleMarker([e.lat, e.lng], {
        radius: up ? 4.5 : 2.5,
        color: up ? "#0d9488" : "#94a3b8",
        weight: up ? 2 : 1,
        fillColor: "#ffffff",
        fillOpacity: 1
      })
        .bindTooltip(`${exitLabel(e)} · km ${e.km.toFixed(0)}${up ? " · upcoming" : ""}`, { direction: "top" })
        .addTo(exitLayer.current);
    }
  }, [ready, upcomingKey, route]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- stops ----
  const stopsKey = `${props.recommendedStopIds.join(",")}|${props.approvedStopId}|${props.excludedStopIds.join(",")}|${props.selectedStopId}|${(props.detourStopIds ?? []).join(",")}`;
  useEffect(() => {
    const L = LRef.current;
    if (!ready || !L || !stopLayer.current) return;
    stopLayer.current.clearLayers();
    for (const s of props.stops) {
      const idx = props.recommendedStopIds.indexOf(s.id);
      const rank = idx >= 0 ? idx + 1 : null;
      const marker = L.circleMarker([s.lat, s.lng], stopStyle(s, rank, props.approvedStopId === s.id, props.excludedStopIds.includes(s.id), props.selectedStopId === s.id))
        .bindTooltip(
          `${rank ? `#${rank} ` : ""}${s.name}<br/><span style="color:#64748b">${s.exitLabel ?? s.exitId} · km ${Math.round(s.distanceAlongRouteKm)} · ${s.categories.join(", ")} · ${s.isMock ? "FICTIONAL business (demo)" : `real place · ${s.source === "tomtom" ? "TomTom" : "OpenStreetMap"}${s.provenance === "cached" ? " (cached)" : ""}`}</span>`,
          { direction: "top" }
        )
        .on("click", (ev: Leaflet.LeafletMouseEvent) => {
          L.DomEvent.stopPropagation(ev);
          propsRef.current.onSelectStop(s.id);
        });
      marker.addTo(stopLayer.current);
      if (props.detourStopIds?.includes(s.id)) {
        const p = route.pointAtKm(s.distanceAlongRouteKm);
        L.polyline(
          [
            [p.lat, p.lng],
            [s.lat, s.lng]
          ],
          { color: "#0d9488", weight: 3, dashArray: "6 5", interactive: false }
        ).addTo(stopLayer.current);
      }
      if (rank) {
        L.marker([s.lat, s.lng], {
          interactive: false,
          icon: L.divIcon({
            className: "",
            iconSize: [18, 18],
            iconAnchor: [-6, 22],
            html: `<div style="background:#0f2a43;color:white;font:700 11px system-ui;border-radius:9px;padding:1px 6px">#${rank}</div>`
          })
        }).addTo(stopLayer.current);
      }
    }
  }, [ready, stopsKey, props.stops, route]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- cars: create / move / remove; draggable, snapping handled by parent ----
  useEffect(() => {
    const L = LRef.current;
    const map = mapRef.current;
    if (!ready || !L || !map) return;
    const seen = new Set<string>();
    for (const car of props.cars) {
      seen.add(car.id);
      const stale = car.positionUpdatedMinutesAgo > 3;
      let m = carMarkers.current.get(car.id);
      if (!m) {
        m = L.marker([car.lat, car.lng], { icon: carIcon(L, car, stale), draggable: true, zIndexOffset: 1000, keyboard: true, title: `${car.label} — drag to reposition` });
        m.on("dragend", () => {
          const ll = m!.getLatLng();
          propsRef.current.onPlaceCar(car.id, ll.lat, ll.lng);
        });
        m.addTo(map);
        carMarkers.current.set(car.id, m);
      } else if (!(m as any).dragging?._draggable?._moving) {
        m.setLatLng([car.lat, car.lng]);
        m.setIcon(carIcon(L, car, stale));
      }
    }
    for (const [id, m] of carMarkers.current) {
      if (!seen.has(id)) {
        m.remove();
        carMarkers.current.delete(id);
      }
    }
    if (props.followCarId) {
      const f = props.cars.find((c) => c.id === props.followCarId);
      if (f && !map.getBounds().pad(-0.25).contains([f.lat, f.lng])) map.panTo([f.lat, f.lng], { animate: true });
    }
  }, [ready, props.cars, props.followCarId]);

  useEffect(() => {
    if (containerRef.current) containerRef.current.style.cursor = props.placingCarId ? "crosshair" : "";
  }, [props.placingCarId]);

  return (
    <div className="relative">
      <div ref={containerRef} className={`${props.heightClass ?? "h-[420px] sm:h-[480px]"} w-full overflow-hidden rounded-lg border border-slate-200 bg-slate-100`} role="application" aria-label="Trip map" />
      {props.placingCarId && (
        <div className="pointer-events-none absolute left-1/2 top-3 z-[1000] -translate-x-1/2 rounded-full bg-navy px-3 py-1 text-xs font-semibold text-white shadow">
          Click on the route to place {props.cars.find((c) => c.id === props.placingCarId)?.label ?? props.placingCarId} — snaps to the nearest point on the highway
        </div>
      )}
      {tilesFailed && (
        <div className="absolute bottom-3 left-3 z-[1000] rounded bg-amber/90 px-2 py-1 text-xs font-semibold text-white">
          Map tiles unavailable (offline?) — route and exits drawn from cached geometry
        </div>
      )}
      <p className="mt-1 text-[11px] text-slate-500">
        {props.caption ??
          `Route: ${route.origin} → ${route.destination}, ${route.totalKm.toFixed(0)} km real road geometry and real exits (${route.attribution}, cached). Stop businesses are fictional. Drag a car or use “Place on map”.`}
      </p>
    </div>
  );
}
