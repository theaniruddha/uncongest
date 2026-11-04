import { NextResponse } from "next/server";
import { z } from "zod";
import { placeRefSchema } from "@/lib/trip/types";
import {
  generateAlternatives,
  getStoredRoute,
  resolveRoute,
  RouteUnavailableError,
  RoutingServiceUnavailableError
} from "@/lib/providers/routing";

export const dynamic = "force-dynamic";

const requestSchema = z.object({
  id: z.string().min(1).max(100),
  origin: placeRefSchema,
  destination: placeRefSchema,
  sessionId: z.string().max(100).optional(),
  maxAlternatives: z.number().int().min(1).max(4).optional()
});

const SUGGESTION = "Try the Toronto → Montréal demo preset";

/**
 * POST {id, origin, destination, sessionId?} → { alternatives } for the main route `id`
 * (OSRM-native alternatives + via-point detours). Re-resolves the main geometry (cache → OSRM,
 * exits deferred) if the id is no longer in memory.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "schema validation failed", issues: parsed.error.issues }, { status: 422 });
  }
  const { id, origin, destination, sessionId, maxAlternatives } = parsed.data;
  try {
    const mainId = getStoredRoute(id) ? id : (await resolveRoute(origin, destination, { sessionId, exits: "defer" })).id;
    const alternatives = await generateAlternatives(mainId, { sessionId, maxAlternatives });
    return NextResponse.json({ id: mainId, alternatives });
  } catch (err) {
    if (err instanceof RouteUnavailableError) return NextResponse.json({ error: err.message, suggestion: SUGGESTION }, { status: 404 });
    if (err instanceof RoutingServiceUnavailableError) return NextResponse.json({ error: err.message, suggestion: SUGGESTION }, { status: 503 });
    console.error("[api/route/alternatives]", err);
    return NextResponse.json({ error: "alternatives lookup failed", suggestion: SUGGESTION }, { status: 503 });
  }
}
