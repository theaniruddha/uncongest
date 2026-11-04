"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { StrategicPlan, StrategicRunMeta } from "@/lib/agent2/strategicSchema";

export type StrategicStatus = "idle" | "running" | "completed" | "fallback" | "timeout" | "cached" | "stale" | "error";

export interface StrategicState {
  status: StrategicStatus;
  plan: StrategicPlan | null;
  meta: StrategicRunMeta | null;
  /** Wall-clock ms of the last run (client round trip). */
  ms: number | null;
  /** Versions the current plan was computed for. */
  routeVersion: string | null;
  contextVersion: string | null;
  error?: string;
  runs: number;
  staleRejected: number;
}

/**
 * Agent 2 · Strategic Planner client: runs in the background (never blocks the map, playback or
 * Tactical), debounced on route/context version changes — never per simulation tick. Late results
 * are checked against the CURRENT versions; mismatches are rejected as stale and recomputed.
 */
export function useStrategic(opts: {
  enabled: boolean;
  routeVersion: string | null;
  contextVersion: string | null;
  buildInput: () => Record<string, unknown> | null;
  debounceMs?: number;
  onResult?: (s: StrategicState, accepted: boolean) => void;
}) {
  const [state, setState] = useState<StrategicState>({ status: "idle", plan: null, meta: null, ms: null, routeVersion: null, contextVersion: null, runs: 0, staleRejected: 0 });
  const versions = useRef({ route: opts.routeVersion, context: opts.contextVersion });
  versions.current = { route: opts.routeVersion, context: opts.contextVersion };
  const buildRef = useRef(opts.buildInput);
  buildRef.current = opts.buildInput;
  const onResultRef = useRef(opts.onResult);
  onResultRef.current = opts.onResult;
  const inflight = useRef<string | null>(null);

  const run = useCallback(async (reason: string) => {
    const input = buildRef.current();
    if (!input) return;
    const key = `${versions.current.route}|${versions.current.context}`;
    if (inflight.current === key) return;
    inflight.current = key;
    const t0 = performance.now();
    setState((s) => ({ ...s, status: "running", error: undefined }));
    try {
      const res = await fetch("/api/strategic", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
      const data = await res.json().catch(() => null);
      const ms = Math.round(performance.now() - t0);
      if (!res.ok || !data?.plan) {
        setState((s) => ({ ...s, status: "error", ms, error: data?.error ?? `HTTP ${res.status}`, runs: s.runs + 1 }));
        return;
      }
      const plan = data.plan as StrategicPlan;
      const meta = data.meta as StrategicRunMeta;
      const current = plan.routeVersion === versions.current.route && plan.contextVersion === versions.current.context;
      if (!current) {
        setState((s) => {
          const next = { ...s, status: "stale" as const, ms, runs: s.runs + 1, staleRejected: s.staleRejected + 1 };
          onResultRef.current?.({ ...next, plan, meta }, false);
          return next;
        });
        return;
      }
      setState((s) => {
        const next: StrategicState = {
          status: meta.status === "completed" || meta.status === "cached" || meta.status === "fallback" || meta.status === "timeout" ? meta.status : "completed",
          plan,
          meta,
          ms,
          routeVersion: plan.routeVersion,
          contextVersion: plan.contextVersion,
          runs: s.runs + 1,
          staleRejected: s.staleRejected
        };
        onResultRef.current?.(next, true);
        return next;
      });
      void reason;
    } catch (e) {
      setState((s) => ({ ...s, status: "error", error: (e as Error).message, runs: s.runs + 1 }));
    } finally {
      if (inflight.current === key) inflight.current = null;
    }
  }, []);

  // Re-plan when the route or the meaningful context changes (debounced), not on ticks.
  useEffect(() => {
    if (!opts.enabled || !opts.routeVersion || !opts.contextVersion) return;
    if (state.routeVersion === opts.routeVersion && state.contextVersion === opts.contextVersion && state.plan) return;
    const t = setTimeout(() => void run("version change"), opts.debounceMs ?? 1500);
    return () => clearTimeout(t);
  }, [opts.enabled, opts.routeVersion, opts.contextVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  const isCurrent = state.plan != null && state.routeVersion === opts.routeVersion && state.contextVersion === opts.contextVersion;
  return { state, isCurrent, rerun: run, reset: () => setState({ status: "idle", plan: null, meta: null, ms: null, routeVersion: null, contextVersion: null, runs: 0, staleRejected: 0 }) };
}
