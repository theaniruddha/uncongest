import { NextResponse } from "next/server";
import { z } from "zod";
import { weatherSchema } from "@/lib/domain/schemas";
import { getWeatherProvider } from "@/lib/providers/weather";

export const dynamic = "force-dynamic";

const requestSchema = z.object({
  mode: z.enum(["live", "simulated"]),
  fallback: weatherSchema,
  timeZone: z.string().min(1).max(64).optional(),
  points: z
    .array(
      z.object({
        id: z.string().min(1).max(80),
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        localDateTime: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
      })
    )
    .min(1)
    .max(12)
});

/** Context layer helper for the "Road ahead" strip: weather at waypoints at their ETA. Cached server-side. */
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
  const { mode, fallback, points, timeZone } = parsed.data;
  const readings = await getWeatherProvider(mode, timeZone).getReadings(points, fallback);
  return NextResponse.json({ mode, readings });
}
