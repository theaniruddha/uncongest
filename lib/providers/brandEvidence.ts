import type { EvidenceLevel, PlaceEvidence } from "@/lib/domain/types";

/**
 * Small curated table of common North American chains → CHAIN-LEVEL evidence.
 * Chain-level means "typical for the brand", never location-verified, so the strongest level
 * given here is "possible". No menu items are listed (menus change; we only cite the official
 * site's domain root). Halal / gluten-free are left unknown: nothing here is genuinely chain-wide.
 */

export type ServiceKind = NonNullable<PlaceEvidence["service"]>;

export const CHAIN_VEG_SOURCE = "chain's official menu lists vegetarian items (not location-verified)";
export const CHAIN_RESTROOM_SOURCE = "chain-level typical, not location-verified";

export interface BrandProfile {
  /** Display brand. */
  brand: string;
  /** Lower-case names/brands that match (after normalising apostrophes, accents and spacing). */
  match: string[];
  /** OSM brand:wikidata ids — only ones we are confident about. */
  wikidata?: string[];
  service: ServiceKind;
  /** Serves coffee as a main offering. */
  coffee: boolean;
  /** Serves meals (not just snacks). */
  meal: boolean;
  vegetarian: Extract<EvidenceLevel, "possible" | "unknown">;
  /** Override for vegetarian evidence source (default CHAIN_VEG_SOURCE). */
  vegSource?: string;
  /**
   * Customer washrooms: "possible" = typical for the chain; "if_shop" = only when the
   * location is a staffed fuel station with a convenience shop; "unknown" otherwise.
   */
  restroom: "possible" | "if_shop" | "unknown";
  /** Official site domain root only (no deep links). */
  url?: string;
}

const qs = (brand: string, match: string[], o: Partial<BrandProfile> = {}): BrandProfile => ({
  brand,
  match,
  service: "quick_service",
  coffee: false,
  meal: true,
  vegetarian: "possible",
  restroom: "possible",
  ...o
});
const fuel = (brand: string, match: string[], o: Partial<BrandProfile> = {}): BrandProfile => ({
  brand,
  match,
  service: "fuel",
  coffee: false,
  meal: false,
  vegetarian: "unknown",
  restroom: "if_shop",
  ...o
});

export const BRAND_PROFILES: BrandProfile[] = [
  qs("Tim Hortons", ["tim hortons", "tim horton's", "tim hortons cafe & bake shop"], { wikidata: ["Q175106"], coffee: true, url: "https://www.timhortons.ca" }),
  qs("Subway", ["subway"], { wikidata: ["Q244457"], url: "https://www.subway.com" }),
  qs("McDonald's", ["mcdonald's", "mcdonalds"], { wikidata: ["Q38076"], coffee: true, url: "https://www.mcdonalds.com" }),
  qs("A&W", ["a&w", "a & w", "a and w"], { url: "https://www.aw.ca" }),
  qs("Starbucks", ["starbucks", "starbucks coffee"], { wikidata: ["Q37158"], service: "cafe", coffee: true, meal: false, url: "https://www.starbucks.com" }),
  qs("Wendy's", ["wendy's", "wendys"], { wikidata: ["Q550258"], url: "https://www.wendys.com" }),
  qs("Burger King", ["burger king"], { wikidata: ["Q177054"], url: "https://www.bk.com" }),
  qs("Pizza Pizza", ["pizza pizza"], { url: "https://www.pizzapizza.ca" }),
  qs("Harvey's", ["harvey's", "harveys"], { url: "https://www.harveys.ca" }),
  qs("Second Cup", ["second cup", "second cup coffee co."], { service: "cafe", coffee: true, meal: false, url: "https://www.secondcup.com" }),
  qs("Dunkin'", ["dunkin'", "dunkin", "dunkin donuts", "dunkin' donuts"], { service: "cafe", coffee: true, meal: false, url: "https://www.dunkindonuts.com" }),
  qs("Panera Bread", ["panera bread", "panera"], { coffee: true, url: "https://www.panerabread.com" }),
  qs("Chipotle", ["chipotle", "chipotle mexican grill"], { wikidata: ["Q465751"], url: "https://www.chipotle.com" }),
  qs("Taco Bell", ["taco bell"], { wikidata: ["Q752941"], url: "https://www.tacobell.com" }),
  {
    brand: "Walmart",
    match: ["walmart", "walmart supercentre", "walmart supercenter"],
    wikidata: ["Q483551"],
    service: "big_box",
    coffee: false,
    meal: false,
    vegetarian: "unknown",
    restroom: "possible"
  },
  {
    brand: "Costco",
    match: ["costco", "costco wholesale"],
    wikidata: ["Q715583"],
    service: "big_box",
    coffee: false,
    meal: false,
    vegetarian: "unknown",
    restroom: "possible"
  },
  {
    brand: "ONroute",
    match: ["onroute"],
    service: "plaza",
    coffee: true,
    meal: true,
    vegetarian: "possible",
    vegSource: "service plaza with several chain counters (not location-verified)",
    restroom: "possible",
    url: "https://www.onroute.ca"
  },
  fuel("Petro-Canada", ["petro-canada", "petro canada", "petrocanada"]),
  fuel("Esso", ["esso"]),
  fuel("Circle K", ["circle k"]),
  fuel("Shell", ["shell"]),
  fuel("Sunoco", ["sunoco"])
];

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2018\u2019`\u00b4]/g, "'")
    .replace(/\s+/g, " ")
    .trim();

/** Match OSM tags (brand:wikidata, brand, name) against the table. */
export function matchBrand(tags: Record<string, string>): BrandProfile | null {
  const qid = tags["brand:wikidata"];
  if (qid) {
    const byQid = BRAND_PROFILES.find((p) => p.wikidata?.includes(qid));
    if (byQid) return byQid;
  }
  for (const v of [tags.brand, tags.name, tags["name:en"]]) {
    if (!v) continue;
    const n = norm(v);
    const hit = BRAND_PROFILES.find((p) => p.match.some((m) => n === m || n.startsWith(`${m} `)));
    if (hit) return hit;
  }
  return null;
}

/** Match a free-text name (e.g. a TomTom POI name). */
export function matchBrandName(name: string | undefined): BrandProfile | null {
  return name ? matchBrand({ name }) : null;
}
