/** Server-only deployment policy. Credentials alone never opt a judge into live services. */
export type RuntimeMode = "demo" | "live-muse" | "full-live";

export function getRuntimeMode(): RuntimeMode {
  const mode = process.env.UNCONGEST_MODE;
  return mode === "live-muse" || mode === "full-live" ? mode : "demo";
}

export function externalProvidersEnabled(): boolean {
  return getRuntimeMode() === "full-live";
}

export function museEnabled(): boolean {
  return getRuntimeMode() !== "demo" && (!process.env.AI_PROVIDER || process.env.AI_PROVIDER === "meta");
}
