import { z } from "zod";

/**
 * Agent 2 · Strategic Planner output: a provisional, versioned plan of FUTURE stop opportunities.
 * Not a command — the Tactical workflow decides what to recommend now.
 */
export const opportunityKindSchema = z.enum(["meal", "coffee", "restroom", "rest_break", "fuel_or_charge", "groceries", "route_choice", "limited_service_stretch", "arrival"]);

export const strategicOpportunitySchema = z.object({
  id: z.string().min(1).max(80),
  kind: opportunityKindSchema,
  title: z.string().min(1).max(120),
  /** Route segment (km along the CURRENT route) where this applies. */
  fromKm: z.number().min(0),
  toKm: z.number().min(0),
  /** Local time window (HH:mm) when the lead car is expected in the segment, if known. */
  expectedLocalFrom: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  expectedLocalTo: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  /** Real candidate ids from the place tools (never invented); may be empty. */
  candidateIds: z.array(z.string()).max(8).default([]),
  reason: z.string().min(1).max(300),
  /** Ids of evidence items in `evidence` that support this opportunity. */
  evidenceRefs: z.array(z.string()).max(10).default([]),
  priority: z.enum(["high", "medium", "low"]),
  confidence: z.number().min(0).max(1),
  /** What the Tactical workflow should watch for. */
  watchFor: z.string().max(200).optional()
});
export type StrategicOpportunity = z.infer<typeof strategicOpportunitySchema>;

export const strategicEvidenceSchema = z.object({
  id: z.string().min(1).max(40),
  tool: z.string().min(1).max(60),
  summary: z.string().min(1).max(300),
  provenance: z.enum(["live", "cached", "recorded", "simulated", "unavailable"])
});
export type StrategicEvidence = z.infer<typeof strategicEvidenceSchema>;

export const strategicPlanSchema = z.object({
  /** Must equal the request's routeVersion/contextVersion, otherwise the plan is stale. */
  routeVersion: z.string().min(1),
  contextVersion: z.string().min(1),
  createdAtElapsed: z.number().min(0),
  summary: z.string().max(400),
  opportunities: z.array(strategicOpportunitySchema).max(10),
  routeDecisions: z
    .array(
      z.object({
        id: z.string(),
        title: z.string().max(140),
        atKm: z.number().min(0),
        detail: z.string().max(300),
        alternativeRouteId: z.string().optional(),
        deltaMinutes: z.number().optional()
      })
    )
    .max(5)
    .default([]),
  evidence: z.array(strategicEvidenceSchema).max(30),
  replanTriggers: z.array(z.string().max(160)).max(8),
  /** The plan is invalid after the lead passes this km or after this elapsed minute. */
  expiresAtKm: z.number().min(0).optional(),
  expiresAtElapsed: z.number().min(0).optional(),
  uncertainty: z.string().max(240).optional()
});
export type StrategicPlan = z.infer<typeof strategicPlanSchema>;

export interface StrategicRunMeta {
  status: "completed" | "fallback" | "timeout" | "error" | "cached" | "stale";
  provider: string;
  ms: number;
  toolTrace: Array<{ tool: string; input: string; output: string; provenance?: string; ms?: number }>;
  muse?: { ms: number; usage?: unknown; error?: string };
}

export interface StrategicResponse {
  plan: StrategicPlan;
  meta: StrategicRunMeta;
}
