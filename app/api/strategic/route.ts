import { NextResponse } from "next/server";
import { runStrategicPlanner, strategicInputSchema } from "@/lib/agent2/strategic";
import { allUsage } from "@/lib/providers/budget";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Agent 2 · Strategic Planner (provisional future-opportunity plan). Never blocks Tactical. */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 422 });
  }
  const parsed = strategicInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "schema validation failed", issues: parsed.error.issues }, { status: 422 });
  }
  const result = await runStrategicPlanner(parsed.data);
  return NextResponse.json({ ...result, usage: allUsage(parsed.data.sessionId) });
}
