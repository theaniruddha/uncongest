import { NextResponse } from "next/server";
import { interpretIntent, intentRequestSchema } from "@/lib/providers/intentAgent";

export const dynamic = "force-dynamic";

/** Agent 1 endpoint: one message in → validated per-car intent updates out. */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = intentRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "schema validation failed", issues: parsed.error.issues }, { status: 422 });
  }
  if (!parsed.data.cars.some((c) => c.id === parsed.data.carId)) {
    return NextResponse.json({ error: "speaker carId not in trip" }, { status: 422 });
  }
  const result = await interpretIntent(parsed.data);
  return NextResponse.json(result);
}
