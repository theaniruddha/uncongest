"use client";

export interface RouteOptionView {
  id: string;
  summary: string;
  durationMinutes: number;
  distanceKm: number;
  /** Food places found in the lunch/dinner window on this route (null = not checked / unknown). */
  mealOptions: number | null;
  mealNote?: string;
  checking?: boolean;
  strategicReason?: string;
}

/**
 * Real route alternatives (OSRM). Nothing reroutes automatically: the user compares and chooses.
 */
export default function RouteOptions({
  main,
  alternatives,
  loading,
  highlightedId,
  onHighlight,
  onCheck,
  onUse,
  mealWindowLabel,
  suggestion
}: {
  main: RouteOptionView;
  alternatives: RouteOptionView[];
  loading: boolean;
  highlightedId: string | null;
  onHighlight: (id: string | null) => void;
  onCheck: (id: string) => void;
  onUse: (id: string) => void;
  mealWindowLabel: string | null;
  suggestion: { altId: string; text: string } | null;
}) {
  const fmtDelta = (m: number) => `${m >= 0 ? "+" : "−"}${Math.abs(Math.round(m))} min`;
  const meal = (o: RouteOptionView) =>
    o.checking ? "checking…" : o.mealOptions == null ? o.mealNote ?? "not checked" : `${o.mealOptions} food place(s)${o.mealNote ? ` (${o.mealNote})` : ""}`;
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-3" data-testid="route-options">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold text-navy">Route options</h2>
        <span className="text-[11px] text-slate-500">{loading ? "finding alternatives…" : `${alternatives.length} alternative(s)`}</span>
      </div>
      {suggestion && (
        <p className="mt-1 rounded bg-violet-50 px-2 py-1 text-xs text-violet-800" data-testid="route-suggestion">
          💡 {suggestion.text}
        </p>
      )}
      <table className="mt-1 w-full text-xs">
        <thead>
          <tr className="text-left text-slate-500">
            <th className="py-0.5">Route</th>
            <th className="text-right">Time</th>
            <th className="pl-2">{mealWindowLabel ? `Food in ${mealWindowLabel}` : "Food on the way"}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          <tr className="border-t border-slate-100">
            <td className="py-1 font-semibold text-navy">Current · {main.summary || "main route"}</td>
            <td className="text-right">
              {Math.round(main.durationMinutes)} min · {Math.round(main.distanceKm)} km
            </td>
            <td className="pl-2">{meal(main)}</td>
            <td />
          </tr>
          {alternatives.map((a) => (
            <tr
              key={a.id}
              className={`border-t border-slate-100 ${highlightedId === a.id ? "bg-violet-50" : ""}`}
              onMouseEnter={() => onHighlight(a.id)}
              onMouseLeave={() => onHighlight(null)}
              data-testid="route-alt"
            >
              <td className="py-1">
                <span className="font-semibold text-violet-800">{a.summary || a.id}</span>
                {a.strategicReason && <div className="text-[11px] text-slate-500">{a.strategicReason}</div>}
              </td>
              <td className="text-right">
                {fmtDelta(a.durationMinutes - main.durationMinutes)} · {Math.round(a.distanceKm)} km
              </td>
              <td className="pl-2">
                {meal(a)}
                {a.mealOptions == null && !a.checking && (
                  <button type="button" onClick={() => onCheck(a.id)} className="ml-1 underline">
                    check
                  </button>
                )}
              </td>
              <td className="text-right">
                <button type="button" onClick={() => onUse(a.id)} className="rounded border border-violet-300 px-1.5 py-0.5 text-violet-800 hover:bg-violet-50">
                  Use this route
                </button>
              </td>
            </tr>
          ))}
          {!loading && alternatives.length === 0 && (
            <tr>
              <td colSpan={4} className="py-1 text-slate-500">
                No meaningfully different real route found for this trip.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <p className="mt-1 text-[11px] text-slate-500">Alternatives are real OSRM routes (dashed on the map). Uncongest never reroutes on its own — choosing one re-plans from the car&apos;s current position.</p>
    </section>
  );
}
