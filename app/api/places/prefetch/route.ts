import { NextResponse } from "next/server";
import { z } from "zod";
import { allUsage, getBudget } from "@/lib/providers/budget";
import { routeModelForRef } from "@/lib/providers/routeRef";
import { prefetchWindows } from "@/lib/providers/routePlaces";

export const dynamic = "force-dynamic";

const place = z.object({ label: z.string().max(200), lat: z.number(), lng: z.number(), type: z.enum(["home", "hotel", "other"]).default("other") });
const schema = z.object({
  route: z.object({ id: z.string().min(1).max(120), origin: place, destination: place, via: z.array(z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) })).max(2).optional() }),
  sessionId: z.string().min(1).max(64).default("anon"),
  windows: z
    .array(z.object({ minKm: z.number().min(0), maxKm: z.number().min(0), reason: z.string().max(120).optional() }))
    .min(1)
    .max(3)
});

/** Warm the real-place cache for a few likely stop windows (never the whole route). */
export async function POST(req: Request) {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "schema validation failed", issues: parsed.error.issues }, { status: 422 });
  const { route, sessionId, windows } = parsed.data;
  try {
    const model = await routeModelForRef(route, sessionId);
    const { trace, candidates } = await prefetchWindows(model, windows, { sessionId });
    return NextResponse.json({ trace, candidates, usage: (getBudget("tomtom"), allUsage(sessionId)) });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message, usage: (getBudget("tomtom"), allUsage(sessionId)) }, { status: 503 });
  }
}
