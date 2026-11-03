import { z } from "zod";
import { intentAgentOutputSchema, regexIntentUpdate, type IntentAgentOutput } from "@/lib/domain/carIntent";
import { extractJson, getLlmClient } from "./ai";

/**
 * Agent 1 — Intent & Conversation.
 * One bounded LLM call per utterance: interprets a driver voice transcript or a copassenger's
 * text into structured per-car intent updates (needs, hunger, restroom urgency, diet, kids,
 * corrections). Output is Zod-validated; unknown car ids are dropped; the deterministic regex
 * parser is the fallback when no model is configured or the call fails.
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

const SYSTEM = [
  "You are Agent 1 (Intent & Conversation) of Uncongest, a road-trip stop assistant.",
  "Convert ONE message from a car occupant into structured intent updates. Do not recommend places.",
  "Needs: meal, coffee, restroom, ev_charge, grocery. Dietary: vegetarian, vegan, halal, gluten_free. hungerLevel 0–3 (3 = starving/very hungry).",
  "The message applies to the speaker's car unless it clearly names another car or says everyone/all cars.",
  "Handle corrections: 'actually no coffee' → removeNeeds [coffee]; 'we already ate' → notHungry true, removeNeeds [meal]; 'scratch that' → remove what the speaker previously asked (see history).",
  "Driver voice transcripts may be terse or noisy; prefer conservative interpretation. Only set fields that the message changes; use null / [] for no change.",
  "Dietary values are persistent preferences for that car (vegetarian = veg-friendly is fine, not veg-only); only add/remove them when the message says so.",
  "restroomUrgent true only for clearly urgent restroom needs. kids true only if children are mentioned as present.",
  'Return JSON only: {"updates":[{"carId","addNeeds":[],"removeNeeds":[],"hungerLevel":null,"restroomUrgent":null,"notHungry":null,"addDietary":[],"removeDietary":[],"kids":null,"maxDetourMinutes":null}],"understood":["short plain-English summary"],"correction":false}'
].join(" ");

export async function interpretIntent(req: IntentRequest): Promise<IntentAgentResult> {
  const validIds = new Set(req.cars.map((c) => c.id));
  const client = getLlmClient("intent");
  if (!client) {
    return { ...regexIntentUpdate(req.carId, req.text), provider: "regex-parser", isMock: true };
  }
  try {
    const { text } = await client.complete(
      SYSTEM,
      JSON.stringify({
        speakerCarId: req.carId,
        source: req.source,
        message: req.text,
        localTime: req.localTime,
        cars: req.cars,
        currentState: req.current
      })
    );
    const parsed = intentAgentOutputSchema.safeParse(extractJson(text));
    if (!parsed.success) {
      throw new Error(`schema validation failed: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    }
    const updates = parsed.data.updates.filter((u) => validIds.has(u.carId));
    const dropped = parsed.data.updates.length - updates.length;
    return {
      ...parsed.data,
      updates,
      understood: dropped > 0 ? [...parsed.data.understood, `dropped ${dropped} update(s) for unknown car ids`] : parsed.data.understood,
      provider: client.name,
      isMock: false
    };
  } catch (err) {
    const reason = (err as Error).message;
    console.warn(`[ai:intent] ${client.name} failed (${reason}); regex fallback used`);
    return { ...regexIntentUpdate(req.carId, req.text), provider: `${client.name} failed; regex fallback`, isMock: true, fallbackReason: reason };
  }
}
