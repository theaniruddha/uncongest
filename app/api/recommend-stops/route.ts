import { NextResponse } from "next/server";
import { recommendStopsRequestSchema } from "@/lib/domain/schemas";
import { decideWithExploration } from "@/lib/domain/engine";
import type { RecommendStopsRequest } from "@/lib/domain/types";
import { getAiProvider } from "@/lib/providers/ai";
import { getPlaceProvider } from "@/lib/providers/places";

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

  const provider = getAiProvider();
  const placeProvider = getPlaceProvider();
  const providerNote = { value: provider.name };
  const llmResolver = async (ctx: {
    eligible: import("@/lib/domain/types").EligibleStop[];
    rejected: import("@/lib/domain/types").RejectionReason[];
    triggerReasons: string[];
  }) => {
    try {
      return await provider.decide({
        trip: request.trip,
        config: request.config,
        cars: request.cars,
        intent: request.collectiveIntent,
        environment: request.environment,
        eligible: ctx.eligible,
        rejected: ctx.rejected,
        triggerReasons: ctx.triggerReasons
      });
    } catch (err) {
      providerNote.value = `${provider.name} failed (${(err as Error).message}); deterministic fallback used`;
      return null;
    }
  };

  const result = await decideWithExploration(request, placeProvider, providerNote.value, provider.isMock, llmResolver);
  return NextResponse.json(result);
}
