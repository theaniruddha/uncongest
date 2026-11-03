import { NextResponse } from "next/server";
import { interpretScenario, scenarioRequestSchema } from "@/lib/providers/scenarioAgent";

export const dynamic = "force-dynamic";

/** Agent 1 (scenario): free-text trip description in → validated, coordinate-free setup suggestions out. */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = scenarioRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "schema validation failed", issues: parsed.error.issues }, { status: 422 });
  }
  const result = await interpretScenario(parsed.data);
  return NextResponse.json(result);
}
