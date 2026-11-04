import { NextResponse } from "next/server";
import { externalProvidersEnabled, getRuntimeMode, museEnabled } from "@/lib/runtimeMode";
import { museApiKey } from "@/lib/agent2/llmSafety";

export const dynamic = "force-dynamic";

/** Only configuration status leaves the server, never credentials or endpoint URLs. */
export async function GET() {
  return NextResponse.json({
    mode: getRuntimeMode(),
    museEnabled: museEnabled(),
    museKeyConfigured: Boolean(museApiKey()),
    externalProvidersEnabled: externalProvidersEnabled(),
    tomtomEnabled: externalProvidersEnabled() && process.env.TOMTOM_LIVE === "1" && Boolean(process.env.TOMTOM_API_KEY)
  }, { headers: { "Cache-Control": "no-store" } });
}
