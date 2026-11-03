import { NextResponse } from "next/server";
import { z } from "zod";
import { GeocodeUnavailableError, reverseGeocode, searchPlaces } from "@/lib/providers/geocode";

export const dynamic = "force-dynamic";

const searchSchema = z.object({
  q: z.string().trim().min(3).max(200),
  limit: z.coerce.number().int().min(1).max(10).optional(),
  sessionId: z.string().max(100).optional()
});
const reverseSchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  sessionId: z.string().max(100).optional()
});

/** GET ?q=… (place search, CA/US) or ?lat=…&lng=… (reverse geocode). Nominatim, throttled + cached. */
export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const params = Object.fromEntries([...sp.entries()].filter(([, v]) => v !== ""));
  try {
    if (params.lat !== undefined || params.lng !== undefined) {
      const parsed = reverseSchema.safeParse(params);
      if (!parsed.success) return NextResponse.json({ error: "invalid lat/lng", issues: parsed.error.issues }, { status: 400 });
      const { lat, lng, sessionId } = parsed.data;
      return NextResponse.json(await reverseGeocode(lat, lng, { sessionId }));
    }
    const parsed = searchSchema.safeParse(params);
    if (!parsed.success) return NextResponse.json({ error: "query must be at least 3 characters", issues: parsed.error.issues }, { status: 400 });
    const { q, limit, sessionId } = parsed.data;
    return NextResponse.json({ results: await searchPlaces(q, { limit, sessionId }) });
  } catch (err) {
    if (err instanceof GeocodeUnavailableError) return NextResponse.json({ error: err.message }, { status: 503 });
    console.error("[api/geocode]", err);
    return NextResponse.json({ error: "geocoding failed" }, { status: 503 });
  }
}
