import { z } from "zod";
import type { CollectiveIntent, Dietary, Need } from "./types";
import { dietarySchema, needSchema } from "./schemas";
import { parseIntent } from "./intent";

/**
 * Per-car intent: the single authoritative record of what each car's occupants want.
 * Persistent properties (dietary, kids, detour tolerance) survive until changed.
 * Temporary needs carry a timestamp and expire, or clear when a confirmed stop covers them.
 */
export const NEED_TTL_MINUTES = 120;

export interface TimedNeed {
  need: Need;
  sinceElapsed: number;
}

export interface CarIntent {
  carId: string;
  needs: TimedNeed[];
  hungerLevel: 0 | 1 | 2 | 3;
  restroomUrgent: boolean;
  notHungry: boolean;
  dietary: Dietary[];
  kids: boolean;
  maxDetourMinutes: number;
  /** Last few things this car said, newest last (for Agent 1 context; capped). */
  history: string[];
}

export function emptyCarIntent(carId: string, defaults?: Partial<CarIntent>): CarIntent {
  return {
    carId,
    needs: [],
    hungerLevel: 0,
    restroomUrgent: false,
    notHungry: false,
    dietary: [],
    kids: false,
    maxDetourMinutes: 12,
    history: [],
    ...defaults
  };
}

/** Agent 1's structured output for one car. Every field optional = "no change". */
export const intentUpdateSchema = z.object({
  carId: z.string().min(1),
  addNeeds: z.array(needSchema).default([]),
  removeNeeds: z.array(needSchema).default([]),
  hungerLevel: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).nullable().default(null),
  restroomUrgent: z.boolean().nullable().default(null),
  notHungry: z.boolean().nullable().default(null),
  addDietary: z.array(dietarySchema).default([]),
  removeDietary: z.array(dietarySchema).default([]),
  kids: z.boolean().nullable().default(null),
  maxDetourMinutes: z.number().min(0).max(60).nullable().default(null)
});
export type IntentUpdate = z.infer<typeof intentUpdateSchema>;

export const intentAgentOutputSchema = z.object({
  updates: z.array(intentUpdateSchema).max(3),
  understood: z.array(z.string().max(200)).max(6).default([]),
  /** Set when the message is a correction that overrides earlier requests. */
  correction: z.boolean().default(false)
});
export type IntentAgentOutput = z.infer<typeof intentAgentOutputSchema>;

export function applyIntentUpdate(cur: CarIntent, u: IntentUpdate, elapsed: number, utterance?: string): CarIntent {
  const needs = new Map<Need, TimedNeed>(cur.needs.map((n) => [n.need, n]));
  for (const n of u.removeNeeds) needs.delete(n);
  for (const n of u.addNeeds) needs.set(n, { need: n, sinceElapsed: elapsed }); // re-asking refreshes the timestamp
  const dietary = new Set<Dietary>(cur.dietary);
  for (const d of u.removeDietary) dietary.delete(d);
  for (const d of u.addDietary) dietary.add(d);
  let hungerLevel = u.hungerLevel ?? cur.hungerLevel;
  let notHungry = u.notHungry ?? cur.notHungry;
  if (u.hungerLevel != null && u.hungerLevel > 0) notHungry = false;
  if (u.notHungry === true) {
    hungerLevel = 0;
    needs.delete("meal");
  }
  if (u.removeNeeds.includes("meal") && u.hungerLevel == null) hungerLevel = 0;
  const restroomUrgent = u.removeNeeds.includes("restroom") ? false : u.restroomUrgent ?? cur.restroomUrgent;
  return {
    ...cur,
    needs: [...needs.values()],
    hungerLevel,
    notHungry,
    restroomUrgent,
    dietary: [...dietary],
    kids: u.kids ?? cur.kids,
    maxDetourMinutes: u.maxDetourMinutes ?? cur.maxDetourMinutes,
    history: utterance ? [...cur.history, utterance].slice(-5) : cur.history
  };
}

/** Drop temporary needs older than the TTL. Persistent properties are untouched. */
export function expireNeeds(cur: CarIntent, elapsed: number, ttl = NEED_TTL_MINUTES): CarIntent {
  const kept = cur.needs.filter((n) => elapsed - n.sinceElapsed <= ttl);
  if (kept.length === cur.needs.length) return cur;
  return { ...cur, needs: kept, restroomUrgent: kept.some((n) => n.need === "restroom") ? cur.restroomUrgent : false };
}

/** A confirmed stop satisfies the needs it covers. */
export function clearCoveredNeeds(cur: CarIntent, covered: Need[]): CarIntent {
  const left = cur.needs.filter((n) => !covered.includes(n.need));
  const ate = covered.includes("meal");
  return {
    ...cur,
    needs: left,
    hungerLevel: ate ? 0 : cur.hungerLevel,
    restroomUrgent: covered.includes("restroom") ? false : cur.restroomUrgent
  };
}

/** Deterministic fallback for Agent 1 — the existing regex parser, scoped to the speaking car. */
export function regexIntentUpdate(carId: string, text: string): IntentAgentOutput {
  const p = parseIntent(text);
  const urgentRestroom = /(really|urgent|badly|asap|right now|can'?t wait|desperate).{0,20}(washroom|restroom|bathroom|toilet|pee)|(washroom|restroom|bathroom|toilet|pee).{0,20}(urgent|asap|now|badly)/i.test(text);
  const kidsYes = /\b(kids?|children|child|toddler|baby)\b/i.test(text) && !/\bno (kids|children)\b/i.test(text);
  return {
    updates: [
      {
        carId,
        addNeeds: p.needs,
        removeNeeds: p.removeNeeds,
        hungerLevel: p.resetHunger ? 0 : p.hungerLevel > 0 ? p.hungerLevel : null,
        restroomUrgent: urgentRestroom ? true : null,
        notHungry: p.resetHunger && !p.corrected ? true : null,
        addDietary: p.dietary,
        removeDietary: p.clearDietary ? ["vegetarian", "vegan", "halal", "gluten_free"] : [],
        kids: kidsYes ? true : null,
        maxDetourMinutes: null
      }
    ],
    understood: p.explicit ? [`regex parser: needs+[${p.needs.join(",")}] needs-[${p.removeNeeds.join(",")}] diet+[${p.dietary.join(",")}]`] : ["no explicit need detected"],
    correction: p.corrected
  };
}

/** Collapse per-car intents into the collective shape the existing engine API expects. */
export function toCollective(intents: CarIntent[]): CollectiveIntent & { restroomUrgent: boolean } {
  return {
    need: [...new Set(intents.flatMap((i) => i.needs.map((n) => n.need)))],
    hungerLevel: intents.reduce<number>((m, i) => Math.max(m, i.hungerLevel), 0) as 0 | 1 | 2 | 3,
    dietary: [...new Set(intents.flatMap((i) => i.dietary))],
    maxDetourMinutes: intents.length ? Math.min(...intents.map((i) => i.maxDetourMinutes)) : 12,
    kids: intents.some((i) => i.kids),
    restroomUrgent: intents.some((i) => i.restroomUrgent)
  };
}
