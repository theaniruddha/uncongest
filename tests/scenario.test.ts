import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOME_PRESET, LETCHWORTH, MONTREAL, SCENARIO_PRESETS, TORONTO, nextWinterDate } from "@/lib/trip/presets";
import { tripSetupSchema } from "@/lib/trip/types";
import { interpretScenario, sanitizeSuggestions, scenarioSuggestionSchema } from "@/lib/providers/scenarioAgent";
import { POST } from "@/app/api/scenario/route";

const TODAY = "2026-11-03";
const LETCHWORTH_TEXT =
  "We're leaving Mississauga early, driving toward Letchworth, probably hungry by lunchtime, traveling with two kids, and we don't want a large detour.";

function deepKeys(v: unknown, acc: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => deepKeys(x, acc));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      acc.push(k);
      deepKeys(x, acc);
    }
  }
  return acc;
}
const COORD_KEYS = /^(lat|lng|lon|long|latitude|longitude|coordinates|geometry)$/i;

const baseSetup = () => SCENARIO_PRESETS.find((p) => p.id === "toronto-montreal-demo")!.setup(TODAY);

let prevProvider: string | undefined;
beforeEach(() => {
  prevProvider = process.env.AI_PROVIDER;
  process.env.AI_PROVIDER = "mock";
});
afterEach(() => {
  if (prevProvider === undefined) delete process.env.AI_PROVIDER;
  else process.env.AI_PROVIDER = prevProvider;
});

describe("presets", () => {
  it("every preset parses with tripSetupSchema and ids are unique", () => {
    const ids = SCENARIO_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of [
      "early-lunch-overdue",
      "kids-washroom",
      "coffee-quick-bite",
      "winter-after-dark",
      "relaxed-road-trip",
      "three-cars",
      "toronto-montreal-demo",
      "short-no-stop"
    ]) {
      expect(ids).toContain(id);
    }
    for (const p of SCENARIO_PRESETS) {
      expect(() => tripSetupSchema.parse(p.setup(TODAY)), p.id).not.toThrow();
      expect(p.setup(TODAY).departure.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("home is labelled simulated and named places match demo endpoints", () => {
    expect(HOME_PRESET.label).toMatch(/simulated/i);
    expect(HOME_PRESET.type).toBe("home");
    expect(HOME_PRESET.source).toBe("preset");
    expect([TORONTO.lat, TORONTO.lng]).toEqual([43.6532, -79.3832]);
    expect([MONTREAL.lat, MONTREAL.lng]).toEqual([45.5017, -73.5673]);
    expect(LETCHWORTH.type).toBe("other");
  });

  it("scenario specifics", () => {
    const get = (id: string) => SCENARIO_PRESETS.find((p) => p.id === id)!.setup(TODAY);
    expect(get("early-lunch-overdue").departure.time).toBe("07:30");
    expect(get("early-lunch-overdue").cars[0].kids).toBe(2);
    expect(get("kids-washroom").cars[0].initialNeeds).toContain("restroom");
    expect(get("coffee-quick-bite").mealPreference).toBe("quick_bite");
    expect(get("winter-after-dark").departure.date).toBe("2026-12-15");
    expect(get("relaxed-road-trip").maxDetourMinutes).toBe(20);
    const three = get("three-cars").cars;
    expect(three).toHaveLength(3);
    expect(three[1]).toMatchObject({ dietary: ["vegetarian"], startOffsetMinutes: 5 });
    expect(three[2]).toMatchObject({ dietary: ["halal"], startOffsetMinutes: 12 });
    expect(three[2].kids).toBeGreaterThan(0);
    expect(get("toronto-montreal-demo").dataMode).toBe("demo");
    expect(get("short-no-stop").mealHistory.kind).toBe("already_ate");
    expect(nextWinterDate("2026-12-28")).toBe("2026-12-28");
    expect(nextWinterDate("2027-01-04")).toBe("2027-12-15");
  });
});

describe("scenario agent (offline fallback)", () => {
  it("interprets the Letchworth sentence without coordinates", async () => {
    const out = await interpretScenario({ text: LETCHWORTH_TEXT, current: baseSetup(), todayLocalDate: TODAY, localTime: "07:00" });
    expect(() => scenarioSuggestionSchema.parse(out)).not.toThrow();
    expect(out.isMock).toBe(true);
    const s = out.suggestions;
    expect(s.originQuery).toMatch(/mississauga/i);
    expect(s.destinationQuery).toMatch(/letchworth/i);
    expect(s.cars?.[0].kids).toBe(2);
    expect(s.maxDetourMinutes).toBeLessThanOrEqual(10);
    expect(s.mood).toContain("hungry");
    expect(s.mealPreference).toBe("auto");
    expect(s.departureTime).toMatch(/^\d{2}:\d{2}$/);
    expect(s.departureMode).toBe("depart_at");
    expect(out.warnings.some((w) => /early/i.test(w))).toBe(true);
    expect(out.understood.length).toBeLessThanOrEqual(6);
    expect(deepKeys(out).filter((k) => COORD_KEYS.test(k))).toEqual([]);
    expect(JSON.stringify(out)).not.toMatch(/-?\d{1,3}\.\d{3,}/);
  });

  it("handles arrive-by, diet and coffee", async () => {
    const out = await interpretScenario({
      text: "From Toronto to Ottawa, we need to arrive by 13:00. Vegan and gluten free, and we want coffee.",
      current: baseSetup(),
      todayLocalDate: TODAY,
      localTime: "08:00"
    });
    expect(out.suggestions.originQuery).toBe("Toronto");
    expect(out.suggestions.destinationQuery).toBe("Ottawa");
    expect(out.suggestions.departureMode).toBe("arrive_by");
    expect(out.suggestions.departureTime).toBe("13:00");
    expect(out.suggestions.cars?.[0].dietary).toEqual(expect.arrayContaining(["vegan", "gluten_free"]));
    expect(out.suggestions.cars?.[0].initialNeeds).toContain("coffee");
  });

  it("parses explicit departure times", async () => {
    const out = await interpretScenario({ text: "Leaving at 9:30 with kids", current: baseSetup(), todayLocalDate: TODAY, localTime: "08:00" });
    expect(out.suggestions.departureTime).toBe("09:30");
    expect(out.suggestions.departureMode).toBe("depart_at");
  });
});

describe("sanitizeSuggestions (untrusted model output)", () => {
  it("drops unknown car ids, unsupported fields and coordinate queries; clamps numbers", () => {
    const warnings: string[] = [];
    const s = sanitizeSuggestions(
      {
        originQuery: "43.5795, -79.6435",
        destinationQuery: "Letchworth State Park",
        maxDetourMinutes: 999,
        lat: 43.1,
        geometry: [[1, 2]],
        cars: [{ id: "car_z", kids: 2 }, { id: "car_b", kids: 20, adults: 0, lat: 1 }]
      },
      warnings
    );
    expect(s.originQuery).toBeUndefined();
    expect(s.destinationQuery).toBe("Letchworth State Park");
    expect(s.maxDetourMinutes).toBe(45);
    expect(s.cars).toEqual([{ id: "car_b", kids: 8, adults: 1 }]);
    expect(deepKeys(s).filter((k) => COORD_KEYS.test(k))).toEqual([]);
    expect(warnings.some((w) => /car_z/.test(w))).toBe(true);
    expect(warnings.some((w) => /geometry/.test(w))).toBe(true);
  });
});

describe("POST /api/scenario", () => {
  const call = (body: unknown) =>
    POST(new Request("http://localhost/api/scenario", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));

  it("returns 200 offline with a valid suggestion", async () => {
    const res = await call({ text: LETCHWORTH_TEXT, current: baseSetup(), todayLocalDate: TODAY, localTime: "07:00" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(() => scenarioSuggestionSchema.parse(json)).not.toThrow();
    expect(json.provider).toBe("regex-parser");
  });

  it("returns 422 on bad input", async () => {
    const res = await call({ text: "x".repeat(601), current: {}, todayLocalDate: "nope", localTime: "7am" });
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(Array.isArray(json.issues)).toBe(true);
  });
});
