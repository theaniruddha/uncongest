import { NextResponse } from "next/server";
import { z } from "zod";
import { placeRefSchema } from "@/lib/trip/types";
import { resolveRoute, RouteUnavailableError, RoutingServiceUnavailableError } from "@/lib/providers/routing";

export const dynamic = "force-dynamic";

const requestSchema = z.object({
  origin: placeRefSchema,
  destination: placeRefSchema,
  sessionId: z.string().max(100).optional(),
  /** "defer": return geometry immediately (exitsStatus "pending"); fetch exits via POST /api/route/exits. */
  exits: z.enum(["inline", "defer"]).optional(),
  /** Up to 2 via points the route must pass through (e.g. a chosen alternative's via). */
  via: z.array(z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) })).max(2).optional()
});

/** POST {origin, destination, sessionId?} → TripRoute (fixture / cache / OSRM). */
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
  const { origin, destination, sessionId, exits, via } = parsed.data;
  try {
    return NextResponse.json(await resolveRoute(origin, destination, { sessionId, exits, via }));
  } catch (err) {
    if (err instanceof RouteUnavailableError) {
      return NextResponse.json({ error: err.message, suggestion: "Try the Toronto → Montréal demo preset" }, { status: 404 });
    }
    if (err instanceof RoutingServiceUnavailableError) {
      return NextResponse.json({ error: err.message, suggestion: "Try the Toronto → Montréal demo preset" }, { status: 503 });
    }
    console.error("[api/route]", err);
    return NextResponse.json({ error: "route lookup failed", suggestion: "Try the Toronto → Montréal demo preset" }, { status: 503 });
  }
}
