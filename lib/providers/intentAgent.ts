import { z } from "zod";
import { intentAgentOutputSchema, regexIntentUpdate, type IntentAgentOutput } from "@/lib/domain/carIntent";
import { callMuseStructured, museModelName } from "@/lib/agent2/museStructured";

/**
 * Agent 1 — Intent & Conversation.
 * One bounded Muse call per utterance with native structured output (strict json_schema,
 * effort "minimal", hard deadline INTENT_DEADLINE_MS, default 8000 ms). It interprets a driver
 * voice transcript or a copassenger's text into a context PATCH (per-car intent updates), never a
 * full state rewrite. Output is Zod-validated; unknown car ids are dropped; the deterministic regex
 * parser is the fallback when Muse is disabled or the call fails for any reason.
 */
export const intentRequestSchema = z.object({
  carId: z.string().min(1),
  source: z.enum(["driver_voice", "copassenger_text"]),
  text: z.string().min(1).max(500),
  localTime: z.string().regex(/^\d{2}:\d{2}$/),
  cars: z.array(z.object({ id: z.string(), label: z.string() })).min(1).max(3),
  /** Current authoritative per-car state (compact), so corrections can be resolved. */
  current: z.record(
    z.object({
      needs: z.array(z.string()),
      hungerLevel: z.number(),
      restroomUrgent: z.boolean(),
      notHungry: z.boolean(),
      dietary: z.array(z.string()),
      kids: z.boolean(),
      history: z.array(z.string()).max(5)
    })
  )
});
export type IntentRequest = z.infer<typeof intentRequestSchema>;

export interface IntentAgentResult extends IntentAgentOutput {
  provider: string;
  isMock: boolean;
  fallbackReason?: string;
}

const NEEDS = ["meal", "coffee", "restroom", "ev_charge", "grocery"] as const;
const DIETARY = ["vegetarian", "vegan", "halal", "gluten_free"] as const;

/**
 * Strict JSON schema mirroring intentAgentOutputSchema. Strict json_schema requires every property
 * in `required` and additionalProperties:false at every object level; "no change" is expressed by
 * null (nullable fields) or [] (arrays). Zod remains the authority after the call.
 */
export const INTENT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["updates", "understood", "correction"],
  properties: {
    updates: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "carId",
          "addNeeds",
          "removeNeeds",
          "hungerLevel",
          "restroomUrgent",
          "notHungry",
          "addDietary",
          "removeDietary",
          "kids",
          "maxDetourMinutes"
        ],
        properties: {
          carId: { type: "string" },
          addNeeds: { type: "array", items: { type: "string", enum: [...NEEDS] } },
          removeNeeds: { type: "array", items: { type: "string", enum: [...NEEDS] } },
          hungerLevel: { type: ["integer", "null"], enum: [0, 1, 2, 3, null] },
          restroomUrgent: { type: ["boolean", "null"] },
          notHungry: { type: ["boolean", "null"] },
          addDietary: { type: "array", items: { type: "string", enum: [...DIETARY] } },
          removeDietary: { type: "array", items: { type: "string", enum: [...DIETARY] } },
          kids: { type: ["boolean", "null"] },
          maxDetourMinutes: { type: ["number", "null"], minimum: 0, maximum: 60 }
        }
      }
    },
    understood: { type: "array", maxItems: 6, items: { type: "string", maxLength: 200 } },
    correction: { type: "boolean" }
  }
};

const SYSTEM = [
  "You are Agent 1 (Intent) of Uncongest, a road-trip stop assistant. Output a PATCH of per-car intent changes, never the full state. Do not recommend places.",
  "Answer: What did the participant add, change or retract? Which car does it affect? What is the urgency?",
  "Car: the speaker's car unless the message clearly names another car or says everyone/all cars (then one update per car). Use only ids from `cars`.",
  "Needs: meal, coffee, restroom, ev_charge, grocery. hungerLevel 0-3 (3 = starving).",
  "Corrections: 'actually no coffee' -> removeNeeds [coffee], correction true; 'we already ate' -> notHungry true, removeNeeds [meal]; 'scratch that' -> remove what the speaker previously asked (see history).",
  "restroomUrgent true only for clearly urgent restroom needs. kids true only if children are mentioned as present.",
  "Dietary (vegetarian, vegan, halal, gluten_free) are persistent preferences for that car (vegetarian = veg-friendly is fine); add/remove only when the message says so.",
  "Voice transcripts may be noisy: be conservative. Unchanged fields: null or []. understood: short plain-English summary."
].join("\n");

function deadlineMs(): number {
  const n = Number(process.env.INTENT_DEADLINE_MS);
  return Number.isFinite(n) && n > 0 ? n : 8000;
}

export async function interpretIntent(req: IntentRequest): Promise<IntentAgentResult> {
  const validIds = new Set(req.cars.map((c) => c.id));
  const model = museModelName();
  if (!model) {
    return { ...regexIntentUpdate(req.carId, req.text), provider: "regex-parser", isMock: true };
  }
  const res = await callMuseStructured<IntentAgentOutput>({
    system: SYSTEM,
    user: JSON.stringify({
      speakerCarId: req.carId,
      source: req.source,
      message: req.text,
      localTime: req.localTime,
      cars: req.cars,
      currentState: req.current
    }),
    schemaName: "intent_patch",
    jsonSchema: INTENT_JSON_SCHEMA,
    zod: intentAgentOutputSchema,
    effort: "minimal",
    deadlineMs: deadlineMs(),
    maxOutputTokens: 1500
  });
  if (!res.ok) {
    if (res.reason === "disabled") {
      return { ...regexIntentUpdate(req.carId, req.text), provider: "regex-parser", isMock: true };
    }
    const reason = `${res.reason}: ${res.detail}`;
    console.warn(`[ai:intent] ${model} failed (${reason}); regex fallback used`);
    return { ...regexIntentUpdate(req.carId, req.text), provider: `${model} failed; regex fallback`, isMock: true, fallbackReason: reason };
  }
  const out = res.value;
  const updates = out.updates.filter((u) => validIds.has(u.carId));
  const dropped = out.updates.length - updates.length;
  console.info(`[ai:intent] muse:${model} ${res.ms}ms updates=${updates.length} dropped=${dropped}`);
  return {
    ...out,
    updates,
    understood: dropped > 0 ? [...out.understood, `dropped ${dropped} update(s) for unknown car ids`] : out.understood,
    provider: `muse:${model} intent`,
    isMock: false
  };
}
