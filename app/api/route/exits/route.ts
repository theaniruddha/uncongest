import { NextResponse } from "next/server";
import { z } from "zod";
import { placeRefSchema } from "@/lib/trip/types";
import { resolveExits, RouteUnavailableError, RoutingServiceUnavailableError } from "@/lib/providers/routing";

export const dynamic = "force-dynamic";

const requestSchema = z.object({
  id: z.string().min(1).max(100),
  origin: placeRefSchema,
  destination: placeRefSchema,
  sessionId: z.string().max(100).optional()
});

const SUGGESTION = "Try the Toronto → Montréal demo preset";

/**
 * POST {id, origin, destination, sessionId?} → TripRoute with exits + border crossings
 * (exitsStatus "ready" or "degraded"). Second half of progressive loading after /api/route {exits:"defer"}.
 * Endpoints let the server re-resolve geometry (cache → OSRM) if the id is no longer in memory.
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
  const { id, origin, destination, sessionId } = parsed.data;
  try {
    return NextResponse.json(await resolveExits(id, { origin, destination, sessionId }));
  } catch (err) {
    if (err instanceof RouteUnavailableError) return NextResponse.json({ error: err.message, suggestion: SUGGESTION }, { status: 404 });
    if (err instanceof RoutingServiceUnavailableError) return NextResponse.json({ error: err.message, suggestion: SUGGESTION }, { status: 503 });
    console.error("[api/route/exits]", err);
    return NextResponse.json({ error: "exit lookup failed", suggestion: SUGGESTION }, { status: 503 });
  }
}
