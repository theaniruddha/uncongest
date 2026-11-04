"use client";

import type { StrategicState } from "./useStrategic";

const STATUS_STYLE: Record<string, string> = {
  idle: "bg-slate-100 text-slate-600",
  running: "bg-sky-100 text-sky-800",
  completed: "bg-teal/10 text-teal",
  cached: "bg-teal/10 text-teal",
  fallback: "bg-amber/15 text-amber",
  timeout: "bg-amber/15 text-amber",
  stale: "bg-red-100 text-red-700",
  error: "bg-red-100 text-red-700"
};

/** "Later on this trip — Strategic": provisional future opportunities, never a command. */
export default function StrategicPanel({
  state,
  isCurrent,
  leadKm,
  placeName,
  update,
  onAskTactical,
  onDismissUpdate
}: {
  state: StrategicState;
  isCurrent: boolean;
  leadKm: number;
  placeName: (id: string) => string | null;
  update: { title: string; reason: string } | null;
  onAskTactical: () => void;
  onDismissUpdate: () => void;
}) {
  const plan = state.plan;
  const ahead = plan?.opportunities.filter((o) => o.toKm >= leadKm) ?? [];
  const label = state.status === "running" && plan ? "updating" : state.status;
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-3" data-testid="strategic">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-bold text-navy">Later on this trip</h2>
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS_STYLE[state.status] ?? ""}`} data-testid="strategic-status">
          Strategic: {label}
          {state.ms != null && state.status !== "running" ? ` · ${(state.ms / 1000).toFixed(1)} s` : ""}
        </span>
      </div>
      {state.status === "running" && !plan && <p className="mt-1 text-xs text-slate-500">Looking ahead: meal windows, gaps in services, weather and arrival…</p>}
      {state.status === "error" && <p className="mt-1 text-xs text-red-700">Strategic planning failed ({state.error}). Tactical recommendations still work.</p>}
      {update && (
        <div className="mt-2 rounded-md border border-teal/50 bg-teal/5 p-2 text-xs" data-testid="strategic-update">
          <p className="font-semibold text-navy">Strategic update: {update.title}</p>
          <p className="text-slate-700">{update.reason}</p>
          <div className="mt-1 flex gap-2">
            <button type="button" onClick={onAskTactical} className="rounded bg-teal px-2 py-0.5 font-semibold text-white">
              Re-check the recommendation
            </button>
            <button type="button" onClick={onDismissUpdate} className="rounded border border-slate-300 px-2 py-0.5">
              Dismiss
            </button>
          </div>
        </div>
      )}
      {plan && (
        <div className={isCurrent ? "" : "opacity-60"}>
          {!isCurrent && <p className="mt-1 text-[11px] text-amber">Plan is from before the latest change — re-planning.</p>}
          <p className="mt-1 text-xs text-slate-700">{plan.summary}</p>
          <ul className="mt-2 space-y-1.5">
            {ahead.slice(0, 5).map((o) => (
              <li key={o.id} className="rounded-md bg-slate-50 px-2 py-1 text-xs" data-testid="strategic-opportunity">
                <div className="flex items-center justify-between gap-2">
                  <strong className="text-navy">{o.title}</strong>
                  <span className={`shrink-0 rounded px-1 text-[10px] font-semibold ${o.priority === "high" ? "bg-red-100 text-red-700" : o.priority === "medium" ? "bg-amber/15 text-amber" : "bg-slate-200 text-slate-600"}`}>
                    {o.priority}
                  </span>
                </div>
                <div className="text-slate-500">
                  km {Math.round(o.fromKm)}–{Math.round(o.toKm)}
                  {o.expectedLocalFrom ? ` · ~${o.expectedLocalFrom}${o.expectedLocalTo ? `–${o.expectedLocalTo}` : ""}` : ""} · {o.kind.replace(/_/g, " ")} · confidence {Math.round(o.confidence * 100)}%
                </div>
                <div className="text-slate-700">{o.reason}</div>
                {o.candidateIds.length > 0 && (
                  <div className="text-slate-500">
                    Places: {o.candidateIds.slice(0, 3).map((id) => placeName(id) ?? id).join(", ")}
                  </div>
                )}
              </li>
            ))}
            {ahead.length === 0 && <li className="text-xs text-slate-500">No further opportunities flagged on the remaining route.</li>}
          </ul>
          {plan.routeDecisions.length > 0 && (
            <div className="mt-2 text-xs">
              <p className="font-semibold text-navy">Route decisions</p>
              <ul className="mt-0.5 space-y-0.5">
                {plan.routeDecisions.map((d) => (
                  <li key={d.id}>
                    • km {Math.round(d.atKm)}: {d.title} — {d.detail}
                    {d.deltaMinutes != null ? ` (${d.deltaMinutes > 0 ? "+" : ""}${Math.round(d.deltaMinutes)} min)` : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {plan.replanTriggers.length > 0 && <p className="mt-1 text-[11px] text-slate-500">Re-plans when: {plan.replanTriggers.slice(0, 3).join("; ")}</p>}
        </div>
      )}
    </section>
  );
}
