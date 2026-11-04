import { z } from "zod";
import type { LlmDecision } from "@/lib/domain/schemas";
import type { DecisionContext } from "@/lib/providers/ai";
import { callMuseStructured } from "./museStructured";

/**
 * Agent 2 · Tactical Decision-Maker.
 * Answers "Given the current needs, reachable candidates and strategic hints, what should Uncongest
 * recommend now?" with a strict structured decision, inside a hard deadline (default 5 s).
 * Candidates are already deterministically validated; the engine re-validates every id afterwards.
 */
export const TACTICAL_DECISIONS = ["RECOMMEND", "SEARCH_FARTHER", "STAY_SILENT", "NO_SUITABLE_STOP", "REPLAN"] as const;
export type TacticalDecisionKind = (typeof TACTICAL_DECISIONS)[number];

export const tacticalDecisionSchema = z.object({
  decision: z.enum(TACTICAL_DECISIONS),
  picks: z
    .array(
      z.object({
        stopId: z.string().min(1),
        reason: z.string().min(1).max(220),
        tradeoffs: z.array(z.string().max(110)).max(3)
      })
    )
    .max(3),
  headline: z.string().max(160),
  evidenceRefs: z.array(z.string().max(40)).max(8)
});
export type TacticalDecision = z.infer<typeof tacticalDecisionSchema>;

export const TACTICAL_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["decision", "picks", "headline", "evidenceRefs"],
  properties: {
    decision: { type: "string", enum: [...TACTICAL_DECISIONS] },
    picks: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["stopId", "reason", "tradeoffs"],
        properties: {
          stopId: { type: "string" },
          reason: { type: "string" },
          tradeoffs: { type: "array", maxItems: 3, items: { type: "string" } }
        }
      }
    },
    headline: { type: "string" },
    evidenceRefs: { type: "array", maxItems: 8, items: { type: "string" } }
  }
} as const;

export interface StrategicHint {
  id: string;
  kind: string;
  title: string;
  fromKm: number;
  toKm: number;
  candidateIds: string[];
  priority: string;
  watchFor?: string;
}

export interface TacticalMeta {
  status: "muse" | "overridden" | "fallback" | "timeout" | "invalid" | "disabled" | "error";
  provider: string;
  ms: number;
  detail?: string;
  decision?: TacticalDecisionKind;
  headline?: string;
}

const SYSTEM =
  "You are Uncongest's Tactical Decision-Maker for a road trip. Question: given the current needs, the reachable candidates and the strategic hints, what should we recommend NOW? " +
  "Pick only stopIds from `candidates` (already safety-checked). RECOMMEND 1–3 when a stop is warranted; STAY_SILENT if no need justifies interrupting; SEARCH_FARTHER if needs are real but the candidates are poor and better ones are likely just beyond; NO_SUITABLE_STOP if nothing fits; REPLAN if the situation changed so much that strategy must be revisited. " +
  "Prefer one place that covers several needs (e.g. coffee + quick bite). A restroom-only need does not require a restaurant. Respect urgency (high → nearest suitable). Evidence levels: verified > possible > unknown; never claim unverified facts. " +
  "Keep reasons short and user-facing (≤ 25 words). No speed or driving instructions.";

/** Compact, question-focused prompt payload (much smaller than the strategic one). */
export function tacticalUserPayload(ctx: DecisionContext & { strategicHints?: StrategicHint[] }): string {
  const lead = ctx.cars.find((c) => c.role === "lead") ?? ctx.cars[0];
  return JSON.stringify({
    now: ctx.trip.localTime,
    urgency: ctx.urgency ? { level: ctx.urgency.level, reasons: ctx.urgency.reasons.slice(0, 4), needs: ctx.urgency.needs } : null,
    preferences: ctx.preferences ?? null,
    diet: ctx.intent.dietary,
    kids: ctx.intent.kids,
    lastMealMinutesAgo: ctx.trip.lastMealMinutesAgo ?? "unknown",
    drivingMinutesSinceRest: ctx.trip.minutesSinceLastStop ?? null,
    trip: ctx.tripContext ?? null,
    candidates: ctx.eligible.slice(0, 8).map((e) => ({
      id: e.stop.id,
      name: e.stop.name,
      brand: e.stop.brand,
      kmAhead: Math.round(e.stop.distanceAlongRouteKm - lead.progressKm),
      minToExit: Math.round(e.minutesAheadForLead),
      detourMin: Math.round(Math.max(...Object.values(e.detourMinutesByCar))),
      serves: e.stop.categories,
      service: e.stop.evidence?.service,
      restroom: e.stop.evidence?.restroom?.level ?? (e.stop.restroomsVerified ? "verified" : "unknown"),
      vegetarian: e.stop.evidence?.vegetarian?.level ?? e.stop.vegOptions ?? "unknown",
      hours: e.stop.open24h ? "24h" : e.stop.hoursVerified ? `${e.stop.opensLocal}-${e.stop.closesLocal}` : "unverified",
      weatherAtArrival: ctx.weatherAtArrival?.[e.stop.id]?.description ?? null,
      score: Math.round(e.score * 100) / 100,
      source: e.stop.isMock ? "fictional demo" : e.stop.source ?? "osm"
    })),
    strategicHints: (ctx.strategicHints ?? []).slice(0, 4),
    notes: (ctx.exploration ?? []).filter((x) => /limited|gap|no further|beyond the horizon/.test(x)).slice(0, 3)
  });
}

export function toLlmDecision(d: TacticalDecision): LlmDecision {
  const action = d.decision === "RECOMMEND" ? "PROPOSE_STOP" : d.decision === "REPLAN" ? "REPLAN" : "STAY_SILENT";
  return {
    action,
    picks: d.decision === "RECOMMEND" ? d.picks.map((p, i) => ({ stopId: p.stopId, kind: i === 0 ? "BEST_FIT" : i === 1 ? "FASTEST" : "ALTERNATIVE", reason: p.reason, tradeoffs: p.tradeoffs })) : [],
    speakMessage: d.headline || undefined
  };
}

/**
 * Did the engine actually act on Muse's decision? Muse's choice is overridden when the engine's action differs
 * (e.g. SEARCH_FARTHER/STAY_SILENT ignored above low urgency) or when none of its RECOMMEND picks survived validation.
 */
export function reconcileTactical(
  d: TacticalDecision,
  result: { action: string; recommendations: Array<{ stopId: string }> }
): { overridden: false } | { overridden: true; detail: string; decision?: TacticalDecisionKind } {
  const llmAction = toLlmDecision(d).action;
  const pickIds = d.decision === "RECOMMEND" ? d.picks.map((p) => p.stopId) : [];
  const picksDropped = pickIds.length > 0 && !result.recommendations.some((r) => pickIds.includes(r.stopId));
  if (result.action === llmAction && !picksDropped) return { overridden: false };
  const decision: TacticalDecisionKind | undefined =
    result.action === "PROPOSE_STOP" ? "RECOMMEND" : result.action === "REPLAN" ? "REPLAN" : result.action === "STAY_SILENT" ? "STAY_SILENT" : undefined;
  const detail =
    result.action !== llmAction
      ? `Muse chose ${d.decision}, but urgency requires a stop now — deterministic ranking used`
      : `Muse's picks (${pickIds.join(", ")}) failed validation — deterministic ranking used`;
  return { overridden: true, detail, decision };
}

export async function runTactical(
  ctx: DecisionContext & { strategicHints?: StrategicHint[] },
  deps: { muse?: typeof callMuseStructured; deadlineMs?: number } = {}
): Promise<{ decision: TacticalDecision | null; llm: LlmDecision | null; meta: TacticalMeta }> {
  const deadlineMs = deps.deadlineMs ?? Number(process.env.TACTICAL_DEADLINE_MS ?? 5000);
  const muse = deps.muse ?? callMuseStructured;
  if (ctx.eligible.length === 0) {
    return { decision: null, llm: null, meta: { status: "fallback", provider: "deterministic", ms: 0, detail: "no validated candidates — nothing for the model to choose from" } };
  }
  const r = await muse({
    system: SYSTEM,
    user: tacticalUserPayload(ctx),
    schemaName: "tactical_decision",
    jsonSchema: TACTICAL_JSON_SCHEMA as unknown as Record<string, unknown>,
    zod: tacticalDecisionSchema,
    // "minimal" measured ≈ 2.5 s vs ≈ 6 s for "low" on this prompt (muse-spark-1.3); keeps Tactical inside 5 s.
    effort: (process.env.TACTICAL_EFFORT as "minimal" | "low" | "medium" | "high") || "minimal",
    deadlineMs,
    maxOutputTokens: 2000
  });
  if (!r.ok) {
    const status: TacticalMeta["status"] = r.reason === "timeout" ? "timeout" : r.reason === "invalid" ? "invalid" : r.reason === "disabled" ? "disabled" : "error";
    return { decision: null, llm: null, meta: { status, provider: "deterministic fallback", ms: r.ms, detail: `${r.reason}: ${r.detail}` } };
  }
  return { decision: r.value, llm: toLlmDecision(r.value), meta: { status: "muse", provider: "muse tactical", ms: r.ms, decision: r.value.decision, headline: r.value.headline } };
}
