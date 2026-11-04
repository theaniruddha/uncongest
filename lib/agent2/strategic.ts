import { z } from "zod";
import { dietarySchema, needSchema } from "@/lib/domain/schemas";
import { routeModelForRef } from "@/lib/providers/routeRef";
import { getStoredRoute } from "@/lib/providers/routing";
import type { RouteModel } from "@/lib/route/model";
import { mealHistorySchema, mealPreferenceSchema, moodSchema, type TripRoute } from "@/lib/trip/types";
import { callMuseStructured, museModelName, type MuseStructuredRequest, type MuseStructuredResult } from "./museStructured";
import {
  strategicPlanSchema,
  type StrategicEvidence,
  type StrategicOpportunity,
  type StrategicPlan,
  type StrategicResponse,
  type StrategicRunMeta
} from "./strategicSchema";
import {
  DEFAULT_TOOLS,
  computeFutureWindows,
  cruiseSpeedFor,
  localAtKm,
  runTools,
  type AlternativesData,
  type ArrivalData,
  type BorderData,
  type CompactPlace,
  type Evidence,
  type FutureWindowsData,
  type PlacesData,
  type ToolContext,
  type ToolImpls,
  type ToolTraceItem,
  type WeatherData
} from "./strategicTools";

/* ------------------------------------------------------------------------------------------
 * Agent 2 · Strategic Planner workflow.
 * Deterministic tools (bounded, concurrent) → compact evidence → ONE Muse structured call →
 * deterministic post-validation. Any Muse failure degrades to a deterministic plan built from
 * the same evidence. Never blocks the map, the simulation, or the Tactical workflow.
 * ---------------------------------------------------------------------------------------- */

const placeSchema = z.object({
  label: z.string().min(1).max(200),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  type: z.enum(["home", "hotel", "other"]).default("other")
});

const validTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

export const strategicInputSchema = z.object({
  routeRef: z.object({ id: z.string().min(1).max(200), origin: placeSchema, destination: placeSchema }),
  routeVersion: z.string().min(1).max(120),
  contextVersion: z.string().min(1).max(120),
  sessionId: z.string().min(1).max(120),
  timeZone: z.string().min(1).max(64).refine(validTimeZone, "unknown IANA time zone").default("America/Toronto"),
  departureUtc: z.string().datetime({ offset: true }),
  elapsedMinutes: z.number().min(0).max(60 * 24 * 3),
  leadKm: z.number().min(0),
  leadSpeedKph: z.number().min(0).max(200),
  /** Optional planning speed; defaults to leadSpeedKph when moving, else 95 km/h. */
  cruiseSpeedKph: z.number().min(30).max(150).optional(),
  localTime: z.string().regex(/^\d{2}:\d{2}$/),
  /** Compact needs per car id, e.g. { car_a: ["meal"], car_b: [] }. */
  needs: z.record(z.string().max(40), z.array(needSchema).max(5)).default({}),
  mood: z.array(moodSchema).max(4).default([]),
  mealPreference: mealPreferenceSchema.default("auto"),
  mealHistory: mealHistorySchema.default({ kind: "unknown" }),
  dietary: z.array(dietarySchema).max(4).default([]),
  kids: z.boolean().default(false),
  lastMealMinutesAgo: z.number().min(0).nullable().default(null),
  drivingMinutesSinceRest: z.number().min(0).default(0),
  dataMode: z.enum(["real", "demo"]).default("real")
});
export type StrategicInput = z.infer<typeof strategicInputSchema>;
export type StrategicInputRaw = z.input<typeof strategicInputSchema>;

export interface StrategicDeps {
  tools?: Partial<ToolImpls>;
  muse?: (req: MuseStructuredRequest<ModelPlan>) => Promise<MuseStructuredResult<ModelPlan>>;
  /** Pre-resolved route (tests / callers that already hold it). */
  route?: RouteModel;
  /** Stored TripRoute (alternatives, border crossings). `null` = known to be unavailable. */
  tripRoute?: TripRoute | null;
  deadlineMs?: number;
  /** Skip the in-memory cache (tests). */
  noCache?: boolean;
  fetchImpl?: typeof fetch;
}

/* ------------------------------------------------------------------ model output contract */

const nullableStr = z.string().nullable().optional();
const modelOpportunitySchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["meal", "coffee", "restroom", "rest_break", "fuel_or_charge", "groceries", "route_choice", "limited_service_stretch", "arrival"]),
  title: z.string().min(1),
  fromKm: z.number(),
  toKm: z.number(),
  candidateIds: z.array(z.string()).default([]),
  reason: z.string().min(1),
  evidenceRefs: z.array(z.string()).default([]),
  priority: z.enum(["high", "medium", "low"]),
  confidence: z.number(),
  watchFor: nullableStr
});
const modelPlanSchema = z.object({
  summary: z.string(),
  opportunities: z.array(modelOpportunitySchema),
  routeDecisions: z
    .array(
      z.object({
        id: z.string().min(1),
        title: z.string().min(1),
        atKm: z.number(),
        detail: z.string(),
        alternativeRouteId: nullableStr,
        deltaMinutes: z.number().nullable().optional()
      })
    )
    .default([]),
  replanTriggers: z.array(z.string()).default([]),
  expiresAtKm: z.number().nullable().optional(),
  uncertainty: nullableStr
});
export type ModelPlan = z.infer<typeof modelPlanSchema>;

const S = { type: "string" } as const;
const N = { type: "number" } as const;
const NS = { type: ["string", "null"] } as const;
const NN = { type: ["number", "null"] } as const;
const obj = (properties: Record<string, unknown>) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });

/** Strict JSON schema sent to Muse (`text.format`). Length limits are enforced after parsing. */
export const STRATEGIC_JSON_SCHEMA = obj({
  summary: S,
  opportunities: {
    type: "array",
    items: obj({
      id: S,
      kind: { type: "string", enum: modelOpportunitySchema.shape.kind.options },
      title: S,
      fromKm: N,
      toKm: N,
      candidateIds: { type: "array", items: S },
      reason: S,
      evidenceRefs: { type: "array", items: S },
      priority: { type: "string", enum: ["high", "medium", "low"] },
      confidence: N,
      watchFor: NS
    })
  },
  routeDecisions: { type: "array", items: obj({ id: S, title: S, atKm: N, detail: S, alternativeRouteId: NS, deltaMinutes: NN }) },
  replanTriggers: { type: "array", items: S },
  expiresAtKm: NN,
  uncertainty: NS
});

export const STRATEGIC_SYSTEM_PROMPT = [
  "You are the Strategic Planner of Uncongest's travel-intelligence agent, planning ahead for a road-trip group.",
  "Question: What future stopping or route opportunities could materially affect this journey, and what events should trigger another look?",
  "Use only the evidence and candidate ids given; cite evidence ids in evidenceRefs; never invent places, times, or facts.",
  "km values are along the current route and must be ahead of leadKm. At most 6 opportunities; brief, calm user-facing text.",
  "This is a provisional plan, not a command: the tactical workflow decides what to recommend now."
].join(" ");

/* ------------------------------------------------------------------ helpers */

const r0 = (x: number) => Math.round(x);
const clip = (s: string | null | undefined, n: number) => {
  const t = (s ?? "").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const byTool = <D>(ev: Evidence[], tool: string): Evidence<D> | undefined => ev.find((e) => e.tool === tool && e.data != null) as Evidence<D> | undefined;

/** All real candidates the place tools returned (the only ids a plan may cite). */
export function candidatesFromEvidence(ev: Evidence[]): Map<string, CompactPlace> {
  const out = new Map<string, CompactPlace>();
  for (const e of ev) {
    const list = (e.data as { candidates?: CompactPlace[] } | null)?.candidates;
    if (Array.isArray(list)) for (const c of list) if (c && typeof c.id === "string") out.set(c.id, c);
  }
  return out;
}

function compactEvidenceForModel(ev: Evidence[]) {
  return ev.map((e) => {
    let data: unknown = e.data;
    if (e.tool === "placesInWindows" && e.data) {
      const d = e.data as PlacesData;
      // ≤ 6 candidates per window, km-ordered, so the prompt stays short.
      const shown = new Map<string, CompactPlace>();
      for (const w of d.perWindow) {
        d.candidates
          .filter((c) => c.km >= w.fromKm - 3 && c.km <= w.toKm + 3)
          .sort((a, b) => Number(b.restroomsVerified === true) - Number(a.restroomsVerified === true) || a.km - b.km)
          .slice(0, 6)
          .forEach((c) => shown.set(c.id, c));
      }
      data = { perWindow: d.perWindow, gaps: d.gaps, candidates: [...shown.values()].sort((a, b) => a.km - b.km) };
    }
    return { id: e.id, tool: e.tool, provenance: e.provenance, summary: e.summary, data };
  });
}

function toPlanEvidence(ev: Evidence[]): StrategicEvidence[] {
  return ev.slice(0, 30).map((e) => ({ id: e.id, tool: e.tool, summary: clip(e.summary, 300) || "(no summary)", provenance: e.provenance }));
}

const PLACE_KINDS: Record<string, (c: CompactPlace) => boolean> = {
  meal: (c) => c.categories.includes("meal"),
  coffee: (c) => c.categories.includes("coffee"),
  restroom: (c) => c.categories.includes("restroom") || c.restroomsVerified === true,
  rest_break: (c) => c.categories.includes("restroom") || c.restroomsVerified === true || c.categories.includes("coffee"),
  groceries: (c) => c.categories.includes("grocery"),
  fuel_or_charge: (c) => c.categories.includes("ev_charge")
};

/* ------------------------------------------------------------------ post-validation */

interface PlanCtx {
  input: StrategicInput;
  route: RouteModel;
  tripRoute: TripRoute | null;
  evidence: Evidence[];
  cruiseSpeedKph: number;
}

/**
 * Deterministic guard rails applied to EVERY plan (Muse or fallback): forced versions, real
 * candidate ids only, known evidence refs only, km clamped to the route, nothing behind the
 * lead, deterministic expected local times, length limits. Returns a strategicPlanSchema-valid
 * plan or throws (caller falls back).
 */
export function finalizePlan(raw: ModelPlan, ctx: PlanCtx): StrategicPlan {
  const { input, route } = ctx;
  const lead = route.clampKm(input.leadKm);
  const validIds = candidatesFromEvidence(ctx.evidence);
  const evIds = new Set(ctx.evidence.map((e) => e.id));
  const altIds = new Set((ctx.tripRoute?.alternatives ?? []).map((a) => a.id));
  const timeCtx = { input, cruiseSpeedKph: ctx.cruiseSpeedKph };
  const seen = new Set<string>();
  const rk = (km: number) => Math.min(Math.round(km * 10) / 10, Math.floor(route.totalKm * 10) / 10);

  const opportunities: StrategicOpportunity[] = [];
  for (const o of raw.opportunities) {
    let from = route.clampKm(Math.min(o.fromKm, o.toKm));
    const to = route.clampKm(Math.max(o.fromKm, o.toKm));
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < lead) continue; // behind the lead / expired
    from = Math.max(from, lead);
    let id = clip(o.id, 60) || `o${opportunities.length + 1}`;
    while (seen.has(id)) id = `${id}_`;
    seen.add(id);
    opportunities.push({
      id,
      kind: o.kind,
      title: clip(o.title, 120),
      fromKm: rk(from),
      toKm: rk(to),
      expectedLocalFrom: localAtKm(timeCtx, from),
      expectedLocalTo: localAtKm(timeCtx, to),
      candidateIds: [...new Set(o.candidateIds)].filter((cid) => validIds.has(cid)).slice(0, 8),
      reason: clip(o.reason, 300),
      evidenceRefs: [...new Set(o.evidenceRefs)].filter((r) => evIds.has(r)).slice(0, 10),
      priority: o.priority,
      confidence: Math.min(1, Math.max(0, Number.isFinite(o.confidence) ? o.confidence : 0.5)),
      watchFor: o.watchFor ? clip(o.watchFor, 200) : undefined
    });
  }
  opportunities.sort((a, b) => a.fromKm - b.fromKm);

  const routeDecisions = raw.routeDecisions
    .filter((d) => Number.isFinite(d.atKm) && route.clampKm(d.atKm) >= lead)
    .slice(0, 5)
    .map((d) => ({
      id: clip(d.id, 60) || "d",
      title: clip(d.title, 140),
      atKm: rk(route.clampKm(d.atKm)),
      detail: clip(d.detail, 300),
      alternativeRouteId: d.alternativeRouteId && altIds.has(d.alternativeRouteId) ? d.alternativeRouteId : undefined,
      deltaMinutes: d.deltaMinutes ?? undefined
    }));

  const defaultExpiryKm = Math.min(route.totalKm, lead + 150);
  const expiresAtKm = raw.expiresAtKm != null && raw.expiresAtKm > lead ? route.clampKm(raw.expiresAtKm) : defaultExpiryKm;

  const plan: StrategicPlan = {
    routeVersion: input.routeVersion,
    contextVersion: input.contextVersion,
    createdAtElapsed: input.elapsedMinutes,
    summary: clip(raw.summary, 400),
    opportunities: opportunities.slice(0, 10),
    routeDecisions,
    evidence: toPlanEvidence(ctx.evidence),
    replanTriggers: raw.replanTriggers.map((t) => clip(t, 160)).filter(Boolean).slice(0, 8),
    expiresAtKm: rk(expiresAtKm),
    expiresAtElapsed: input.elapsedMinutes + 90,
    uncertainty: raw.uncertainty ? clip(raw.uncertainty, 240) : undefined
  };
  return strategicPlanSchema.parse(plan);
}

/* ------------------------------------------------------------------ deterministic fallback */

export function buildFallbackPlan(ctx: PlanCtx): ModelPlan {
  const { input, route, evidence } = ctx;
  const lead = input.leadKm;
  const fw = byTool<FutureWindowsData>(evidence, "futureWindows");
  const pl = byTool<PlacesData>(evidence, "placesInWindows");
  const wx = byTool<WeatherData>(evidence, "weatherAtWaypoints");
  const ar = byTool<ArrivalData>(evidence, "destinationArrival");
  const alt = byTool<AlternativesData>(evidence, "routeAlternatives");
  const bd = byTool<BorderData>(evidence, "borderCrossing");
  const places = pl?.data.candidates ?? [];
  const opportunities: ModelPlan["opportunities"] = [];
  const routeDecisions: ModelPlan["routeDecisions"] = [];
  const triggers: string[] = [];
  const summaryBits: string[] = [];

  for (const w of fw?.data.windows ?? []) {
    const kind = w.kinds.includes("meal") ? "meal" : w.kinds.includes("rest_break") ? "rest_break" : "coffee";
    const match = PLACE_KINDS[kind];
    const inWindow = places
      .filter((c) => c.km >= w.fromKm - 3 && c.km <= w.toKm + 3 && match(c))
      .sort((a, b) => Number(b.restroomsVerified === true) - Number(a.restroomsVerified === true) || a.km - b.km)
      .slice(0, 4);
    const label = kind === "meal" ? (/dinner/.test(w.reason) ? "Dinner" : /lunch/.test(w.reason) ? "Lunch" : "Meal") : kind === "rest_break" ? "Rest break" : "Coffee";
    const placeNote = pl && pl.provenance !== "unavailable" ? `${inWindow.length} suitable place(s) found` : "place lookup unavailable";
    opportunities.push({
      id: `fb-${w.id}`,
      kind,
      title: `${label} stop around km ${r0(w.fromKm)}–${r0(w.toKm)}`,
      fromKm: w.fromKm,
      toKm: w.toKm,
      candidateIds: inWindow.map((c) => c.id),
      reason: clip(`${w.reason} (${w.expectedLocalFrom}–${w.expectedLocalTo}); ${placeNote}.`, 300),
      evidenceRefs: [fw!.id, ...(pl ? [pl.id] : [])],
      priority: kind === "meal" ? "medium" : "low",
      confidence: inWindow.length ? 0.6 : 0.35,
      watchFor: kind === "meal" ? "A car reports hunger, or the window starts without a meal" : "Driving time since the last rest passes the threshold"
    });
  }
  if (fw?.data.windows.length) triggers.push(`Lead reaches km ${r0(fw.data.windows[0].fromKm)} (start of the next stop window)`);

  for (const g of pl?.data.gaps ?? []) {
    opportunities.push({
      id: `fb-gap-${r0(g.fromKm)}`,
      kind: "limited_service_stretch",
      title: `Few food/restroom options km ${r0(g.fromKm)}–${r0(g.toKm)}`,
      fromKm: g.fromKm,
      toKm: g.toKm,
      candidateIds: [],
      reason: clip(`About ${g.lengthKm} km with no food or restroom place found along the searched route.`, 300),
      evidenceRefs: [pl!.id],
      priority: "medium",
      confidence: 0.55,
      watchFor: `Offer a restroom/food stop before km ${r0(g.fromKm)}`
    });
  }

  for (const c of bd?.data.crossings ?? []) {
    if (c.km <= lead) continue;
    const counted = bd!.provenance !== "unavailable";
    const fewerAfter = counted && c.afterCount < c.beforeCount;
    opportunities.push({
      id: `fb-border-${r0(c.km)}`,
      kind: "route_choice",
      title: clip(`Border crossing${c.name ? ` (${c.name})` : ""} at km ${r0(c.km)}`, 120),
      fromKm: Math.max(lead, c.km - 40),
      toKm: c.km,
      candidateIds: fewerAfter ? c.beforeIds : [],
      reason: clip(
        counted
          ? `${c.beforeCount} food/restroom place(s) within 40 km before the crossing vs ${c.afterCount} after${fewerAfter ? "; consider stopping before customs" : ""}.`
          : "Border crossing ahead; place counts unavailable — consider a stop before customs.",
        300
      ),
      evidenceRefs: [bd!.id, ...(alt ? [alt.id] : [])],
      priority: fewerAfter ? "high" : "medium",
      confidence: counted ? 0.65 : 0.4,
      watchFor: "Border wait times, or a need arising close to the crossing"
    });
    routeDecisions.push({ id: `border-${r0(c.km)}`, title: clip(`Border crossing at km ${r0(c.km)}`, 140), atKm: c.km, detail: "Passports/ID ready; stop before the crossing if anyone needs a break.", alternativeRouteId: null, deltaMinutes: null });
    triggers.push(`Within 40 km of the border crossing (km ${r0(c.km)})`);
  }

  for (const a of alt?.data.alternatives ?? []) {
    if (a.deltaMinutes > 25 && !a.avoidsCrossings.length) continue;
    routeDecisions.push({
      id: `alt-${a.id}`,
      title: clip(`Alternative via ${a.summary || a.id}`, 140),
      atKm: lead,
      detail: clip(`${a.deltaMinutes >= 0 ? "+" : ""}${a.deltaMinutes} min, ${a.deltaKm >= 0 ? "+" : ""}${a.deltaKm} km vs the main route${a.avoidsCrossings.length ? `; avoids ${a.avoidsCrossings.join(", ")}` : ""}.`, 300),
      alternativeRouteId: a.id,
      deltaMinutes: a.deltaMinutes
    });
  }

  if (ar) {
    summaryBits.push(`Arrival ~${ar.data.arrivalLocal}${ar.data.afterDark ? " after dark" : ""}`);
    if (ar.data.afterDark) {
      opportunities.push({
        id: "fb-arrival",
        kind: "arrival",
        title: "Arrival after dark",
        fromKm: Math.max(lead, ar.data.destinationKm - 20),
        toKm: ar.data.destinationKm,
        candidateIds: [],
        reason: clip(`Expected arrival ~${ar.data.arrivalLocal}, ${ar.data.minutesAfterSunset ?? "?"} min after sunset (${ar.data.sunsetLocal ?? "n/a"}); long stops push it later.`, 300),
        evidenceRefs: [ar.id],
        priority: ar.data.destinationType === "hotel" ? "medium" : "low",
        confidence: 0.7,
        watchFor: "Total stop time growing; arrival slipping further past sunset"
      });
      triggers.push("Planned stop time grows enough to move arrival later");
    }
  }

  const wet = (wx?.data.points ?? []).filter((p) => p.condition === "rain" || p.condition === "snow");
  if (wet.length) {
    summaryBits.push(`${wet[0].description} expected near km ${wet[0].km}`);
    triggers.push(`Weather changes at km ${wet[0].km} (${wet[0].description} forecast)`);
  }
  triggers.push("A car reports a new need or a stop is selected/completed", "Route or departure changes");

  const nOpp = opportunities.filter((o) => o.kind !== "limited_service_stretch" && o.kind !== "arrival").length;
  const summary = clip(
    [nOpp ? `${nOpp} stop window(s) ahead` : "No stop windows ahead", ...summaryBits, pl?.data.gaps.length ? `${pl.data.gaps.length} long stretch(es) with few services` : ""].filter(Boolean).join("; ") + ".",
    400
  );
  const unavailable = evidence.filter((e) => e.provenance === "unavailable").map((e) => e.tool);
  return {
    summary,
    opportunities: opportunities.filter((o) => o.toKm > lead).slice(0, 10),
    routeDecisions: routeDecisions.slice(0, 5),
    replanTriggers: [...new Set(triggers)].slice(0, 8),
    expiresAtKm: Math.min(route.totalKm, (fw?.data.windows.slice(-1)[0]?.toKm ?? lead + 120) + 30),
    uncertainty: unavailable.length ? clip(`Deterministic plan; unavailable: ${unavailable.join(", ")}.`, 240) : "Deterministic plan built from tool evidence (no model reasoning)."
  };
}

/* ------------------------------------------------------------------ cache */

interface CacheEntry {
  at: number;
  ttl: number;
  res: StrategicResponse;
}
const CACHE_TTL_MS = 10 * 60_000;
const SHORT_TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<StrategicResponse>>();

export function clearStrategicCache(): void {
  cache.clear();
  inflight.clear();
}

const cacheKey = (i: StrategicInput) => `${i.routeRef.id}|${i.routeVersion}|${i.contextVersion}`;

/* ------------------------------------------------------------------ planner */

function deadlineFromEnv(): number {
  const v = Number(process.env.STRATEGIC_DEADLINE_MS);
  return Number.isFinite(v) && v > 0 ? Math.min(v, 50_000) : 30_000;
}

function emptyPlan(input: StrategicInput, summary: string): StrategicPlan {
  return strategicPlanSchema.parse({
    routeVersion: input.routeVersion,
    contextVersion: input.contextVersion,
    createdAtElapsed: input.elapsedMinutes,
    summary: clip(summary, 400),
    opportunities: [],
    routeDecisions: [],
    evidence: [],
    replanTriggers: ["Route becomes available"],
    uncertainty: "No route data; nothing planned."
  });
}

export async function runStrategicPlanner(input: StrategicInput, deps: StrategicDeps = {}): Promise<StrategicResponse> {
  const key = cacheKey(input);
  const started = Date.now();
  if (!deps.noCache) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < hit.ttl) {
      return { plan: hit.res.plan, meta: { ...hit.res.meta, status: "cached", ms: Date.now() - started } };
    }
    if (hit) cache.delete(key);
    const pending = inflight.get(key);
    if (pending) {
      const res = await pending;
      return { plan: res.plan, meta: { ...res.meta, status: "cached", ms: Date.now() - started } };
    }
  }
  const p = plan(input, deps);
  if (!deps.noCache) inflight.set(key, p);
  try {
    const res = await p;
    if (!deps.noCache && res.meta.status !== "error") {
      const durable = res.meta.status === "completed" || (res.meta.status === "fallback" && res.meta.muse?.error?.startsWith("disabled"));
      cache.set(key, { at: Date.now(), ttl: durable ? CACHE_TTL_MS : SHORT_TTL_MS, res });
      while (cache.size > 200) cache.delete(cache.keys().next().value as string);
    }
    return res;
  } finally {
    inflight.delete(key);
  }
}

async function plan(input: StrategicInput, deps: StrategicDeps): Promise<StrategicResponse> {
  const started = Date.now();
  const trace: ToolTraceItem[] = [];

  // ---- route (context layer) ----
  let route: RouteModel;
  try {
    if (deps.route) route = deps.route;
    else {
      const t0 = Date.now();
      route = await Promise.race([
        routeModelForRef(input.routeRef, input.sessionId),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("route lookup timed out")), 12_000))
      ]);
      trace.push({ tool: "route.lookup", input: input.routeRef.id, output: `${r0(route.totalKm)} km (${route.source})`, provenance: "cached", ms: Date.now() - t0 });
    }
  } catch (err) {
    trace.push({ tool: "route.lookup", input: input.routeRef.id, output: `failed: ${(err as Error).message}`, provenance: "unavailable" });
    return { plan: emptyPlan(input, "Route unavailable; strategic plan skipped."), meta: { status: "error", provider: "deterministic", ms: Date.now() - started, toolTrace: trace } };
  }
  const tripRoute = deps.tripRoute !== undefined ? deps.tripRoute : getStoredRoute(input.routeRef.id) ?? null;
  const cruiseSpeedKph = cruiseSpeedFor(input);
  const nowUtc = new Date(new Date(input.departureUtc).getTime() + input.elapsedMinutes * 60_000);
  const ctx: ToolContext = {
    input,
    route,
    tripRoute,
    windows: computeFutureWindows(input, route, cruiseSpeedKph),
    cruiseSpeedKph,
    nowUtc,
    fetchImpl: deps.fetchImpl
  };

  // ---- tools (bounded concurrency, per-tool timeouts) ----
  const { evidence, trace: toolTrace } = await runTools(ctx, { ...DEFAULT_TOOLS, ...(deps.tools ?? {}) });
  trace.push(...toolTrace);
  const planCtx: PlanCtx = { input, route, tripRoute, evidence, cruiseSpeedKph };

  // ---- ONE Muse structured call ----
  const deadlineMs = deps.deadlineMs ?? deadlineFromEnv();
  const muse = deps.muse ?? callMuseStructured;
  const user = JSON.stringify({
    trip: {
      leadKm: r0(input.leadKm),
      routeKm: r0(route.totalKm),
      localTime: input.localTime,
      elapsedMinutes: r0(input.elapsedMinutes),
      cruiseSpeedKph: r0(cruiseSpeedKph),
      origin: input.routeRef.origin.label,
      destination: `${input.routeRef.destination.label} (${input.routeRef.destination.type})`,
      needs: input.needs,
      mood: input.mood,
      mealPreference: input.mealPreference,
      mealHistory: input.mealHistory,
      lastMealMinutesAgo: input.lastMealMinutesAgo,
      dietary: input.dietary,
      kids: input.kids,
      drivingMinutesSinceRest: r0(input.drivingMinutesSinceRest)
    },
    evidence: compactEvidenceForModel(evidence)
  });
  const t0 = Date.now();
  let guard: ReturnType<typeof setTimeout> | undefined;
  // Outer guard in case an injected client ignores its deadline.
  const res: MuseStructuredResult<ModelPlan> = await Promise.race([
    muse({ system: STRATEGIC_SYSTEM_PROMPT, user, schemaName: "strategic_plan", jsonSchema: STRATEGIC_JSON_SCHEMA, zod: modelPlanSchema, effort: "medium", deadlineMs }),
    new Promise<MuseStructuredResult<ModelPlan>>((resolve) => {
      guard = setTimeout(() => resolve({ ok: false, reason: "timeout", detail: `strategic deadline ${deadlineMs} ms exceeded`, ms: Date.now() - t0 }), deadlineMs + 1000);
    })
  ]).catch((err: unknown): MuseStructuredResult<ModelPlan> => ({ ok: false, reason: "http", detail: (err as Error).message, ms: Date.now() - t0 }));
  if (guard) clearTimeout(guard);

  const model = museModelName();
  let status: StrategicRunMeta["status"];
  let museMeta: StrategicRunMeta["muse"];
  let finalPlan: StrategicPlan | null = null;
  if (res.ok) {
    try {
      finalPlan = finalizePlan(res.value, planCtx);
      status = "completed";
      museMeta = { ms: res.ms, usage: res.usage };
    } catch (err) {
      status = "fallback";
      museMeta = { ms: res.ms, usage: res.usage, error: clip(`invalid: post-validation failed — ${(err as Error).message}`, 300) };
    }
  } else {
    status = res.reason === "timeout" ? "timeout" : "fallback";
    museMeta = { ms: res.ms, error: clip(`${res.reason}: ${res.detail}`, 300) };
  }
  trace.push({ tool: "muse.strategic", input: `effort medium, deadline ${deadlineMs} ms, ${evidence.length} evidence item(s)`, output: res.ok && finalPlan ? `${finalPlan.opportunities.length} opportunity(ies)` : museMeta.error ?? "failed", provenance: res.ok ? "live" : "unavailable", ms: res.ms });
  if (!finalPlan) finalPlan = finalizePlan(buildFallbackPlan(planCtx), planCtx);

  return {
    plan: finalPlan,
    meta: {
      status,
      provider: status === "completed" ? `muse:${model ?? "unknown"}` : "deterministic",
      ms: Date.now() - started,
      toolTrace: trace,
      muse: museMeta
    }
  };
}
