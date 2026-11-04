"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { StrategicPlan, StrategicRunMeta } from "@/lib/agent2/strategicSchema";
import { isPlanExpired, strategicClientStatus, strategicRetryDelayMs } from "@/lib/agent2/versions";

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

/** accepted = adopted as the current plan; stale = computed for older versions; error = failed run (previous plan kept). */
export type StrategicOutcome = "accepted" | "stale" | "error";

const INITIAL: StrategicState = { status: "idle", plan: null, meta: null, ms: null, routeVersion: null, contextVersion: null, runs: 0, staleRejected: 0 };

/**
 * Agent 2 · Strategic Planner client: runs in the background (never blocks the map, playback or
 * Tactical), debounced on route/context version changes — never per simulation tick. Late results
 * are checked against the CURRENT versions; mismatches are rejected as stale and recomputed.
 * A newer run aborts the previous request, only the latest run drives the status badge, failed runs
 * are retried with a bounded backoff, and a plan past its expiresAtKm/expiresAtElapsed is not current.
 */
export function useStrategic(opts: {
  enabled: boolean;
  routeVersion: string | null;
  contextVersion: string | null;
  buildInput: () => Record<string, unknown> | null;
  debounceMs?: number;
  /** While true no run is scheduled (e.g. exits still loading — avoids a run per route stage). */
  hold?: boolean;
  /** Current lead position / clock, used only to enforce plan expiry (null = unknown, never expires). */
  leadKm?: number | null;
  elapsedMinutes?: number | null;
  routeTotalKm?: number | null;
  onResult?: (s: StrategicState, outcome: StrategicOutcome) => void;
}) {
  const [state, setState] = useState<StrategicState>(INITIAL);
  const versions = useRef({ route: opts.routeVersion, context: opts.contextVersion });
  versions.current = { route: opts.routeVersion, context: opts.contextVersion };
  const buildRef = useRef(opts.buildInput);
  buildRef.current = opts.buildInput;
  const onResultRef = useRef(opts.onResult);
  onResultRef.current = opts.onResult;
  const inflight = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const seqRef = useRef(0);
  const staleCount = useRef(0);
  const retry = useRef<{ key: string | null; attempt: number; timer: ReturnType<typeof setTimeout> | null }>({ key: null, attempt: 0, timer: null });
  const stateRef = useRef(state);
  stateRef.current = state;

  const commit = (next: StrategicState) => {
    stateRef.current = next;
    setState(next);
  };
  const currentKey = () => `${versions.current.route}|${versions.current.context}`;
  const clearRetryTimer = () => {
    if (retry.current.timer) clearTimeout(retry.current.timer);
    retry.current.timer = null;
  };

  const run = useCallback(async (reason: string): Promise<void> => {
    const input = buildRef.current();
    if (!input) return;
    const key = currentKey();
    if (inflight.current === key) return;
    // A newer run supersedes the previous one: abort it so it never lands (and stops costing).
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const seq = ++seqRef.current;
    const isLatest = () => seq === seqRef.current;
    inflight.current = key;
    const t0 = performance.now();
    commit({ ...stateRef.current, status: "running", error: undefined });

    const fail = (ms: number | null, error: string, meta: StrategicRunMeta | null) => {
      const cur = stateRef.current;
      if (!isLatest()) {
        commit({ ...cur, runs: cur.runs + 1 });
        return;
      }
      // Keep the previous plan and its versions: an empty/failed plan is never adopted as current.
      const next: StrategicState = { ...cur, status: "error", ms, error, meta: meta ?? cur.meta, runs: cur.runs + 1, staleRejected: staleCount.current };
      commit(next);
      onResultRef.current?.(next, "error");
      scheduleRetry(key);
    };

    try {
      const res = await fetch("/api/strategic", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), signal: ctrl.signal });
      const data = await res.json().catch(() => null);
      const ms = Math.round(performance.now() - t0);
      if (!res.ok || !data?.plan) {
        fail(ms, data?.error ?? `HTTP ${res.status}`, null);
        return;
      }
      const plan = data.plan as StrategicPlan;
      const meta = data.meta as StrategicRunMeta;
      const current = plan.routeVersion === versions.current.route && plan.contextVersion === versions.current.context;
      const cur = stateRef.current;
      // Side effects stay OUT of state updaters (React may call updaters twice in dev).
      if (!current) {
        staleCount.current += 1;
        const shownIsCurrent = cur.plan != null && cur.routeVersion === versions.current.route && cur.contextVersion === versions.current.context;
        // Only the latest run owns the badge; a current plan already on screen keeps its own status.
        const status: StrategicStatus = !isLatest() ? cur.status : shownIsCurrent ? strategicClientStatus(cur.meta?.status) : "stale";
        const next: StrategicState = { ...cur, status, ms: isLatest() && !shownIsCurrent ? ms : cur.ms, runs: cur.runs + 1, staleRejected: staleCount.current };
        commit(next);
        onResultRef.current?.({ ...next, plan, meta, ms }, "stale");
        return;
      }
      const status = strategicClientStatus(meta?.status);
      if (status === "error") {
        fail(ms, plan.summary || "strategic planner error", meta);
        return;
      }
      // Never let an older response replace a newer plan for the same versions.
      if (cur.plan && cur.routeVersion === plan.routeVersion && cur.contextVersion === plan.contextVersion && cur.plan.createdAtElapsed > plan.createdAtElapsed) {
        commit({ ...cur, runs: cur.runs + 1 });
        return;
      }
      if (retry.current.key === key) {
        clearRetryTimer();
        retry.current = { key: null, attempt: 0, timer: null };
      }
      const next: StrategicState = {
        status: isLatest() ? status : cur.status,
        plan,
        meta,
        ms,
        routeVersion: plan.routeVersion,
        contextVersion: plan.contextVersion,
        runs: cur.runs + 1,
        staleRejected: staleCount.current
      };
      commit(next);
      onResultRef.current?.(next, "accepted");
      void reason;
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return; // superseded or reset: silent, not an error
      fail(null, (e as Error).message, null);
    } finally {
      if (inflight.current === key) inflight.current = null;
      if (abortRef.current === ctrl) abortRef.current = null;
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** Bounded backoff retry for the same versions; dropped as soon as the versions change. */
  const scheduleRetry = (key: string) => {
    if (retry.current.key !== key) {
      clearRetryTimer();
      retry.current = { key, attempt: 0, timer: null };
    }
    const delay = strategicRetryDelayMs(retry.current.attempt);
    if (delay == null) return;
    retry.current.attempt += 1;
    clearRetryTimer();
    retry.current.timer = setTimeout(() => {
      retry.current.timer = null;
      if (currentKey() === key) void run("retry");
    }, delay);
  };

  // Re-plan when the route or the meaningful context changes (debounced), not on ticks.
  useEffect(() => {
    if (retry.current.key != null && retry.current.key !== currentKey()) {
      clearRetryTimer();
      retry.current = { key: null, attempt: 0, timer: null };
    }
    if (!opts.enabled || opts.hold || !opts.routeVersion || !opts.contextVersion) return;
    const s = stateRef.current;
    if (s.routeVersion === opts.routeVersion && s.contextVersion === opts.contextVersion && s.plan) return;
    const t = setTimeout(() => void run("version change"), opts.debounceMs ?? 1500);
    return () => clearTimeout(t);
  }, [opts.enabled, opts.hold, opts.routeVersion, opts.contextVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(
    () => () => {
      abortRef.current?.abort();
      clearRetryTimer();
    },
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    seqRef.current += 1;
    inflight.current = null;
    staleCount.current = 0;
    clearRetryTimer();
    retry.current = { key: null, attempt: 0, timer: null };
    commit(INITIAL);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const versionsMatch = state.plan != null && state.routeVersion === opts.routeVersion && state.contextVersion === opts.contextVersion;
  /** The shown plan matches the current versions but is past its expiry (km or elapsed). */
  const expired = versionsMatch && isPlanExpired(state.plan, { leadKm: opts.leadKm ?? null, elapsedMinutes: opts.elapsedMinutes ?? null, routeTotalKm: opts.routeTotalKm ?? null });
  const isCurrent = versionsMatch && !expired;
  return { state, isCurrent, expired, rerun: run, reset };
}
