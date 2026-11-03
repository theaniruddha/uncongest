"use client";

import { useEffect, useRef, useState } from "react";
import type { PlaceRef, PlaceType } from "@/lib/trip/types";

interface Hit {
  label: string;
  lat: number;
  lng: number;
  kind: string;
}

/**
 * Location search backed by /api/geocode (Nominatim, server-side throttled + cached).
 * Debounced (700 ms, ≥ 3 chars) so typing never floods the geocoder.
 */
export default function PlaceSearch({
  label,
  value,
  onChange,
  presets,
  allowCurrentLocation = false,
  testId
}: {
  label: string;
  value: PlaceRef | null;
  onChange: (p: PlaceRef) => void;
  presets: PlaceRef[];
  allowCurrentLocation?: boolean;
  testId: string;
}) {
  const [q, setQ] = useState(value?.label ?? "");
  const [hits, setHits] = useState<Hit[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastQuery = useRef("");

  useEffect(() => {
    setQ(value?.label ?? "");
  }, [value?.label]);

  useEffect(() => {
    const query = q.trim();
    if (!open || query.length < 3 || query === value?.label || query === lastQuery.current) return;
    const t = setTimeout(async () => {
      lastQuery.current = query;
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/geocode?q=${encodeURIComponent(query)}`);
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
        setHits((data?.results ?? data ?? []) as Hit[]);
      } catch (e) {
        setHits([]);
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    }, 700);
    return () => clearTimeout(t);
  }, [q, open, value?.label]);

  const pick = (p: PlaceRef) => {
    onChange(p);
    setQ(p.label);
    setOpen(false);
    setHits([]);
  };

  const useCurrent = () => {
    if (!navigator.geolocation) {
      setError("Location isn't available in this browser");
      return;
    }
    setBusy(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude: lat, longitude: lng } = pos.coords;
        let placeLabel = `Current location (${lat.toFixed(3)}, ${lng.toFixed(3)})`;
        try {
          const res = await fetch(`/api/geocode?lat=${lat}&lng=${lng}`);
          const d = await res.json();
          if (res.ok && d?.label) placeLabel = `Current location · ${d.label}`;
        } catch {
          /* keep coordinate label */
        }
        setBusy(false);
        pick({ label: placeLabel, lat, lng, type: value?.type ?? "other", source: "current_location" });
      },
      (err) => {
        setBusy(false);
        setError(err.code === err.PERMISSION_DENIED ? "Location permission denied" : "Couldn't get your location");
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 }
    );
  };

  const presetMatches = presets.filter((p) => !q.trim() || p.label.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 4);

  return (
    <div className="relative" data-testid={testId}>
      <label className="block text-xs font-semibold text-slate-600">
        {label}
        <input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 200)}
          placeholder="Search a city, address or place"
          className="focus-ring mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm font-normal"
          aria-label={label}
          autoComplete="off"
        />
      </label>
      {allowCurrentLocation && (
        <button type="button" onClick={useCurrent} className="mt-1 text-[11px] font-semibold text-teal underline">
          📍 Use current location
        </button>
      )}
      {busy && <p className="mt-1 text-[11px] text-slate-500">Searching…</p>}
      {error && <p className="mt-1 text-[11px] text-red-700">{error}</p>}
      {open && (hits.length > 0 || presetMatches.length > 0) && (
        <ul className="absolute z-[1100] mt-1 max-h-64 w-full overflow-auto rounded-md border border-slate-200 bg-white text-sm shadow-lg" role="listbox">
          {presetMatches.map((p) => (
            <li key={`p-${p.label}`}>
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(p)} className="w-full px-2 py-1.5 text-left hover:bg-slate-50">
                {p.label} <span className="text-[10px] uppercase text-slate-400">preset</span>
              </button>
            </li>
          ))}
          {hits.map((h) => (
            <li key={`${h.lat},${h.lng}`}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick({ label: h.label, lat: h.lat, lng: h.lng, type: (value?.type ?? "other") as PlaceType, source: "search" })}
                className="w-full px-2 py-1.5 text-left hover:bg-slate-50"
              >
                {h.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
