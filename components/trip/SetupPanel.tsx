"use client";

import { useState } from "react";
import PlaceSearch from "./PlaceSearch";
import type { CarSetup, PlaceRef, PlaceType, TripSetup } from "@/lib/trip/types";
import type { Dietary, Need } from "@/lib/domain/types";

export interface PresetOption {
  id: string;
  title: string;
  blurb: string;
}

export interface ScenarioSuggestionView {
  suggestions: {
    originQuery?: string;
    destinationQuery?: string;
    departureTime?: string;
    departureMode?: "depart_at" | "arrive_by";
    mood?: TripSetup["mood"];
    mealPreference?: TripSetup["mealPreference"];
    customMeal?: string;
    mealHistory?: TripSetup["mealHistory"];
    maxDetourMinutes?: number;
    cars?: Array<{ id: CarSetup["id"]; adults?: number; kids?: number; dietary?: Dietary[]; initialNeeds?: Need[] }>;
  };
  understood: string[];
  warnings: string[];
  provider: string;
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  multi
}: {
  label: string;
  value: T | T[];
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
  multi?: boolean;
}) {
  const active = (v: T) => (Array.isArray(value) ? value.includes(v) : value === v);
  return (
    <fieldset className="mt-3">
      <legend className="text-xs font-semibold text-slate-600">{label}</legend>
      <div className="mt-1 flex flex-wrap gap-1" role={multi ? "group" : "radiogroup"} aria-label={label}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role={multi ? "checkbox" : "radio"}
            aria-checked={active(o.value)}
            onClick={() => onChange(o.value)}
            className={`focus-ring rounded-full border px-2.5 py-1 text-xs ${active(o.value) ? "border-navy bg-navy text-white" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"}`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

const DIETS: Dietary[] = ["vegetarian", "vegan", "halal", "gluten_free"];
const TYPES: Array<{ value: PlaceType; label: string }> = [
  { value: "home", label: "Home" },
  { value: "hotel", label: "Hotel" },
  { value: "other", label: "Other" }
];

export default function SetupPanel({
  setup,
  onChange,
  presets,
  onApplyPreset,
  placePresets,
  onPlan,
  planning,
  planError,
  canStart
}: {
  setup: TripSetup;
  onChange: (s: TripSetup) => void;
  presets: PresetOption[];
  onApplyPreset: (id: string) => void;
  placePresets: PlaceRef[];
  onPlan: () => void;
  planning: boolean;
  planError: { message: string; suggestion?: string } | null;
  canStart: boolean;
}) {
  const [scenarioBusy, setScenarioBusy] = useState(false);
  const [suggestion, setSuggestion] = useState<ScenarioSuggestionView | null>(null);
  const [scenarioError, setScenarioError] = useState<string | null>(null);
  const set = (patch: Partial<TripSetup>) => onChange({ ...setup, ...patch });
  const setCar = (id: string, patch: Partial<CarSetup>) => set({ cars: setup.cars.map((c) => (c.id === id ? { ...c, ...patch } : c)) });

  const toggleMood = (m: TripSetup["mood"][number]) => {
    // Moods combine (e.g. "hungry later, otherwise relaxed"); never leave it empty.
    const next = setup.mood.includes(m) ? setup.mood.filter((x) => x !== m) : [...setup.mood, m];
    set({ mood: next.length ? next : ["relaxed"] });
  };

  const addCar = () => {
    const id = (["car_b", "car_c"] as const).find((x) => !setup.cars.some((c) => c.id === x));
    if (!id) return;
    set({
      cars: [
        ...setup.cars,
        { id, label: id === "car_b" ? "Car B" : "Car C", adults: 2, kids: 0, dietary: [], speedKph: 100, startOffsetMinutes: id === "car_b" ? 5 : 10, initialNeeds: [] }
      ]
    });
  };

  const interpret = async () => {
    if (!setup.scenarioText?.trim()) return;
    setScenarioBusy(true);
    setScenarioError(null);
    try {
      const now = new Date();
      const res = await fetch("/api/scenario", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: setup.scenarioText,
          current: setup,
          todayLocalDate: setup.departure.date,
          localTime: `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`
        })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      setSuggestion(data as ScenarioSuggestionView);
    } catch (e) {
      setScenarioError((e as Error).message);
    } finally {
      setScenarioBusy(false);
    }
  };

  const applySuggestion = async () => {
    if (!suggestion) return;
    const s = suggestion.suggestions;
    const next: TripSetup = { ...setup };
    const geocodeFirst = async (q?: string): Promise<PlaceRef | null> => {
      if (!q) return null;
      const preset = placePresets.find((p) => p.label.toLowerCase().includes(q.toLowerCase()));
      if (preset) return preset;
      try {
        const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
        const d = await res.json();
        const hit = (d?.results ?? d ?? [])[0];
        return hit ? { label: hit.label, lat: hit.lat, lng: hit.lng, type: "other", source: "search" } : null;
      } catch {
        return null;
      }
    };
    const [o, d] = [await geocodeFirst(s.originQuery), await geocodeFirst(s.destinationQuery)];
    if (o) next.origin = { ...o, type: setup.origin.type };
    if (d) next.destination = { ...d, type: setup.destination.type };
    if (s.departureTime || s.departureMode) next.departure = { ...setup.departure, time: s.departureTime ?? setup.departure.time, mode: s.departureMode ?? setup.departure.mode };
    if (s.mood?.length) next.mood = s.mood;
    if (s.mealPreference) next.mealPreference = s.mealPreference;
    if (s.customMeal) next.customMeal = s.customMeal;
    if (s.mealHistory) next.mealHistory = s.mealHistory;
    if (s.maxDetourMinutes != null) next.maxDetourMinutes = s.maxDetourMinutes;
    if (s.cars?.length) {
      next.cars = setup.cars.map((c) => {
        const u = s.cars!.find((x) => x.id === c.id);
        return u ? { ...c, ...Object.fromEntries(Object.entries(u).filter(([, v]) => v !== undefined)) } : c;
      });
    }
    onChange(next);
    setSuggestion(null);
  };

  return (
    <div className="space-y-1 text-sm">
      <h2 className="text-base font-bold text-navy">Trip setup</h2>
      <fieldset>
        <legend className="text-xs font-semibold text-slate-600">Scenario presets</legend>
        <div className="mt-1 grid grid-cols-2 gap-1">
          {presets.map((p) => (
            <button key={p.id} type="button" title={p.blurb} onClick={() => onApplyPreset(p.id)} className="focus-ring rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-left text-[11px] leading-tight hover:border-teal hover:bg-teal/5">
              {p.title}
            </button>
          ))}
        </div>
      </fieldset>

      <div className="mt-3 space-y-2">
        <PlaceSearch testId="origin" label="Origin" value={setup.origin} onChange={(p) => set({ origin: p })} presets={placePresets} allowCurrentLocation />
        <Segmented label="Origin type" value={setup.origin.type} options={TYPES} onChange={(t) => set({ origin: { ...setup.origin, type: t } })} />
        <PlaceSearch testId="destination" label="Destination" value={setup.destination} onChange={(p) => set({ destination: p })} presets={placePresets} />
        <Segmented label="Destination type" value={setup.destination.type} options={TYPES} onChange={(t) => set({ destination: { ...setup.destination, type: t } })} />
      </div>

      <Segmented
        label="Timing"
        value={setup.departure.mode}
        options={[
          { value: "depart_at", label: "Depart at" },
          { value: "arrive_by", label: "Arrive by" }
        ]}
        onChange={(m) => set({ departure: { ...setup.departure, mode: m } })}
      />
      <div className="mt-1 flex gap-2">
        <input type="date" aria-label="Trip date" value={setup.departure.date} onChange={(e) => e.target.value && set({ departure: { ...setup.departure, date: e.target.value } })} className="focus-ring rounded border border-slate-300 px-1.5 py-1 text-sm" />
        <input type="time" aria-label={setup.departure.mode === "arrive_by" ? "Arrive by time" : "Departure time"} value={setup.departure.time} onChange={(e) => e.target.value && set({ departure: { ...setup.departure, time: e.target.value } })} className="focus-ring rounded border border-slate-300 px-1.5 py-1 text-sm" />
      </div>

      <Segmented
        label="Travel mood"
        multi
        value={setup.mood}
        options={[
          { value: "relaxed", label: "Relaxed" },
          { value: "tired", label: "Tired" },
          { value: "hungry", label: "Hungry" },
          { value: "hurry", label: "In a hurry" }
        ]}
        onChange={toggleMood}
      />
      <Segmented
        label="Meal preference"
        value={setup.mealPreference}
        options={[
          { value: "auto", label: "Let Uncongest decide" },
          { value: "quick_bite", label: "Quick bite" },
          { value: "proper_meal", label: "Proper meal" },
          { value: "coffee", label: "Coffee" },
          { value: "custom", label: "Custom" }
        ]}
        onChange={(v) => set({ mealPreference: v })}
      />
      {setup.mealPreference === "custom" && (
        <input value={setup.customMeal ?? ""} onChange={(e) => set({ customMeal: e.target.value })} placeholder="e.g. pho or a salad bar" aria-label="Custom meal preference" className="focus-ring mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm" />
      )}
      <Segmented
        label="Meal history"
        value={setup.mealHistory.kind}
        options={[
          { value: "unknown", label: "Unknown" },
          { value: "already_ate", label: "Already ate" },
          { value: "last_meal_at", label: "Last meal at…" }
        ]}
        onChange={(k) => set({ mealHistory: { kind: k, time: k === "last_meal_at" ? setup.mealHistory.time ?? "07:00" : undefined } })}
      />
      {setup.mealHistory.kind === "last_meal_at" && (
        <input type="time" aria-label="Last meal time" value={setup.mealHistory.time ?? "07:00"} onChange={(e) => set({ mealHistory: { kind: "last_meal_at", time: e.target.value } })} className="focus-ring mt-1 rounded border border-slate-300 px-1.5 py-1 text-sm" />
      )}
      <label className="mt-3 block text-xs font-semibold text-slate-600">
        Max detour per stop: {setup.maxDetourMinutes} min
        <input type="range" min={4} max={30} value={setup.maxDetourMinutes} onChange={(e) => set({ maxDetourMinutes: Number(e.target.value) })} className="w-full" />
      </label>

      <div className="mt-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-slate-600">Cars & passengers</span>
          <button type="button" onClick={addCar} disabled={setup.cars.length >= 3} className="focus-ring rounded border border-slate-300 px-2 py-0.5 text-[11px] font-semibold disabled:opacity-40">
            + Add car
          </button>
        </div>
        <ul className="mt-1 space-y-2">
          {setup.cars.map((c) => (
            <li key={c.id} className="rounded-md border border-slate-200 bg-slate-50 p-2 text-xs">
              <div className="flex items-center justify-between">
                <strong>{c.label}</strong>
                {c.id !== "car_a" && (
                  <button type="button" className="text-red-600 underline" onClick={() => set({ cars: setup.cars.filter((x) => x.id !== c.id) })}>
                    remove
                  </button>
                )}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <label>
                  adults <input type="number" min={1} max={8} value={c.adults} onChange={(e) => setCar(c.id, { adults: Math.max(1, Number(e.target.value)) })} className="w-12 rounded border border-slate-300 px-1" aria-label={`${c.label} adults`} />
                </label>
                <label>
                  kids <input type="number" min={0} max={8} value={c.kids} onChange={(e) => setCar(c.id, { kids: Math.max(0, Number(e.target.value)) })} className="w-12 rounded border border-slate-300 px-1" aria-label={`${c.label} kids`} />
                </label>
                {c.id !== "car_a" && (
                  <label>
                    starts{" "}
                    <input type="number" min={0} max={120} value={c.startOffsetMinutes} onChange={(e) => setCar(c.id, { startOffsetMinutes: Math.max(0, Number(e.target.value)) })} className="w-12 rounded border border-slate-300 px-1" aria-label={`${c.label} start offset`} />{" "}
                    min later
                  </label>
                )}
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                {DIETS.map((d) => (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={c.dietary.includes(d)}
                    onClick={() => setCar(c.id, { dietary: c.dietary.includes(d) ? c.dietary.filter((x) => x !== d) : [...c.dietary, d] })}
                    className={`rounded-full border px-2 py-0.5 ${c.dietary.includes(d) ? "border-teal bg-teal/10 font-semibold text-teal" : "border-slate-300 text-slate-600"}`}
                  >
                    {d.replace("_", "-")}
                  </button>
                ))}
              </div>
            </li>
          ))}
        </ul>
        <p className="mt-1 text-[11px] text-slate-500">Vegetarian/vegan = veg-friendly (chains & plazas OK). Halal/gluten-free are strict.</p>
      </div>

      <div className="mt-3">
        <label className="text-xs font-semibold text-slate-600">
          Describe your trip (optional)
          <textarea
            value={setup.scenarioText ?? ""}
            onChange={(e) => set({ scenarioText: e.target.value })}
            rows={3}
            placeholder="We're leaving Mississauga early, driving toward Letchworth, probably hungry by lunchtime, two kids, no big detour."
            className="focus-ring mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm font-normal"
            aria-label="Scenario description"
          />
        </label>
        <button type="button" onClick={interpret} disabled={scenarioBusy || !setup.scenarioText?.trim()} className="focus-ring mt-1 rounded-md border border-navy/30 px-2 py-1 text-xs font-semibold text-navy disabled:opacity-40">
          {scenarioBusy ? "Interpreting…" : "Interpret scenario"}
        </button>
        {scenarioError && <p className="mt-1 text-[11px] text-red-700">{scenarioError}</p>}
        {suggestion && (
          <div className="mt-2 rounded-md border border-teal/40 bg-teal/5 p-2 text-xs" data-testid="scenario-suggestion">
            <p className="font-semibold text-navy">Agent 1 suggests ({suggestion.provider}) — review before applying:</p>
            <ul className="mt-1 list-disc pl-4">
              {suggestion.understood.map((u) => (
                <li key={u}>{u}</li>
              ))}
            </ul>
            {suggestion.warnings.length > 0 && <p className="mt-1 text-amber">⚠ {suggestion.warnings.join("; ")}</p>}
            <div className="mt-2 flex gap-2">
              <button type="button" onClick={applySuggestion} className="rounded bg-teal px-2 py-1 font-semibold text-white">
                Apply to form
              </button>
              <button type="button" onClick={() => setSuggestion(null)} className="rounded border border-slate-300 px-2 py-1">
                Dismiss
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="-mx-3 mt-3 border-t border-slate-200 bg-white px-3 py-2 lg:sticky lg:-bottom-3 lg:pb-3">
        <button type="button" onClick={onPlan} disabled={planning || !canStart} className="focus-ring w-full rounded-md bg-navy px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
          {planning ? "Calculating real route…" : "Plan route & start simulation"}
        </button>
        {planError && (
          <p className="mt-1 text-[11px] text-red-700" role="alert">
            {planError.message}
            {planError.suggestion ? ` — ${planError.suggestion}` : ""}
          </p>
        )}
      </div>
    </div>
  );
}
