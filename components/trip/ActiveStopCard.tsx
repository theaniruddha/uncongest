"use client";

import { useState } from "react";
import type { Need } from "@/lib/domain/types";
import type { StopPlan } from "@/lib/trip/types";

const NEED_LABELS: Record<string, string> = { meal: "ate a meal", coffee: "got coffee", restroom: "used the washroom", ev_charge: "charged the EV", grocery: "bought groceries" };

/** Lifecycle controls for the selected stop: SELECTED → EN_ROUTE → ARRIVED → COMPLETED → RESUMED. */
export default function ActiveStopCard({
  plan,
  elapsed,
  minutesToStop,
  arrivalLocal,
  onGo,
  onJump,
  onSpend,
  onDwell,
  onComplete,
  onResume,
  onCancel
}: {
  plan: StopPlan;
  elapsed: number;
  minutesToStop: number;
  arrivalLocal: string;
  onGo: () => void;
  onJump: () => void;
  onSpend: () => void;
  onDwell: (m: number) => void;
  onComplete: (satisfied: Need[]) => void;
  onResume: () => void;
  onCancel: () => void;
}) {
  const [satisfied, setSatisfied] = useState<Need[]>([]);
  const spent = plan.arrivedAtElapsed != null ? Math.max(0, Math.round(elapsed - plan.arrivedAtElapsed)) : 0;
  const options = plan.categories.filter((c) => c in NEED_LABELS) as Need[];
  return (
    <section className="rounded-xl border-2 border-teal bg-teal/5 p-3" data-testid="active-stop" aria-live="polite">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-navy">{plan.name}</h3>
        <span className="rounded-full bg-teal px-2 py-0.5 text-[11px] font-semibold text-white" data-testid="stop-status">
          {plan.status}
        </span>
      </div>
      <p className="mt-1 text-xs text-slate-600">
        Planned {plan.plannedDwellMinutes} min + {Math.round(plan.detourMinutes)} min detour · destination ETA {arrivalLocal}
      </p>

      {(plan.status === "SELECTED" || plan.status === "EN_ROUTE") && (
        <>
          <p className="mt-2 text-xs">Arriving in ~{Math.max(0, Math.round(minutesToStop))} simulated min.</p>
          <label className="mt-1 block text-xs">
            Planned time there{" "}
            <input type="number" min={2} max={180} value={plan.plannedDwellMinutes} onChange={(e) => onDwell(Math.max(2, Math.min(180, Number(e.target.value) || 0)))} className="w-14 rounded border border-slate-300 px-1" aria-label="Planned minutes at stop" /> min
          </label>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" onClick={onGo} className="rounded-md bg-navy px-3 py-1.5 text-xs font-semibold text-white">
              Drive there (play)
            </button>
            <button type="button" onClick={onJump} className="rounded-md border border-navy/30 px-3 py-1.5 text-xs font-semibold text-navy">
              Skip ahead to arrival
            </button>
            <button type="button" onClick={onCancel} className="rounded-md border border-slate-300 px-3 py-1.5 text-xs">
              Cancel stop
            </button>
          </div>
        </>
      )}

      {plan.status === "ARRIVED" && (
        <>
          <p className="mt-2 text-xs">
            At the stop for {spent} of {plan.plannedDwellMinutes} min. The simulation is paused.
          </p>
          <label className="mt-1 block text-xs">
            Time there{" "}
            <input type="number" min={2} max={180} value={plan.plannedDwellMinutes} onChange={(e) => onDwell(Math.max(2, Math.min(180, Number(e.target.value) || 0)))} className="w-14 rounded border border-slate-300 px-1" aria-label="Minutes at stop" /> min
          </label>
          <button type="button" onClick={onSpend} className="mt-2 rounded-md bg-navy px-3 py-1.5 text-xs font-semibold text-white">
            Spend {Math.max(0, plan.plannedDwellMinutes - spent)} min here
          </button>
          <fieldset className="mt-2 text-xs">
            <legend className="font-semibold text-slate-700">Confirm what happened (nothing is assumed)</legend>
            {options.length === 0 && <p className="text-slate-500">No needs to confirm for this stop type.</p>}
            {options.map((n) => (
              <label key={n} className="mr-3 inline-flex items-center gap-1">
                <input type="checkbox" checked={satisfied.includes(n)} onChange={(e) => setSatisfied(e.target.checked ? [...satisfied, n] : satisfied.filter((x) => x !== n))} />
                {NEED_LABELS[n]}
              </label>
            ))}
          </fieldset>
          <button type="button" onClick={() => onComplete(satisfied)} className="mt-2 rounded-md bg-teal px-3 py-1.5 text-xs font-semibold text-white">
            Complete stop
          </button>
        </>
      )}

      {plan.status === "COMPLETED" && (
        <>
          <p className="mt-2 text-xs">
            Stopped {Math.round(plan.actualDwellMinutes ?? 0)} min. Confirmed: {plan.satisfiedNeeds.length ? plan.satisfiedNeeds.map((n) => NEED_LABELS[n] ?? n).join(", ") : "nothing"}.
          </p>
          <button type="button" onClick={onResume} className="mt-2 rounded-md bg-navy px-3 py-1.5 text-xs font-semibold text-white">
            Resume driving
          </button>
        </>
      )}
    </section>
  );
}
