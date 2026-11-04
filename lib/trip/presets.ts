import { tripSetupSchema, type CarSetup, type PlaceRef, type TripSetup } from "./types";

/**
 * Named places and one-click scenario presets for the /trip simulator.
 * HOME_PRESET is a fictional, simulated home: an approximate area centroid, never an address.
 */

export const HOME_PRESET: PlaceRef = {
  label: "Home (simulated) · Four Springs area, Mississauga",
  lat: 43.5795,
  lng: -79.6435,
  type: "home",
  source: "preset"
};

/** Must match the cached demo route endpoints (data/routes/toronto-montreal.json). */
export const TORONTO: PlaceRef = { label: "Toronto, ON", lat: 43.6532, lng: -79.3832, type: "other", source: "preset" };
export const MONTREAL: PlaceRef = { label: "Montréal, QC", lat: 45.5017, lng: -73.5673, type: "other", source: "preset" };
export const LETCHWORTH: PlaceRef = { label: "Letchworth State Park, NY", lat: 42.57, lng: -78.05, type: "other", source: "preset" };
export const NIAGARA_FALLS: PlaceRef = { label: "Niagara Falls, ON", lat: 43.0896, lng: -79.0849, type: "other", source: "preset" };
export const OTTAWA: PlaceRef = { label: "Ottawa, ON", lat: 45.4215, lng: -75.6972, type: "other", source: "preset" };
export const KINGSTON: PlaceRef = { label: "Kingston, ON", lat: 44.2312, lng: -76.486, type: "other", source: "preset" };

export const NAMED_PLACES: PlaceRef[] = [HOME_PRESET, TORONTO, MONTREAL, LETCHWORTH, NIAGARA_FALLS, OTTAWA, KINGSTON];

export interface ScenarioPreset {
  id: string;
  title: string;
  blurb: string;
  setup: (todayLocalDate: string) => TripSetup;
}

function car(id: CarSetup["id"], overrides: Partial<CarSetup> = {}): CarSetup {
  const labels: Record<CarSetup["id"], string> = { car_a: "Car A", car_b: "Car B", car_c: "Car C" };
  return {
    id,
    label: labels[id],
    adults: 2,
    kids: 0,
    dietary: [],
    speedKph: 100,
    startOffsetMinutes: 0,
    initialNeeds: [],
    ...overrides
  };
}

type SetupInput = Omit<TripSetup, "mood" | "mealPreference" | "mealHistory" | "maxDetourMinutes" | "dataMode"> &
  Partial<Pick<TripSetup, "mood" | "mealPreference" | "mealHistory" | "maxDetourMinutes" | "dataMode">>;

function build(input: SetupInput): TripSetup {
  return tripSetupSchema.parse(input);
}

function departAt(date: string, time: string): TripSetup["departure"] {
  return { mode: "depart_at", date, time };
}

/** The next Dec 15 on or after today's month; today itself if it is already December. */
export function nextWinterDate(todayLocalDate: string): string {
  const [y, m] = todayLocalDate.split("-").map(Number);
  if (m === 12) return todayLocalDate;
  return `${y}-12-15`;
}

export const SCENARIO_PRESETS: ScenarioPreset[] = [
  {
    id: "demo-3min",
    title: "▶ 3-minute demo",
    blurb:
      "Toronto → Montréal, one car with two kids. Recorded road geometry, fictional stops and mock weather; try Hungry now, compare recommendations, select a stop and confirm the visit.",
    setup: (today) =>
      build({
        origin: TORONTO,
        destination: MONTREAL,
        departure: departAt(today, "09:30"),
        dataMode: "demo",
        mood: ["relaxed", "hungry"],
        mealPreference: "auto",
        mealHistory: { kind: "unknown" },
        cars: [car("car_a", { adults: 2, kids: 2, dietary: ["vegetarian"] })]
      })
  },
  {
    id: "early-lunch-overdue",
    title: "Early start, lunch overdue",
    blurb: "Leave the simulated Mississauga home at 07:30 for Letchworth with two kids — lunch comes due mid-trip.",
    setup: (today) =>
      build({
        origin: HOME_PRESET,
        destination: LETCHWORTH,
        departure: departAt(today, "07:30"),
        mood: ["relaxed"],
        mealPreference: "auto",
        mealHistory: { kind: "unknown" },
        cars: [car("car_a", { adults: 2, kids: 2 })]
      })
  },
  {
    id: "kids-washroom",
    title: "Kids need a washroom",
    blurb: "Home to Niagara Falls at 10:00 with kids who already need a restroom.",
    setup: (today) =>
      build({
        origin: HOME_PRESET,
        destination: NIAGARA_FALLS,
        departure: departAt(today, "10:00"),
        cars: [car("car_a", { adults: 2, kids: 2, initialNeeds: ["restroom"] })]
      })
  },
  {
    id: "coffee-quick-bite",
    title: "Coffee and a quick bite",
    blurb: "Toronto to Ottawa at 08:00 — coffee now, something quick to eat later.",
    setup: (today) =>
      build({
        origin: TORONTO,
        destination: OTTAWA,
        departure: departAt(today, "08:00"),
        mealPreference: "quick_bite",
        cars: [car("car_a", { initialNeeds: ["coffee"] })]
      })
  },
  {
    id: "winter-after-dark",
    title: "Winter drive after dark",
    blurb: "Toronto to Montréal on a mid-December afternoon — arrival after dark, driver tired.",
    setup: (today) =>
      build({
        origin: TORONTO,
        destination: MONTREAL,
        departure: departAt(nextWinterDate(today), "13:30"),
        mood: ["tired"],
        cars: [car("car_a")]
      })
  },
  {
    id: "relaxed-road-trip",
    title: "Relaxed road trip",
    blurb: "Home to Letchworth at 09:30, happy to detour up to 20 min for a proper meal.",
    setup: (today) =>
      build({
        origin: HOME_PRESET,
        destination: LETCHWORTH,
        departure: departAt(today, "09:30"),
        mood: ["relaxed"],
        mealPreference: "proper_meal",
        maxDetourMinutes: 20,
        cars: [car("car_a")]
      })
  },
  {
    id: "three-cars",
    title: "Three-car convoy",
    blurb: "Toronto to Montréal with three cars: B vegetarian 5 min behind, C halal with kids 12 min behind.",
    setup: (today) =>
      build({
        origin: TORONTO,
        destination: MONTREAL,
        departure: departAt(today, "09:00"),
        cars: [
          car("car_a", { adults: 2, speedKph: 105, initialNeeds: ["coffee"] }),
          car("car_b", { adults: 3, dietary: ["vegetarian"], speedKph: 100, startOffsetMinutes: 5 }),
          car("car_c", { adults: 2, kids: 2, dietary: ["halal"], speedKph: 95, startOffsetMinutes: 12, initialNeeds: ["restroom"] })
        ]
      })
  },
  {
    id: "toronto-montreal-demo",
    title: "Highway 401 demo (fictional stops)",
    blurb: "The original Toronto → Montréal demo with labelled fictional fixture stops.",
    setup: (today) =>
      build({
        origin: TORONTO,
        destination: MONTREAL,
        departure: departAt(today, "09:30"),
        dataMode: "demo",
        cars: [car("car_a", { adults: 2, kids: 2, dietary: ["vegetarian"] })]
      })
  },
  {
    id: "short-no-stop",
    title: "Short trip, no stop needed",
    blurb: "Toronto to the simulated Mississauga home at 15:00 after eating — expect Uncongest to stay quiet.",
    setup: (today) =>
      build({
        origin: TORONTO,
        destination: HOME_PRESET,
        departure: departAt(today, "15:00"),
        mealHistory: { kind: "already_ate" },
        cars: [car("car_a")]
      })
  }
];

export function getScenarioPreset(id: string): ScenarioPreset | undefined {
  return SCENARIO_PRESETS.find((p) => p.id === id);
}
