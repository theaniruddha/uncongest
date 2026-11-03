import type { Need } from "@/lib/domain/types";
import type { RouteModel } from "@/lib/route/model";
import type { StopPlan, StopStatus } from "@/lib/trip/types";
import { buildTimeline, type TripCar } from "@/lib/trip/sim";

/**
 * Pure stop-lifecycle reducer.
 * PROPOSED → SELECTED → EN_ROUTE → ARRIVED → COMPLETED → RESUMED; CANCELLED from any state before ARRIVED.
 * Only one active (SELECTED / EN_ROUTE / ARRIVED) stop per car.
 * satisfiedNeeds is ONLY ever set by an explicit "complete" action — never inferred.
 */
export type StopAction =
  | { type: "select"; plan: StopPlan }
  | { type: "setDwell"; stopId: string; minutes: number }
  | { type: "setParticipants"; stopId: string; carIds: string[] }
  | { type: "enRoute"; stopId: string; elapsed: number }
  | { type: "arrive"; stopId: string; elapsed: number }
  | { type: "complete"; stopId: string; elapsed: number; satisfiedNeeds: Need[] }
  | { type: "resume"; stopId: string; elapsed: number }
  | { type: "cancel"; stopId: string };

export interface StopReducerResult {
  plans: StopPlan[];
  error?: string;
}

export const ACTIVE_STATUSES: readonly StopStatus[] = ["SELECTED", "EN_ROUTE", "ARRIVED"];

const NEXT: Partial<Record<StopAction["type"], { from: StopStatus[]; to: StopStatus }>> = {
  enRoute: { from: ["SELECTED"], to: "EN_ROUTE" },
  arrive: { from: ["EN_ROUTE"], to: "ARRIVED" },
  complete: { from: ["ARRIVED"], to: "COMPLETED" },
  resume: { from: ["COMPLETED"], to: "RESUMED" },
  cancel: { from: ["PROPOSED", "SELECTED", "EN_ROUTE"], to: "CANCELLED" }
};

/** Car ids among `carIds` that already have an active stop other than `exceptStopId`. */
function busyCars(plans: StopPlan[], carIds: string[], exceptStopId: string): string[] {
  return carIds.filter((id) => plans.some((p) => p.stopId !== exceptStopId && ACTIVE_STATUSES.includes(p.status) && p.participants.includes(id)));
}

export function stopReducer(plans: StopPlan[], action: StopAction): StopReducerResult {
  const fail = (error: string): StopReducerResult => ({ plans, error });

  if (action.type === "select") {
    const plan = action.plan;
    const existing = plans.find((p) => p.stopId === plan.stopId);
    if (existing && existing.status !== "PROPOSED") return fail(`stop ${plan.stopId} is ${existing.status}; only PROPOSED stops can be selected`);
    if (plan.status !== "PROPOSED" && plan.status !== "SELECTED") return fail(`cannot select a plan in status ${plan.status}`);
    if (plan.participants.length === 0) return fail("a selected stop needs at least one participating car");
    const busy = busyCars(plans, plan.participants, plan.stopId);
    if (busy.length) return fail(`car(s) ${busy.join(", ")} already have an active stop`);
    const next: StopPlan = { ...plan, status: "SELECTED", satisfiedNeeds: [] };
    return { plans: existing ? plans.map((p) => (p.stopId === plan.stopId ? next : p)) : [...plans, next] };
  }

  const idx = plans.findIndex((p) => p.stopId === action.stopId);
  if (idx < 0) return fail(`unknown stop ${action.stopId}`);
  const cur = plans[idx];
  const replace = (p: StopPlan): StopReducerResult => ({ plans: plans.map((x, i) => (i === idx ? p : x)) });

  switch (action.type) {
    case "setDwell": {
      if (!Number.isFinite(action.minutes) || action.minutes < 0) return fail("dwell must be ≥ 0 minutes");
      if (!["PROPOSED", "SELECTED", "EN_ROUTE", "ARRIVED"].includes(cur.status)) return fail(`cannot change dwell of a ${cur.status} stop`);
      return replace({ ...cur, plannedDwellMinutes: action.minutes });
    }
    case "setParticipants": {
      if (!["PROPOSED", "SELECTED", "EN_ROUTE"].includes(cur.status)) return fail(`cannot change participants of a ${cur.status} stop`);
      const ids = [...new Set(action.carIds)];
      if (ids.length === 0) return fail("a stop needs at least one participating car (cancel it instead)");
      if (cur.status !== "PROPOSED") {
        const busy = busyCars(plans, ids, cur.stopId);
        if (busy.length) return fail(`car(s) ${busy.join(", ")} already have an active stop`);
      }
      return replace({ ...cur, participants: ids });
    }
    default: {
      const rule = NEXT[action.type];
      if (!rule || !rule.from.includes(cur.status)) return fail(`invalid transition ${cur.status} → ${rule?.to ?? action.type}`);
      if (action.type === "enRoute") return replace({ ...cur, status: "EN_ROUTE" });
      if (action.type === "arrive") return replace({ ...cur, status: "ARRIVED", arrivedAtElapsed: action.elapsed });
      if (action.type === "complete") {
        const arrived = cur.arrivedAtElapsed ?? action.elapsed;
        if (action.elapsed < arrived) return fail("cannot complete a stop before it was arrived at");
        return replace({
          ...cur,
          status: "COMPLETED",
          departedAtElapsed: action.elapsed,
          actualDwellMinutes: action.elapsed - arrived,
          satisfiedNeeds: [...new Set(action.satisfiedNeeds)]
        });
      }
      if (action.type === "resume") return replace({ ...cur, status: "RESUMED" });
      return replace({ ...cur, status: "CANCELLED" });
    }
  }
}

export interface AutoAdvanceResult {
  plans: StopPlan[];
  transitions: Array<{ stopId: string; to: StopStatus; atElapsed: number }>;
}

/**
 * Derive EN_ROUTE / ARRIVED from sim positions. Each active stop is tracked by the lead car when it
 * participates, otherwise by its first participating car. EN_ROUTE fires once the tracking car is
 * within `enRouteMinutes` (default 10) of reaching the stop's km; ARRIVED fires when it reaches
 * the stop, recording the simulated arrival minute (not the tick time). Never completes a stop.
 */
export function autoAdvance(
  plans: StopPlan[],
  cars: TripCar[],
  elapsed: number,
  route: RouteModel,
  opts: { enRouteMinutes?: number } = {}
): AutoAdvanceResult {
  const enRouteMinutes = opts.enRouteMinutes ?? 10;
  let out = plans;
  const transitions: AutoAdvanceResult["transitions"] = [];
  for (const plan of plans) {
    if (plan.status !== "SELECTED" && plan.status !== "EN_ROUTE") continue;
    const car =
      cars.find((c) => c.role === "lead" && plan.participants.includes(c.id)) ?? cars.find((c) => plan.participants.includes(c.id));
    if (!car) continue;
    const tl = buildTimeline(car, route, out);
    const exitSeg = tl.segments.find((s) => s.phase === "exiting" && s.stop?.stopId === plan.stopId);
    if (!exitSeg) continue;
    const arriveAt = exitSeg.end;
    if (plan.status === "SELECTED" && elapsed >= exitSeg.start - enRouteMinutes) {
      const r = stopReducer(out, { type: "enRoute", stopId: plan.stopId, elapsed });
      if (!r.error) {
        out = r.plans;
        transitions.push({ stopId: plan.stopId, to: "EN_ROUTE", atElapsed: Math.max(exitSeg.start - enRouteMinutes, 0) });
      }
    }
    if (elapsed >= arriveAt) {
      const r = stopReducer(out, { type: "arrive", stopId: plan.stopId, elapsed: arriveAt });
      if (!r.error) {
        out = r.plans;
        transitions.push({ stopId: plan.stopId, to: "ARRIVED", atElapsed: arriveAt });
      }
    }
  }
  return { plans: out, transitions };
}
