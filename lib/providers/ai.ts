import { getRuntimeMode } from "@/lib/runtimeMode";
import { museApiKey, safeLlmError, takeLlmRateSlot } from "@/lib/agent2/llmSafety";
import { llmDecisionSchema, type LlmDecision } from "@/lib/domain/schemas";
import type {
  CarState,
  CollectiveIntent,
  EligibleStop,
  Environment,
  RejectionReason,
  TripConfig,
  TripContext,
  WeatherSnapshot
} from "@/lib/domain/types";
import type { UrgencyResult } from "@/lib/domain/urgency";

/* ------------------------------------------------------------------------------------------
 * Shared LLM client (server-only). Both agents use it; each call is a single bounded request:
 * no tool loops, a timeout, a token cap, and a process-wide rate limit.
 * ---------------------------------------------------------------------------------------- */

export type AgentName = "intent" | "decision";

export interface LlmCallResult {
  text: string;
  usage: unknown;
  ms: number;
}

export interface LlmClient {
  name: string;
  complete(system: string, user: string): Promise<LlmCallResult>;
}

export function extractJson(content: string): unknown {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const first = trimmed.indexOf("{");
    const last = trimmed.lastIndexOf("}");
    if (first >= 0 && last > first) return JSON.parse(trimmed.slice(first, last + 1));
    throw new Error("model returned non-JSON content");
  }
}

interface MetaClientConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  topP: number;
  maxOutputTokens: number;
  reasoningEffort: string;
  timeoutMs: number;
  agent: AgentName;
}

/**
 * Meta Model API, Responses endpoint (POST {base}/responses) with SSE streaming — the format
 * from Meta's documentation. Text deltas are accumulated server-side.
 */
export class MetaResponsesClient implements LlmClient {
  name: string;
  constructor(private cfg: MetaClientConfig) {
    this.name = `meta:${cfg.model}`;
  }
  async complete(system: string, user: string): Promise<LlmCallResult> {
    if (!takeLlmRateSlot()) throw new Error("LLM rate limit reached (LLM_MAX_CALLS_PER_10_MIN)");
    const payload = {
      model: this.cfg.model,
      input: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      stream: true,
      temperature: this.cfg.temperature,
      max_output_tokens: this.cfg.maxOutputTokens,
      top_p: this.cfg.topP,
      reasoning: { effort: this.cfg.reasoningEffort }
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    const started = Date.now();
    try {
      const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, "")}/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.cfg.apiKey}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream"
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      if (!res.ok || !res.body) {
        await res.body?.cancel();
        throw new Error(`meta http ${res.status}`);
      }
      const { text, usage, status } = await readResponsesStream(res.body);
      const ms = Date.now() - started;
      console.info(`[ai:${this.cfg.agent}] ${this.name} effort=${this.cfg.reasoningEffort} ${ms}ms status=${status} usage=${JSON.stringify(usage)}`);
      if (!text.trim()) throw new Error(`meta returned no output text (status ${status})`);
      return { text, usage, ms };
    } catch (err) {
      if ((err as Error).name === "AbortError") throw new Error(`meta timeout after ${this.cfg.timeoutMs} ms`);
      throw new Error(safeLlmError(err));
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function readResponsesStream(body: ReadableStream<Uint8Array>): Promise<{ text: string; usage: unknown; status: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let deltas = "";
  let finalText = "";
  let usage: unknown = null;
  let status = "unknown";
  const handle = (data: string) => {
    if (!data || data === "[DONE]") return;
    let evt: any;
    try {
      evt = JSON.parse(data);
    } catch {
      return;
    }
    const type: string = evt?.type ?? "";
    if (type === "response.output_text.delta" && typeof evt.delta === "string") {
      deltas += evt.delta;
    } else if (type === "error" || type === "response.failed") {
      throw new Error("meta stream error");
    } else if (type === "response.completed" || type === "response.incomplete") {
      const r = evt.response ?? {};
      status = r.status ?? type;
      usage = r.usage ?? null;
      finalText = (r.output ?? [])
        .filter((o: any) => o?.type === "message")
        .flatMap((o: any) => o.content ?? [])
        .filter((c: any) => c?.type === "output_text")
        .map((c: any) => c.text)
        .join("");
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      if (line.startsWith("data: ")) handle(line.slice(6));
    }
  }
  if (buffer.startsWith("data: ")) handle(buffer.slice(6).trim());
  return { text: finalText || deltas, usage, status };
}

/** OpenAI-compatible chat completions (used for Mistral). */
export class ChatCompletionsClient implements LlmClient {
  constructor(public name: string, private baseUrl: string, private apiKey: string, private model: string, private timeoutMs: number, private agent: AgentName) {}
  async complete(system: string, user: string): Promise<LlmCallResult> {
    if (!takeLlmRateSlot()) throw new Error("LLM rate limit reached (LLM_MAX_CALLS_PER_10_MIN)");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const started = Date.now();
    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user }
          ],
          response_format: { type: "json_object" },
          temperature: 0.2
        }),
        signal: controller.signal
      });
      if (!res.ok) throw new Error(`${this.name} http ${res.status}`);
      const json = await res.json();
      const ms = Date.now() - started;
      console.info(`[ai:${this.agent}] ${this.name} ${ms}ms usage=${JSON.stringify(json?.usage ?? null)}`);
      return { text: json?.choices?.[0]?.message?.content ?? "", usage: json?.usage ?? null, ms };
    } finally {
      clearTimeout(timeout);
    }
  }
}

function num(v: string | undefined, d: number): number {
  return v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d;
}

/** Returns a live client for the given agent, or null in mock mode / without a key. */
export function getLlmClient(agent: AgentName): LlmClient | null {
  if (getRuntimeMode() === "demo") return null;
  const provider = (process.env.AI_PROVIDER ?? "meta").toLowerCase();
  if (provider === "meta") {
    const apiKey = museApiKey();
    if (!apiKey) return null;
    const effortDefault = agent === "intent" ? "low" : process.env.META_REASONING_EFFORT || "medium";
    return new MetaResponsesClient({
      agent,
      baseUrl: process.env.META_API_BASE || "https://api.meta.ai/v1",
      apiKey,
      model: process.env.AI_MODEL || "muse-spark-1.3",
      temperature: num(process.env.META_TEMPERATURE, 1),
      topP: num(process.env.META_TOP_P, 1),
      maxOutputTokens: num(process.env.META_MAX_OUTPUT_TOKENS, 32000),
      reasoningEffort: (agent === "intent" ? process.env.META_INTENT_REASONING_EFFORT : process.env.META_DECISION_REASONING_EFFORT) || effortDefault,
      timeoutMs: num(process.env.META_TIMEOUT_MS, agent === "intent" ? 45000 : 90000)
    });
  }
  if (provider === "mistral" && process.env.MISTRAL_API_KEY) {
    return new ChatCompletionsClient("mistral", "https://api.mistral.ai/v1", process.env.MISTRAL_API_KEY, process.env.AI_MODEL || "mistral-small-latest", 15000, agent);
  }
  return null;
}

/* ------------------------------------------------------------------------------------------
 * Agent 2 — Exploration & Decision (LLM ranking over deterministically validated candidates)
 * ---------------------------------------------------------------------------------------- */

export interface DecisionContext {
  trip: TripContext;
  config: TripConfig;
  cars: CarState[];
  intent: CollectiveIntent;
  environment: Environment;
  eligible: EligibleStop[];
  rejected: RejectionReason[];
  triggerReasons: string[];
  urgency?: UrgencyResult;
  exploration?: string[];
  weatherAtArrival?: Record<string, WeatherSnapshot>;
  weatherAtCars?: WeatherSnapshot[];
  /** Relevance-filtered trip context (destination, daylight, history) from lib/context/builder.ts. */
  tripContext?: Record<string, unknown>;
  preferences?: { mood: string[]; mealPreference: string; customMeal?: string };
}

export interface AiProvider {
  name: string;
  isMock: boolean;
  decide(ctx: DecisionContext): Promise<LlmDecision>;
}

export const DECISION_SYSTEM_PROMPT = [
  "You are Agent 2 (Exploration & Decision) of Uncongest, a proactive road-trip stop assistant.",
  "Every candidate in `eligible` already passed deterministic safety checks (reachability, exit notice time, detour cap, dietary rules, hours).",
  "Choose 1–3 stopIds ONLY from `eligible`, or STAY_SILENT if interrupting isn't worth it (allowed only at low urgency).",
  "Use urgency: high → nearest suitable; moderate → compare the next 1–2 exits; low → a better stop or better weather farther ahead may win.",
  "Consider weatherAtArrival, minutesToExit, detour, group wait, unmet needs, children, and the `exploration` notes (e.g. limited facilities ahead).",
  "Real places come from OpenStreetMap: a gas station, Tim Hortons, Walmart, service plaza, Subway or restaurant can each be right depending on needs and urgency; respect mealPreference (quick_bite vs proper_meal vs coffee). Use tripContext (destination arrival, daylight, home/hotel) only as given.",
  "Vegetarian/vegan is a preference meaning veg-friendly: chains like sandwich shops and plaza food courts (vegOptions \"some\") are acceptable; prefer \"good\"/\"dedicated\" when the trade-off is small. Halal/gluten-free are strict and already enforced.",
  "Never invent places, ratings, wait times, or speeds; never advise speeding, slowing, or sudden lane changes. Fixture businesses are fictional — don't claim otherwise.",
  "Return JSON only, no markdown: {\"action\": \"STAY_SILENT\"|\"PROPOSE_STOP\"|\"ESCALATE_TO_PASSENGER\", \"picks\": [{\"stopId\", \"kind\": \"FASTEST\"|\"BEST_FIT\"|\"ALTERNATIVE\", \"reason\" (≤ 300 chars, mention exit and timing), \"tradeoffs\": [≤ 4 short strings]}], \"speakMessage\" (≤ 140 chars, calm, for the driver)}."
].join(" ");

export function buildDecisionPayload(ctx: DecisionContext): string {
  const lead = ctx.cars.find((c) => c.role === "lead") ?? ctx.cars[0];
  return JSON.stringify({
    localTime: ctx.trip.localTime,
    elapsedMinutes: ctx.trip.elapsedMinutes,
    minutesSinceLastStop: ctx.trip.minutesSinceLastStop ?? null,
    lastMealMinutesAgo: ctx.trip.lastMealMinutesAgo ?? "unknown",
    urgency: ctx.urgency ?? null,
    triggers: ctx.triggerReasons,
    intent: ctx.intent,
    cars: ctx.cars.map((c) => ({ id: c.id, role: c.role, progressKm: c.progressKm, speedKph: c.speedKph, kids: c.kids, needs: c.needs, ev: c.ev, batteryPercent: c.batteryPercent })),
    weatherAtCars: ctx.weatherAtCars ?? [],
    eligible: ctx.eligible.map((e) => ({
      stopId: e.stop.id,
      name: e.stop.name,
      exit: e.stop.exitLabel ?? e.stop.exitId,
      dataSource: e.stop.isMock ? "fictional demo fixture" : `real place (${e.stop.source ?? "osm"}), menu/hours ${e.stop.hoursVerified ? "hours verified" : "hours unverified"}`,
      brand: e.stop.brand,
      kmAheadOfLead: Math.round(e.stop.distanceAlongRouteKm - lead.progressKm),
      minutesToExit: Math.round(e.minutesAheadForLead),
      maxDetourMinutes: Math.round(Math.max(...Object.values(e.detourMinutesByCar))),
      maxGroupWaitMinutes: Math.round(e.maxGroupWaitMinutes),
      categories: e.stop.categories,
      tier: e.tier,
      score: Math.round(e.score * 100) / 100,
      qualityScoreMock: e.stop.qualityScoreMock,
      vegOptions: e.stop.categories.includes("meal") ? e.stop.vegOptions ?? "unknown" : undefined,
      weatherAtArrival: ctx.weatherAtArrival?.[e.stop.id]
        ? (({ description, tempC, precipProbability, source }) => ({ description, tempC, precipProbability, source }))(ctx.weatherAtArrival[e.stop.id])
        : null
    })),
    exploration: ctx.exploration ?? [],
    rejectedCount: ctx.rejected.length,
    preferences: ctx.preferences,
    tripContext: ctx.tripContext
  });
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

export class LlmDecisionProvider implements AiProvider {
  isMock = false;
  constructor(private client: LlmClient) {}
  get name() {
    return this.client.name;
  }
  async decide(ctx: DecisionContext): Promise<LlmDecision> {
    const { text } = await this.client.complete(DECISION_SYSTEM_PROMPT, buildDecisionPayload(ctx));
    const parsed = llmDecisionSchema.safeParse(extractJson(text));
    if (!parsed.success) {
      throw new Error(`schema validation failed: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    }
    return parsed.data;
  }
}

export function getAiProvider(): AiProvider {
  const client = getLlmClient("decision");
  return client ? new LlmDecisionProvider(client) : new MockAiProvider();
}
