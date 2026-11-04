import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getLlmClient, MetaResponsesClient } from "@/lib/providers/ai";
import { callMuseStructured, resetMuseStructured } from "@/lib/agent2/museStructured";

const request = {
  system: "test", user: "test", schemaName: "readiness", jsonSchema: {},
  zod: z.object({ ok: z.boolean() }), effort: "minimal" as const, deadlineMs: 1000
};
const success = () => new Response(JSON.stringify({ status: "completed", output_text: '{"ok":true}' }));

beforeEach(() => {
  resetMuseStructured();
  vi.stubEnv("MODEL_API_KEY", "");
  vi.stubEnv("MUSE_API_KEY", "");
  vi.stubEnv("META_API_KEY", "");
  vi.stubEnv("META_MODEL_API_KEY", "");
  vi.stubEnv("AI_PROVIDER", "meta");
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("submission Muse configuration and safety", () => {
  it("Demo never sends inference, even with personal credentials configured", async () => {
    vi.stubEnv("UNCONGEST_MODE", "demo");
    vi.stubEnv("MUSE_API_KEY", "private-key");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(getLlmClient("intent")).toBeNull();
    expect(await callMuseStructured(request)).toMatchObject({ ok: false, reason: "disabled" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Live Muse with no key falls back without a network call", async () => {
    vi.stubEnv("UNCONGEST_MODE", "live-muse");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(getLlmClient("decision")).toBeNull();
    expect(await callMuseStructured(request)).toMatchObject({ ok: false, reason: "disabled" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts the same legacy key alias in both inference paths", async () => {
    vi.stubEnv("UNCONGEST_MODE", "live-muse");
    vi.stubEnv("META_MODEL_API_KEY", "test-key");
    const fetchMock = vi.fn(async () => success());
    vi.stubGlobal("fetch", fetchMock);
    expect(getLlmClient("intent")).not.toBeNull();
    expect(await callMuseStructured(request)).toMatchObject({ ok: true, value: { ok: true } });
    expect(fetchMock.mock.calls).toHaveLength(1);
  });

  it("returns only the HTTP status when an invalid-key response echoes a secret", async () => {
    vi.stubEnv("UNCONGEST_MODE", "live-muse");
    vi.stubEnv("MUSE_API_KEY", "private-key");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Authorization: Bearer private-key", { status: 401 })));
    const result = await callMuseStructured(request);
    expect(result).toMatchObject({ ok: false, reason: "http", detail: "muse http 401" });
    expect(JSON.stringify(result)).not.toContain("private-key");
  });

  it("shares the rate cap between structured and legacy workflows", async () => {
    vi.stubEnv("UNCONGEST_MODE", "live-muse");
    vi.stubEnv("MUSE_API_KEY", "test-key");
    vi.stubEnv("LLM_MAX_CALLS_PER_10_MIN", "1");
    const fetchMock = vi.fn(async () => success());
    vi.stubGlobal("fetch", fetchMock);
    expect(await callMuseStructured(request)).toMatchObject({ ok: true });
    const client = getLlmClient("intent")!;
    await expect(client.complete("s", "u")).rejects.toThrow("LLM rate limit reached");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not leak network exception details from legacy clients", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("failed https://private-key@example.com"); }));
    const client = new MetaResponsesClient({ agent: "intent", baseUrl: "https://example.invalid/v1", apiKey: "private-key", model: "test", temperature: 1, topP: 1, maxOutputTokens: 100, reasoningEffort: "minimal", timeoutMs: 1000 });
    await expect(client.complete("s", "u")).rejects.toThrow("Model request or output validation failed");
  });
});
