import { describe, expect, it } from "vitest";
import { checkTacticalStaleness, withoutSkipped } from "@/lib/agent2/staleness";
import { isPlanExpired, stopsSignature, strategicClientStatus, strategicContextVersion, strategicRetryDelayMs, tacticalContextVersion, type VersionInput } from "@/lib/agent2/versions";
import { summarize } from "@/lib/agent2/metrics";

const base = (): VersionInput => ({
  tripGen: 1,
  routeId: "osrm-abc",
  setup: {
    destinationLabel: "Montréal",
    departureUtcIso: "2026-11-03T13:00:00.000Z",
    departureMode: "depart_at",
    tz: "America/Toronto",
    dataMode: "real",
    mood: ["hungry", "relaxed"],
    mealPreference: "auto",
    mealHistory: { kind: "unknown" },
    cars: [
      { id: "car_a", speedKph: 100, startOffsetMinutes: 0 },
      { id: "car_b", speedKph: 100, startOffsetMinutes: 5 }
    ]
  },
  weatherOverride: "live",
  intents: { car_a: { needs: [{ need: "meal" }], dietary: [] }, car_b: { needs: [], dietary: ["vegetarian"] } },
  stops: []
});
const tv = (v: VersionInput, skipped: string[] = []) => tacticalContextVersion({ ...v, skipped });
const sv = (v: VersionInput, epoch = 0) => strategicContextVersion({ ...v, epoch });
const stop = (status: string, satisfiedNeeds: string[] = []) => ({ stopId: "s1", status, satisfiedNeeds });

describe("context versions: setup-level fields", () => {
  const cases: Array<[string, (v: VersionInput) => void]> = [
    ["departure time", (v) => (v.setup.departureUtcIso = "2026-11-03T22:00:00.000Z")],
    ["departure mode", (v) => (v.setup.departureMode = "arrive_by")],
    ["mood", (v) => (v.setup.mood = ["hurry"])],
    ["meal preference", (v) => (v.setup.mealPreference = "coffee")],
    ["meal history", (v) => (v.setup.mealHistory = { kind: "already_ate" })],
    ["car speed", (v) => (v.setup.cars[0].speedKph = 90)],
    ["trip generation (reset / re-plan)", (v) => (v.tripGen = 2)]
  ];
  for (const [name, mutate] of cases) {
    it(`${name} changes both versions`, () => {
      const v = base();
      const w = base();
      mutate(w);
      expect(tv(w)).not.toBe(tv(v));
      expect(sv(w)).not.toBe(sv(v));
    });
  }
  it("is stable for identical input and independent of mood order", () => {
    const w = base();
    w.setup.mood = ["relaxed", "hungry"];
    expect(tv(w)).toBe(tv(base()));
    expect(sv(w)).toBe(sv(base()));
  });
  it("follower offset only affects Tactical", () => {
    const w = base();
    w.setup.cars[1].startOffsetMinutes = 12;
    expect(tv(w)).not.toBe(tv(base()));
    expect(sv(w)).toBe(sv(base()));
  });
});

describe("context versions: skipped stops and stop lifecycle", () => {
  it("skipping a stop changes Tactical but not Strategic", () => {
    expect(tv(base(), ["x"])).not.toBe(tv(base()));
    expect(tv(base(), ["a", "b"])).toBe(tv(base(), ["b", "a"]));
  });
  it("SELECTED → EN_ROUTE → ARRIVED is one Tactical version and no Strategic change", () => {
    const at = (status: string) => ({ ...base(), stops: [stop(status)] });
    expect(tv(at("SELECTED"))).toBe(tv(at("EN_ROUTE")));
    expect(tv(at("EN_ROUTE"))).toBe(tv(at("ARRIVED")));
    expect(tv(at("SELECTED"))).not.toBe(tv(base()));
    expect(sv(at("SELECTED"))).toBe(sv(base()));
    expect(sv(at("ARRIVED"))).toBe(sv(base()));
    expect(sv(at("PROPOSED"))).toBe(sv(base()));
  });
  it("COMPLETED (incl. satisfied needs) and CANCELLED change Strategic; RESUMED == COMPLETED", () => {
    const at = (status: string, needs: string[] = []) => ({ ...base(), stops: [stop(status, needs)] });
    expect(sv(at("COMPLETED", ["meal"]))).not.toBe(sv(at("ARRIVED")));
    expect(sv(at("COMPLETED", ["meal"]))).not.toBe(sv(at("COMPLETED", [])));
    expect(sv(at("RESUMED", ["meal"]))).toBe(sv(at("COMPLETED", ["meal"])));
    expect(sv(at("CANCELLED"))).not.toBe(sv(base()));
  });
  it("stopsSignature granularity", () => {
    const stops = [stop("ARRIVED"), { stopId: "s0", status: "COMPLETED", satisfiedNeeds: ["restroom", "meal"] }, { stopId: "s2", status: "PROPOSED", satisfiedNeeds: [] }];
    expect(stopsSignature(stops, "tactical")).toEqual(["active:s1", "done:s0:meal+restroom"]);
    expect(stopsSignature(stops, "strategic")).toEqual(["done:s0:meal+restroom"]);
  });
  it("needs and weather override change Strategic; progress epoch bumps it once", () => {
    const w = base();
    w.intents.car_b = { needs: [{ need: "restroom" }], dietary: ["vegetarian"] };
    expect(sv(w)).not.toBe(sv(base()));
    expect(sv({ ...base(), weatherOverride: "snow" })).not.toBe(sv(base()));
    expect(sv(base(), 1)).not.toBe(sv(base(), 0));
  });
});

describe("strategic plan expiry", () => {
  const plan = { expiresAtKm: 150, expiresAtElapsed: 90 };
  it("expires past the km or the elapsed limit", () => {
    expect(isPlanExpired(plan, { leadKm: 149, elapsedMinutes: 89, routeTotalKm: 540 })).toBe(false);
    expect(isPlanExpired(plan, { leadKm: 150, elapsedMinutes: 10, routeTotalKm: 540 })).toBe(true);
    expect(isPlanExpired(plan, { leadKm: 20, elapsedMinutes: 90, routeTotalKm: 540 })).toBe(true);
  });
  it("unknown position/time or no plan never expires", () => {
    expect(isPlanExpired(plan, { leadKm: null, elapsedMinutes: null })).toBe(false);
    expect(isPlanExpired(null, { leadKm: 999, elapsedMinutes: 999 })).toBe(false);
    expect(isPlanExpired({}, { leadKm: 999, elapsedMinutes: 999 })).toBe(false);
  });
  it("a km expiry at the end of the route never loops at the destination", () => {
    expect(isPlanExpired({ expiresAtKm: 540 }, { leadKm: 540, elapsedMinutes: 0, routeTotalKm: 540 })).toBe(false);
  });
});

describe("strategic status + retry", () => {
  it("server 'error' and unknown statuses are not success", () => {
    expect(strategicClientStatus("error")).toBe("error");
    expect(strategicClientStatus("weird")).toBe("error");
    expect(strategicClientStatus(undefined)).toBe("error");
    expect(strategicClientStatus("cached")).toBe("cached");
    expect(strategicClientStatus("timeout")).toBe("timeout");
  });
  it("retry backoff is bounded", () => {
    expect(strategicRetryDelayMs(0)).toBe(8000);
    expect(strategicRetryDelayMs(1)).toBe(16000);
    expect(strategicRetryDelayMs(2)).toBeNull();
  });
  it("error samples count against the success share", () => {
    const s = summarize([{ ms: 1000, status: "muse", at: 0 }, { ms: 1000, status: "error", at: 0 }], 5000);
    expect(s.fallbackPct).toBe(50);
  });
});

describe("tactical staleness: reset / rewind and skipped stops", () => {
  const r = {
    recommendations: [{ stopId: "a", rank: 1 }, { stopId: "b", rank: 2 }],
    recommendedStops: [{ id: "a", distanceAlongRouteKm: 200 }, { id: "b", distanceAlongRouteKm: 230 }],
    decidedFor: { contextVersion: "v1", leadKm: 180, elapsedMinutes: 110 }
  };
  it("a result decided at km 180 is stale after a reset to km 0 even with the same version", () => {
    expect(checkTacticalStaleness(r, "v1", 0, 16, 0)).toEqual({ stale: true, reason: "time_reversed" });
  });
  it("elapsed going backwards is stale too", () => {
    const r2 = { ...r, decidedFor: { ...r.decidedFor, leadKm: null } };
    expect(checkTacticalStaleness(r2, "v1", 180, 16, 20)).toEqual({ stale: true, reason: "time_reversed" });
  });
  it("rounding tolerance keeps a fresh result", () => {
    expect(checkTacticalStaleness(r, "v1", 179.8, 16, 109.6)).toEqual({ stale: false, keepStopIds: ["a", "b"], dropped: [] });
  });
  it("legacy results without lead/elapsed still work", () => {
    expect(checkTacticalStaleness({ ...r, decidedFor: { contextVersion: "v1" } }, "v1", 0, 16)).toMatchObject({ stale: false });
  });
  it("stops skipped mid-request are removed and re-ranked", () => {
    expect(withoutSkipped(r.recommendations, ["a"])).toEqual([{ stopId: "b", rank: 1 }]);
    expect(withoutSkipped(r.recommendations, [])).toEqual(r.recommendations);
    expect(withoutSkipped(r.recommendations, ["a", "b"])).toEqual([]);
  });
});
