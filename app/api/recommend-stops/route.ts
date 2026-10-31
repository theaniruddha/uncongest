import { NextResponse } from "next/server";
import stopsFixture from "@/data/stops/highway-401.mock.json";
import { recommendStopsRequestSchema } from "@/lib/domain/schemas";
import { decide } from "@/lib/domain/engine";
import type { StopCandidate, RecommendStopsRequest } from "@/lib/domain/types";
import { getAiProvider } from "@/lib/providers/ai";
import { evaluateCandidates, deriveTriggerReasons } from "@/lib/domain/engine";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = recommendStopsRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "schema validation failed", issues: parsed.error.issues }, { status: 422 });
  }
  const request: RecommendStopsRequest = parsed.data;
  const stops = (stopsFixture as { stops: StopCandidate[] }).stops;

  const provider = getAiProvider();
  let llmPick: Awaited<ReturnType<typeof provider.decide>> | null = null;
  let providerNote = provider.name;
  try {
    const { eligible, rejected } = evaluateCandidates(
      stops, request.cars, request.collectiveIntent, request.config, request.trip, request.environment
    );
    const triggers = deriveTriggerReasons(request.collectiveIntent, request.config, request.trip, request.environment);
    llmPick = await provider.decide({
      trip: request.trip,
      config: request.config,
      cars: request.cars,
      intent: request.collectiveIntent,
      environment: request.environment,
      eligible,
      rejected,
      triggerReasons: triggers
    });
  } catch (err) {
    providerNote = `${provider.name} failed (${(err as Error).message}); deterministic fallback used`;
    llmPick = null;
  }

  const result = decide(request, stops, llmPick, providerNote, provider.isMock);
  return NextResponse.json(result);
}
