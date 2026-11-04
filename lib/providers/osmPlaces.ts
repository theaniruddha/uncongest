import type { ChargerSpec, Dietary, Need, StopCandidate } from "@/lib/domain/types";
import { exitLabel, type RouteExit, type RouteModel } from "@/lib/route/model";
import { overpassQuery } from "./overpass";

/**
 * Real places from OpenStreetMap (Overpass), discovered SELECTIVELY around a route window.
 * - Never the whole journey: only [minKm, maxKm], and only around exits in that window
 *   (≤ MAX_EXITS, EXIT_RADIUS_M each) or, for exit-less windows, around route samples.
 * - ONE Overpass query per window, cached by route id + rounded window + needs.
 * - Nothing invented: no menus, ratings, restroom access or hours beyond explicit OSM tags.
 *   `qualityScoreMock` is a NEUTRAL heuristic (not a rating) kept for the scoring formula.
 */

export const EXIT_RADIUS_M = 2500;
export const SAMPLE_RADIUS_M = 1500;
export const SAMPLE_STEP_KM = 8;
export const MAX_EXITS = 8;
export const MAX_SAMPLES = 12;
export const MAX_CANDIDATES = 25;
/** Places projecting further than this from the road are ignored (parallel roads, towns). */
const MAX_OFF_ROUTE_KM = 5;
const DEFAULT_NEEDS: Need[] = ["meal", "coffee", "restroom"];

type Tags = Record<string, string>;

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

const list = (v: string | undefined): string[] =>
  (v ?? "")
    .toLowerCase()
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean);

const yes = (v: string | undefined) => v === "yes" || v === "only";

export interface ParsedHours {
  open24h: boolean;
  opensLocal?: string;
  closesLocal?: string;
  hoursVerified: boolean;
  openingHoursRaw?: string;
}

const pad = (t: string) => {
  const [h, m] = t.split(":");
  return `${h.padStart(2, "0")}:${m}`;
};

/**
 * Conservative OSM opening_hours parser. Only "24/7" and a single uniform daily range
 * ("06:00-22:00", "Mo-Su 06:00-22:00") are treated as verified. Anything else (weekday
 * variations, multiple ranges, past-midnight closing, PH rules) is kept raw and unverified.
 */
export function parseOpeningHours(raw: string | undefined): ParsedHours {
  if (!raw || !raw.trim()) return { open24h: false, hoursVerified: false };
  const s = raw.trim().replace(/\s+/g, " ");
  if (/^24\/7$/i.test(s) || /^(Mo-Su )?00:00-24:00$/.test(s)) {
    return { open24h: true, hoursVerified: true, openingHoursRaw: raw };
  }
  const m = /^(?:Mo-Su )?(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/.exec(s);
  if (m) {
    const opens = pad(m[1]);
    const closes = pad(m[2]);
    const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
    const o = toMin(opens);
    const c = toMin(closes);
    if (o < 24 * 60 && c <= 24 * 60 && c > o) {
      return { open24h: false, opensLocal: opens, closesLocal: closes, hoursVerified: true, openingHoursRaw: raw };
    }
  }
  return { open24h: false, hoursVerified: false, openingHoursRaw: raw };
}

export type VegOptions = NonNullable<StopCandidate["vegOptions"]>;

/** Heuristic veg-friendliness from OSM diet:* / cuisine tags. Returns undefined for non-food places. */
export function vegOptionsFromTags(tags: Tags): { level: VegOptions; note: string } | undefined {
  const amenity = tags.amenity;
  const cuisine = list(tags.cuisine);
  const isFood =
    ["restaurant", "fast_food", "food_court", "cafe", "bar", "pub"].includes(amenity ?? "") || tags.highway === "services";
  if (!isFood) return undefined;
  if (tags["diet:vegetarian"] === "only" || tags["diet:vegan"] === "only") {
    return { level: "dedicated", note: "OSM diet tag: vegetarian/vegan only" };
  }
  if (yes(tags["diet:vegetarian"]) || yes(tags["diet:vegan"])) {
    return { level: "good", note: "OSM diet tag: vegetarian options" };
  }
  const goodCuisine = cuisine.find((c) => ["vegetarian", "vegan", "indian", "thai", "middle_eastern", "falafel"].includes(c));
  if (goodCuisine) return { level: "good", note: `heuristic from OSM cuisine=${goodCuisine}` };
  const poorCuisine = cuisine.find((c) => ["steak_house", "bbq"].includes(c));
  if (poorCuisine) return { level: "poor", note: `heuristic from OSM cuisine=${poorCuisine}` };
  if ((amenity === "bar" || amenity === "pub") && tags.food !== "yes") {
    return { level: "poor", note: `heuristic: ${amenity} without food emphasis` };
  }
  if (tags.highway === "services") return { level: "some", note: "heuristic: highway service plaza" };
  if (amenity === "food_court") return { level: "some", note: "heuristic: food court" };
  const generic = cuisine.find((c) => ["sandwich", "pizza", "coffee_shop", "burger", "donut", "bagel", "chicken"].includes(c));
  return { level: "some", note: generic ? `heuristic from OSM cuisine=${generic}` : `heuristic: generic ${amenity ?? "food"} (menu unknown)` };
}

/** Dietary flags ONLY from explicit diet:*=yes|only tags. */
export function dietaryFromTags(tags: Tags): Dietary[] {
  const out: Dietary[] = [];
  for (const d of ["vegetarian", "vegan", "halal", "gluten_free"] as Dietary[]) {
    if (yes(tags[`diet:${d}`])) out.push(d);
  }
  return out;
}

const powerOf = (v: string | undefined): number => {
  const m = /([\d.]+)\s*kw/i.exec(v ?? "");
  return m ? Number(m[1]) : 0;
};
const countOf = (v: string | undefined): number => {
  if (!v || v === "no") return 0;
  if (v === "yes") return 1;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** socket:* → ChargerSpec. powerKw 0 = not tagged (unknown). */
export function chargersFromTags(tags: Tags): ChargerSpec[] {
  const out: ChargerSpec[] = [];
  const add = (connector: ChargerSpec["connector"], key: string) => {
    const count = countOf(tags[`socket:${key}`]);
    if (count <= 0) return;
    const powerKw = powerOf(tags[`socket:${key}:output`]);
    const existing = out.find((c) => c.connector === connector);
    if (existing) {
      existing.count += count;
      existing.powerKw = Math.max(existing.powerKw, powerKw);
    } else out.push({ connector, powerKw, count });
  };
  add("NACS", "tesla_supercharger");
  add("NACS", "nacs");
  add("CCS1", "type1_combo");
  return out;
}

export interface PlaceKind {
  type: string;
  categories: Need[];
  restroomsVerified: boolean | null;
  qualityScoreMock: number;
  /** Fallback label for unnamed places of this kind; undefined = skip when unnamed. */
  unnamedLabel?: string;
}

const GROCERY_SHOPS = ["supermarket", "convenience", "department_store", "wholesale"];

/** Map OSM tags to a kind + Need[] categories. Returns null for irrelevant / private places. */
export function classifyTags(tags: Tags): PlaceKind | null {
  const amenity = tags.amenity;
  const shop = tags.shop;
  const toiletsYes = tags.toilets === "yes";
  const cats = new Set<Need>();
  let kind: PlaceKind;

  if (tags.highway === "services") {
    kind = { type: "highway-plaza", categories: [], restroomsVerified: true, qualityScoreMock: 0.65, unnamedLabel: "Service centre" };
    ["meal", "coffee", "restroom"].forEach((n) => cats.add(n as Need));
  } else if (tags.highway === "rest_area") {
    kind = { type: "rest-area", categories: [], restroomsVerified: true, qualityScoreMock: 0.6, unnamedLabel: "Rest area" };
    cats.add("restroom");
  } else if (amenity === "toilets") {
    if (["private", "no", "customers"].includes(tags.access ?? "")) return null;
    kind = { type: "public-toilets", categories: [], restroomsVerified: true, qualityScoreMock: 0.6, unnamedLabel: "Public washroom" };
    cats.add("restroom");
  } else if (amenity === "restaurant" || amenity === "fast_food" || amenity === "food_court") {
    const type = amenity === "food_court" ? "food-court" : amenity === "fast_food" ? "fast-food" : "restaurant";
    kind = { type, categories: [], restroomsVerified: toiletsYes ? true : null, qualityScoreMock: 0.6, unnamedLabel: amenity === "food_court" ? "Food court" : undefined };
    cats.add("meal");
    if (toiletsYes || amenity === "food_court") cats.add("restroom");
    if (list(tags.cuisine).some((c) => ["coffee_shop", "donut"].includes(c))) cats.add("coffee");
  } else if (amenity === "cafe") {
    kind = { type: "cafe", categories: [], restroomsVerified: toiletsYes ? true : null, qualityScoreMock: 0.6 };
    cats.add("coffee");
    if (list(tags.cuisine).some((c) => ["sandwich", "sandwiches", "bakery", "bagel", "breakfast"].includes(c))) cats.add("meal");
    if (toiletsYes) cats.add("restroom");
  } else if (amenity === "fuel") {
    kind = { type: "gas-station", categories: [], restroomsVerified: toiletsYes ? true : null, qualityScoreMock: 0.55 };
    if (toiletsYes) cats.add("restroom");
    if (shop === "convenience") cats.add("grocery");
  } else if (shop && GROCERY_SHOPS.includes(shop)) {
    kind = { type: shop === "convenience" ? "convenience" : "grocery", categories: [], restroomsVerified: toiletsYes ? true : null, qualityScoreMock: shop === "convenience" ? 0.55 : 0.6 };
    cats.add("grocery");
    if (toiletsYes) cats.add("restroom");
  } else if (amenity === "charging_station") {
    if (["private", "no"].includes(tags.access ?? "")) return null;
    kind = { type: "ev-charger", categories: [], restroomsVerified: toiletsYes ? true : null, qualityScoreMock: 0.6, unnamedLabel: "EV charging station" };
    cats.add("ev_charge");
    if (toiletsYes) cats.add("restroom");
  } else {
    return null;
  }
  kind.categories = [...cats];
  return kind;
}

/** accessMinutes = straight-line off-route km × 1.4 road factor ÷ 40 km/h × 2 ways + 2 min ramp (min 2). */
export function accessMinutesFor(offRouteKm: number): number {
  const m = ((offRouteKm * 1.4) / 40) * 60 * 2 + 2;
  return Math.max(2, Math.round(m * 10) / 10);
}

export interface PlaceElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Tags;
}

export interface RouteAnchor {
  distanceAlongRouteKm: number;
  offRouteKm: number;
  exitId: string;
  exitLabel: string;
  exitKm: number;
}

/**
 * Place a lat/lng on the route: projected km, off-route km, nearest exit (or synthetic
 * `km-N` / "Near km N" when the route has no exits). distanceAlongRouteKm snaps to the exit km
 * when the projection is within 3 km of it. Shared by OSM and TomTom mapping.
 */
export function anchorOnRoute(route: RouteModel, lat: number, lng: number): RouteAnchor {
  const { km, offRouteKm } = route.nearestKm(lat, lng);
  const exit: RouteExit | null = route.nearestExit(km);
  const useExit = exit !== null && Math.abs(exit.km - km) <= 3;
  return {
    distanceAlongRouteKm: Math.round((useExit ? exit!.km : km) * 100) / 100,
    offRouteKm: Math.round(offRouteKm * 100) / 100,
    exitId: exit ? exit.id : `km-${Math.round(km)}`,
    exitLabel: exit ? exitLabel(exit) : `Near km ${Math.round(km)}`,
    exitKm: exit ? exit.km : Math.round(km * 10) / 10
  };
}

/** Map one Overpass element to a StopCandidate (null = skip). */
export function elementToCandidate(
  el: PlaceElement,
  route: RouteModel,
  meta: { provenance: "live" | "cached"; fetchedAt: string }
): StopCandidate | null {
  const tags = el.tags ?? {};
  const lat = el.lat ?? el.center?.lat;
  const lng = el.lon ?? el.center?.lon;
  if (lat === undefined || lng === undefined) return null;
  const kind = classifyTags(tags);
  if (!kind) return null;
  const evName = kind.type === "ev-charger" ? (tags.operator ?? tags.brand) : undefined;
  // Unnamed restaurants/cafes/shops/fuel are skipped; generic labels only for public facilities.
  const finalName = tags.name ?? tags["name:en"] ?? evName ?? kind.unnamedLabel;
  if (!finalName) return null;

  const anchor = anchorOnRoute(route, lat, lng);
  const offRouteKm = anchor.offRouteKm;
  const hours = parseOpeningHours(tags.opening_hours);
  const veg = vegOptionsFromTags(tags);
  const dietary = dietaryFromTags(tags);
  const chargers = kind.type === "ev-charger" ? chargersFromTags(tags) : [];
  const osmId = `${el.type}/${el.id}`;

  const c: StopCandidate = {
    id: `osm-${el.type}-${el.id}`,
    name: finalName,
    type: kind.type,
    categories: kind.categories,
    region: "",
    exitId: anchor.exitId,
    exitLabel: anchor.exitLabel,
    exitKm: anchor.exitKm,
    distanceAlongRouteKm: anchor.distanceAlongRouteKm,
    lat,
    lng,
    isMock: false,
    source: "osm",
    provenance: meta.provenance,
    fetchedAt: meta.fetchedAt,
    osmId,
    brand: tags.brand ?? tags.name,
    hoursVerified: hours.hoursVerified,
    offRouteKm,
    vegetarianVerified: dietary.includes("vegetarian") || dietary.includes("vegan") ? true : null,
    restroomsVerified: kind.restroomsVerified,
    parkingVerified: null,
    qualityScoreMock: kind.qualityScoreMock,
    open24h: hours.open24h,
    accessMinutes: accessMinutesFor(offRouteKm),
    reviewCountMock: undefined
  };
  if (hours.openingHoursRaw) c.openingHoursRaw = hours.openingHoursRaw;
  if (hours.opensLocal) c.opensLocal = hours.opensLocal;
  if (hours.closesLocal) c.closesLocal = hours.closesLocal;
  if (veg && kind.categories.includes("meal")) {
    c.vegOptions = veg.level;
    c.vegOptionsNote = veg.note;
  }
  if (dietary.length) c.dietaryVerified = dietary;
  if (chargers.length) c.chargers = chargers;
  return c;
}

/** Relevance: serves more of the requested needs, has a real name, closer to the road. */
export function relevance(c: StopCandidate, needs: Need[], named: boolean): number {
  const served = c.categories.filter((n) => needs.includes(n)).length;
  return served * 10 + (named ? 2 : 0) - (c.offRouteKm ?? 0);
}

// ---------------------------------------------------------------------------------------------
// Query building
// ---------------------------------------------------------------------------------------------

export interface QueryCenter {
  lat: number;
  lng: number;
  radiusM: number;
  label: string;
}

const pickEvenly = <T,>(xs: T[], n: number): T[] => {
  if (xs.length <= n) return xs;
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(xs[Math.round((i * (xs.length - 1)) / (n - 1))]);
  return out;
};

/** Centers for the window: exits inside it (≤ MAX_EXITS), else route samples every SAMPLE_STEP_KM. */
export function windowCenters(route: RouteModel, window: { minKm: number; maxKm: number }): QueryCenter[] {
  const exits = route.exits().filter((e) => e.km >= window.minKm && e.km <= window.maxKm);
  if (exits.length > 0) {
    return pickEvenly(exits, MAX_EXITS).map((e) => ({ lat: e.lat, lng: e.lng, radiusM: EXIT_RADIUS_M, label: `exit ${e.ref ?? e.id} @${e.km.toFixed(1)}km` }));
  }
  const samples = pickEvenly(route.sample(window.minKm, window.maxKm, SAMPLE_STEP_KM), MAX_SAMPLES);
  return samples.map((p) => ({ lat: p.lat, lng: p.lng, radiusM: SAMPLE_RADIUS_M, label: `km ${p.km.toFixed(1)}` }));
}

/** OSM selectors (without the around: filter) needed to cover `needs`. */
export function selectorsFor(needs: Need[]): string[] {
  const n = new Set(needs.length ? needs : DEFAULT_NEEDS);
  const amenities = new Set<string>();
  const sel: string[] = [];
  if (n.has("meal")) ["restaurant", "fast_food", "food_court"].forEach((a) => amenities.add(a));
  if (n.has("coffee")) amenities.add("cafe");
  if (n.has("restroom")) amenities.add("toilets");
  if (n.has("ev_charge")) amenities.add("charging_station");
  if (amenities.size) sel.push(`nwr["amenity"~"^(${[...amenities].join("|")})$"]`);
  if (n.has("meal") || n.has("coffee") || n.has("restroom")) sel.push(`nwr["highway"~"^(services${n.has("restroom") ? "|rest_area" : ""})$"]`);
  if (n.has("restroom")) sel.push(`nwr["amenity"="fuel"]["toilets"="yes"]`);
  if (n.has("grocery")) sel.push(`nwr["shop"~"^(${GROCERY_SHOPS.join("|")})$"]`);
  return sel;
}

export function buildOverpassQuery(centers: QueryCenter[], needs: Need[]): string {
  const sel = selectorsFor(needs);
  const lines: string[] = [];
  for (const c of centers) {
    const around = `(around:${c.radiusM},${c.lat.toFixed(5)},${c.lng.toFixed(5)})`;
    for (const s of sel) lines.push(`  ${s}${around};`);
  }
  return `[out:json][timeout:25];\n(\n${lines.join("\n")}\n);\nout center tags;`;
}

export function placesCacheKey(routeId: string, window: { minKm: number; maxKm: number }, needs: Need[]): string {
  const n = [...new Set(needs.length ? needs : DEFAULT_NEEDS)].sort().join(",");
  return `osm-places:${routeId}:${Math.round(window.minKm)}-${Math.round(window.maxKm)}:${n}`;
}

// ---------------------------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------------------------

export interface OsmDiscovery {
  candidates: StopCandidate[];
  provenance: "live" | "cached";
  query: string;
  trace: string[];
  elementCount: number;
}

/**
 * Discover real places for ONE km window. Throws (OverpassUnavailableError) when Overpass is
 * unavailable or over budget — callers decide on a fallback; nothing is fabricated here.
 */
export async function discoverOsmPlaces(
  route: RouteModel,
  window: { minKm: number; maxKm: number },
  needs: Need[],
  opts: { sessionId?: string; fetchImpl?: typeof fetch } = {}
): Promise<OsmDiscovery> {
  const minKm = route.clampKm(Math.min(window.minKm, window.maxKm));
  const maxKm = route.clampKm(Math.max(window.minKm, window.maxKm));
  const effNeeds = needs.length ? needs : DEFAULT_NEEDS;
  const trace: string[] = [];
  const centers = windowCenters(route, { minKm, maxKm });
  const query = buildOverpassQuery(centers, effNeeds);
  const cacheKey = placesCacheKey(route.id, { minKm, maxKm }, effNeeds);
  trace.push(
    `osm: window km ${minKm.toFixed(0)}–${maxKm.toFixed(0)}, needs [${effNeeds.join(", ")}], ${centers.length} search point(s): ${centers.map((c) => c.label).join("; ")}`
  );
  const res = await overpassQuery(query, { cacheKey, sessionId: opts.sessionId, fetchImpl: opts.fetchImpl });

  const seen = new Set<string>();
  const scored: Array<{ c: StopCandidate; score: number }> = [];
  let skipped = 0;
  for (const el of res.elements) {
    const c = elementToCandidate(el, route, res);
    if (!c || seen.has(c.osmId!)) {
      skipped++;
      continue;
    }
    seen.add(c.osmId!);
    if ((c.offRouteKm ?? 0) > MAX_OFF_ROUTE_KM) {
      skipped++;
      continue;
    }
    if (c.distanceAlongRouteKm < minKm - 3 || c.distanceAlongRouteKm > maxKm + 3) {
      skipped++;
      continue;
    }
    if (!c.categories.some((n) => effNeeds.includes(n))) {
      skipped++;
      continue;
    }
    scored.push({ c, score: relevance(c, effNeeds, Boolean(el.tags?.name)) });
  }
  scored.sort((a, b) => b.score - a.score || a.c.distanceAlongRouteKm - b.c.distanceAlongRouteKm);
  const candidates = scored.slice(0, MAX_CANDIDATES).map((s) => s.c);
  trace.push(
    `osm: ${res.elements.length} element(s) (${res.provenance}), ${scored.length} relevant, ${skipped} skipped, returning ${candidates.length}${scored.length > MAX_CANDIDATES ? ` (capped at ${MAX_CANDIDATES})` : ""}`
  );
  return { candidates, provenance: res.provenance, query, trace, elementCount: res.elements.length };
}
