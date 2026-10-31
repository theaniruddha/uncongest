import { llmDecisionSchema, type LlmDecision } from "@/lib/domain/schemas";
import type { EligibleStop, RejectionReason, TripConfig, TripContext, Environment, CollectiveIntent, CarState } from "@/lib/domain/types";

export interface DecisionContext {
  trip: TripContext;
  config: TripConfig;
  cars: CarState[];
  intent: CollectiveIntent;
  environment: Environment;
  eligible: EligibleStop[];
  rejected: RejectionReason[];
  triggerReasons: string[];
}

export interface AiProvider {
  name: string;
  isMock: boolean;
  decide(ctx: DecisionContext): Promise<LlmDecision>;
}

function mockDecide(ctx: DecisionContext): LlmDecision {
  if (ctx.eligible.length === 0) {
    return { action: "STAY_SILENT", picks: [] };
  }
  const picks = ctx.eligible.slice(0, 3).map((e, i) => ({
    stopId: e.stop.id,
    kind: (i === 0 ? "BEST_FIT" : i === 1 ? "FASTEST" : "ALTERNATIVE") as "BEST_FIT" | "FASTEST" | "ALTERNATIVE",
    reason: `${e.stop.name} is the strongest match: ${(e.score * 100).toFixed(0)}% composite fit, max detour ${Math.max(...Object.values(e.detourMinutesByCar)).toFixed(0)} min per car, verified ${[
      e.stop.vegetarianVerified === true ? "vegetarian" : null,
      e.stop.restroomsVerified === true ? "restrooms" : null,
      e.stop.chargers?.length ? "EV chargers" : null
    ].filter(Boolean).join(", ") || "basics"}.`,
    tradeoffs: [
      `Group regroup wait up to ${e.maxGroupWaitMinutes.toFixed(0)} min`,
      e.stop.qualityScoreMock < 0.6 ? "Quality is only fair (mock score); shown with caveat" : "Higher mock quality than alternatives"
    ]
  }));
  return {
    action: "PROPOSE_STOP",
    picks,
    speakMessage: `Uncongest suggests ${ctx.eligible[0].stop.name}. ${ctx.eligible[0].stop.name} is about ${Math.max(...Object.values(ctx.eligible[0].detourMinutesByCar)).toFixed(0)} extra minutes of driving at most.`
  };
}

export class MockAiProvider implements AiProvider {
  name = "mock";
  isMock = true;
  async decide(ctx: DecisionContext): Promise<LlmDecision> {
    return mockDecide(ctx);
  }
}

export class MistralAiProvider implements AiProvider {
  name = "mistral";
  isMock = false;
  constructor(private apiKey: string, private model: string) {}
  async decide(ctx: DecisionContext): Promise<LlmDecision> {
    const eligibleSummary = ctx.eligible.map((e) => ({
      stopId: e.stop.id,
      name: e.stop.name,
      score: e.score,
      maxDetourMinutes: Math.max(...Object.values(e.detourMinutesByCar)),
      maxGroupWaitMinutes: e.maxGroupWaitMinutes,
      categories: e.stop.categories,
      qualityScoreMock: e.stop.qualityScoreMock
    }));
    const body = {
      model: this.model || "mistral-small-latest",
      messages: [
        {
          role: "system",
          content:
            "You are Uncongest's stop-decision assistant. Choose only stopIds from eligible stops, or STAY_SILENT. Never invent places, times, ratings or speeds. Return JSON only: {action, picks:[{stopId, kind?, reason, tradeoffs}], speakMessage?}."
        },
        {
          role: "user",
          content: JSON.stringify({
            triggers: ctx.triggerReasons,
            intent: ctx.intent,
            environment: ctx.environment,
            eligible: eligibleSummary,
            rejected: ctx.rejected
          })
        }
      ],
      response_format: { type: "json_object" },
      temperature: 0.2
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch("https://api.mistral.ai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (!res.ok) throw new Error(`mistral http ${res.status}`);
      const json = await res.json();
      const content = json?.choices?.[0]?.message?.content ?? "{}";
      const parsed = llmDecisionSchema.safeParse(JSON.parse(content));
      if (!parsed.success) throw new Error("schema validation failed");
      return parsed.data;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function getAiProvider(): AiProvider {
  const provider = (process.env.AI_PROVIDER ?? "mock").toLowerCase();
  if (provider === "mistral" && process.env.MISTRAL_API_KEY) {
    return new MistralAiProvider(process.env.MISTRAL_API_KEY, process.env.AI_MODEL ?? "");
  }
  return new MockAiProvider();
}
