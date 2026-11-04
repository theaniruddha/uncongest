import { beforeEach, describe, expect, it, vi } from "vitest";

const museMock = vi.hoisted(() => ({
  callMuseStructured: vi.fn(),
  museModelName: vi.fn<[], string | null>(() => "muse-spark-1.3")
}));
vi.mock("@/lib/agent2/museStructured", () => museMock);

import { INTENT_JSON_SCHEMA, interpretIntent, type IntentRequest } from "@/lib/providers/intentAgent";

const REQ: IntentRequest = {
  carId: "car-a",
  source: "copassenger_text",
  text: "we really need a restroom asap, and we're vegetarian",
  localTime: "12:30",
  cars: [
    { id: "car-a", label: "Car A" },
    { id: "car-b", label: "Car B" }
  ],
  current: {
    "car-a": { needs: [], hungerLevel: 0, restroomUrgent: false, notHungry: false, dietary: [], kids: false, history: [] }
  }
};

const upd = (carId: string, extra: Record<string, unknown> = {}) => ({
  carId,
  addNeeds: [],
  removeNeeds: [],
  hungerLevel: null,
  restroomUrgent: null,
  notHungry: null,
  addDietary: [],
  removeDietary: [],
  kids: null,
  maxDetourMinutes: null,
  ...extra
});

beforeEach(() => {
  museMock.callMuseStructured.mockReset();
  museMock.museModelName.mockReset();
  museMock.museModelName.mockReturnValue("muse-spark-1.3");
});

describe("Agent 1 interpretIntent (Muse structured)", () => {
  it("maps a successful structured patch and calls Muse with minimal effort + deadline", async () => {
    museMock.callMuseStructured.mockResolvedValue({
      ok: true,
      ms: 2400,
      usage: null,
      value: {
        updates: [upd("car-a", { addNeeds: ["restroom"], restroomUrgent: true, addDietary: ["vegetarian"] })],
        understood: ["Car A urgently needs a restroom; vegetarian"],
        correction: false
      }
    });
    const res = await interpretIntent(REQ);
    expect(res.provider).toBe("muse:muse-spark-1.3 intent");
    expect(res.isMock).toBe(false);
    expect(res.fallbackReason).toBeUndefined();
    expect(res.updates).toHaveLength(1);
    expect(res.updates[0]).toMatchObject({ carId: "car-a", addNeeds: ["restroom"], restroomUrgent: true, addDietary: ["vegetarian"] });
    const call = museMock.callMuseStructured.mock.calls[0][0];
    expect(call.effort).toBe("minimal");
    expect(call.deadlineMs).toBe(8000);
    expect(call.jsonSchema).toBe(INTENT_JSON_SCHEMA);
    expect(call.system).toMatch(/add, change or retract/);
    expect(JSON.parse(call.user).message).toBe(REQ.text);
  });

  it("honours INTENT_DEADLINE_MS", async () => {
    vi.stubEnv("INTENT_DEADLINE_MS", "2500");
    museMock.callMuseStructured.mockResolvedValue({ ok: true, ms: 1, usage: null, value: { updates: [], understood: [], correction: false } });
    await interpretIntent(REQ);
    expect(museMock.callMuseStructured.mock.calls[0][0].deadlineMs).toBe(2500);
    vi.unstubAllEnvs();
  });

  it("drops updates for unknown car ids", async () => {
    museMock.callMuseStructured.mockResolvedValue({
      ok: true,
      ms: 2000,
      usage: null,
      value: { updates: [upd("car-a", { addNeeds: ["coffee"] }), upd("car-zzz", { addNeeds: ["meal"] })], understood: ["coffee"], correction: false }
    });
    const res = await interpretIntent(REQ);
    expect(res.updates.map((u) => u.carId)).toEqual(["car-a"]);
    expect(res.understood.some((s) => /dropped 1 update/.test(s))).toBe(true);
  });

  it("falls back to the regex parser on timeout with a fallbackReason", async () => {
    museMock.callMuseStructured.mockResolvedValue({ ok: false, reason: "timeout", detail: "muse timeout after 4000 ms", ms: 4000 });
    const res = await interpretIntent(REQ);
    expect(res.provider).toBe("muse-spark-1.3 failed; regex fallback");
    expect(res.isMock).toBe(true);
    expect(res.fallbackReason).toMatch(/timeout/);
    expect(res.updates[0].carId).toBe("car-a");
    expect(res.updates[0].addNeeds).toContain("restroom");
  });

  it("falls back on invalid output too", async () => {
    museMock.callMuseStructured.mockResolvedValue({ ok: false, reason: "invalid", detail: "schema validation failed", ms: 900 });
    const res = await interpretIntent(REQ);
    expect(res.provider).toBe("muse-spark-1.3 failed; regex fallback");
    expect(res.fallbackReason).toMatch(/invalid/);
  });

  it("uses regex-parser when Muse is disabled", async () => {
    museMock.museModelName.mockReturnValue(null);
    const res = await interpretIntent(REQ);
    expect(res.provider).toBe("regex-parser");
    expect(res.isMock).toBe(true);
    expect(res.fallbackReason).toBeUndefined();
    expect(museMock.callMuseStructured).not.toHaveBeenCalled();
  });

  it("uses regex-parser when callMuseStructured reports disabled", async () => {
    museMock.callMuseStructured.mockResolvedValue({ ok: false, reason: "disabled", detail: "no key", ms: 0 });
    const res = await interpretIntent(REQ);
    expect(res.provider).toBe("regex-parser");
  });
});

describe("INTENT_JSON_SCHEMA strict structure", () => {
  function walk(node: unknown, path: string, objects: string[]) {
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    const types = Array.isArray(n.type) ? n.type : [n.type];
    if (types.includes("object")) {
      objects.push(path);
      expect(n.additionalProperties, `${path}.additionalProperties`).toBe(false);
      const props = Object.keys((n.properties as Record<string, unknown>) ?? {});
      expect([...((n.required as string[]) ?? [])].sort(), `${path}.required`).toEqual([...props].sort());
      for (const k of props) walk((n.properties as Record<string, unknown>)[k], `${path}.${k}`, objects);
    }
    if (n.items) walk(n.items, `${path}[]`, objects);
  }

  it("every object has additionalProperties:false and required == all property keys", () => {
    const objects: string[] = [];
    walk(INTENT_JSON_SCHEMA, "$", objects);
    expect(objects).toEqual(["$", "$.updates[]"]);
  });

  it("needs/dietary are arrays of enums and nullable fields allow null", () => {
    const item = (INTENT_JSON_SCHEMA.properties as any).updates.items.properties;
    expect(item.addNeeds.items.enum).toEqual(["meal", "coffee", "restroom", "ev_charge", "grocery"]);
    expect(item.removeDietary.items.enum).toEqual(["vegetarian", "vegan", "halal", "gluten_free"]);
    for (const k of ["hungerLevel", "restroomUrgent", "notHungry", "kids", "maxDetourMinutes"]) expect(item[k].type).toContain("null");
  });
});
