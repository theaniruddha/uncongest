export type Need = "meal" | "coffee" | "restroom" | "ev_charge" | "grocery";
export type Dietary = "vegetarian" | "vegan" | "halal" | "gluten_free";
export type Weather = "sunny" | "cloudy" | "rain" | "snow" | "cold";
export type DecisionAction = "STAY_SILENT" | "PROPOSE_STOP" | "REPLAN" | "ESCALATE_TO_PASSENGER";
export type RecommendationKind = "FASTEST" | "BEST_FIT" | "ALTERNATIVE";

export interface CarState {
  id: string;
  label: string;
  role: "lead" | "passenger";
  progressKm: number;
  speedKph: number;
  passengers: number;
  kids: boolean;
  ev: boolean;
  connector?: "NACS" | "CCS1";
  batteryPercent?: number;
  positionUpdatedMinutesAgo: number;
  needs: Need[];
  lat?: number;
  lng?: number;
  headingDeg?: number;
}

export interface TripContext {
  destination: string;
  direction: string;
  highway: string;
  elapsedMinutes: number;
  localTime: string;
  minutesSinceLastStop?: number;
  localDate?: string;
  lastMealMinutesAgo?: number | null;
  /** Set when the watcher found a final good opportunity before a long gap during the early quiet window. */
  overrideInitialQuiet?: boolean;
}

export interface CollectiveIntent {
  need: Need[];
  hungerLevel: 0 | 1 | 2 | 3;
  dietary: Dietary[];
  maxDetourMinutes: number;
  kids: boolean;
  restroomUrgent?: boolean;
  notHungry?: boolean;
}

export interface Environment {
  weather: Weather;
  trafficDelayMinutes: number;
  daylightMinutes: number;
}

export interface TripConfig {
  avoidRegion: string | null;
  noOptionalStopsFirstMinutes: number;
  maximumDetourMinutesPerCar: number;
  maximumRegroupWaitMinutes: number;
  advanceNoticeMinutes: number;
  requiredDiet: Dietary[];
  groceriesCompleted: boolean;
  passengerLed: boolean;
}

export interface ChargerSpec {
  connector: "NACS" | "CCS1";
  powerKw: number;
  count: number;
}

export interface StopCandidate {
  id: string;
  name: string;
  type: string;
  categories: Need[];
  region: string;
  exitId: string;
  /** Human label of the nearest real exit, e.g. "Exit 543 (Belleville)". */
  exitLabel?: string;
  exitKm?: number;
  distanceAlongRouteKm: number;
  lat: number;
  lng: number;
  /** true = fictional fixture (demo mode). Real places (OSM/TomTom) are false. */
  isMock: boolean;
  /** Where this candidate came from. Absent on legacy fixtures (= "fixture"). */
  source?: "fixture" | "osm" | "tomtom";
  provenance?: "live" | "cached" | "fixture";
  fetchedAt?: string;
  osmId?: string;
  brand?: string;
  /** Raw OSM opening_hours (or provider text); unparsed hours are "unverified", never assumed. */
  openingHoursRaw?: string;
  hoursVerified?: boolean;
  /** Straight-line distance from the route to the place, km. */
  offRouteKm?: number;
  /** Evidence about facilities/diet: verified (explicit data), possible (chain-level / indirect), unsuitable, unknown. */
  evidence?: PlaceEvidence;
  vegetarianVerified: boolean | null;
  /**
   * How veg-friendly the menu is (meal stops only). Vegetarian/vegan is a preference, not a filter:
   * "poor" (steakhouse, bar-style diner) is excluded; "some" (Subway-style chains, plazas) is fine.
   */
  vegOptions?: "dedicated" | "good" | "some" | "poor";
  vegOptionsNote?: string;
  dietaryVerified?: Dietary[];
  restroomsVerified: boolean | null;
  parkingVerified: boolean | null;
  qualityScoreMock: number;
  open24h: boolean;
  opensLocal?: string;
  closesLocal?: string;
  accessMinutes: number;
  reviewCountMock?: number;
  congestionNoteMock?: string;
  chargers?: ChargerSpec[];
}

export type EvidenceLevel = "verified" | "possible" | "unsuitable" | "unknown";
export interface EvidenceItem {
  level: EvidenceLevel;
  /** Where it came from: "osm:diet:vegetarian=yes", "chain menu (official site)", "tomtom", … */
  source: string;
  note?: string;
  url?: string;
}
export interface PlaceEvidence {
  restroom?: EvidenceItem;
  accessibleRestroom?: EvidenceItem;
  vegetarian?: EvidenceItem;
  vegan?: EvidenceItem;
  halal?: EvidenceItem;
  gluten_free?: EvidenceItem;
  /** Rough kind of food service, for "quick bite" vs "proper meal" matching. */
  service?: "quick_service" | "sit_down" | "cafe" | "convenience" | "fuel" | "big_box" | "plaza" | "rest_area" | "other";
}

export interface RejectionReason {
  stopId: string;
  reasons: string[];
}

export interface EligibleStop {
  stop: StopCandidate;
  tier: "primary" | "fallback";
  minutesAheadForLead: number;
  detourMinutesByCar: Record<string, number>;
  arrivalMinutesFromNowByCar: Record<string, number>;
  maxGroupWaitMinutes: number;
  score: number;
  scoreBreakdown: {
    groupDetour: number;
    maxWait: number;
    quality: number;
    unmetNeeds: number;
  };
}

export interface Recommendation {
  kind: RecommendationKind;
  stopId: string;
  name: string;
  rank: number;
  reason: string;
  tradeoffs: string[];
  detourMinutesByCar: Record<string, number>;
  arrivalMinutesFromNowByCar: Record<string, number>;
  maxGroupWaitMinutes: number;
  confidence: number;
  risks: string[];
  mapsUrl: string;
  requiresApproval: boolean;
  mock: boolean;
  source?: "fixture" | "osm" | "tomtom";
}

export interface EngineResult {
  action: DecisionAction;
  recommendations: Recommendation[];
  rejected: RejectionReason[];
  triggerReasons: string[];
  understood: string[];
  exploration: string[];
  verifiedChecks: string[];
  provider: string;
  isMock: boolean;
  decidedAtLocal: string;
  /** Deterministic urgency used to bound exploration. */
  urgency?: { level: "none" | "low" | "moderate" | "high"; reasons: string[]; needs: Need[]; reminderOnly: boolean };
  /** Weather at each car now and at each recommended stop at the lead car's ETA. */
  weather?: { mode: "live" | "simulated"; cars: WeatherSnapshot[]; stops: WeatherSnapshot[] };
  /** Spoken/short message for solo/driver mode. */
  speakMessage?: string;
  toolTrace?: ToolTraceEntry[];
  usage?: Array<{ provider: string; enabled: boolean; usedInWindow: number; windowLimit: number; usedThisSession: number; sessionLimit: number; cacheHits: number; lastError?: string }>;
}

export interface WeatherSnapshot {
  id: string;
  condition: Weather;
  tempC: number | null;
  precipProbability: number | null;
  description: string;
  source: "open-meteo" | "simulated" | "unavailable";
  forHour: string;
  stale: boolean;
  note?: string;
}

export interface RecommendStopsRequest {
  trip: TripContext;
  config: TripConfig;
  cars: CarState[];
  collectiveIntent: CollectiveIntent;
  environment: Environment;
  options?: { weatherMode: "live" | "simulated"; excludeStopIds: string[] };
  context?: {
    route: { id: string; origin: { label: string; lat: number; lng: number; type: "home" | "hotel" | "other" }; destination: { label: string; lat: number; lng: number; type: "home" | "hotel" | "other" }; via?: Array<{ lat: number; lng: number }> };
    sessionId: string;
    dataMode: "real" | "demo";
    timeZone: string;
    mood: Array<"relaxed" | "tired" | "hungry" | "hurry">;
    mealPreference: "auto" | "quick_bite" | "proper_meal" | "coffee" | "custom";
    customMeal?: string;
    agentContext?: Record<string, unknown>;
    tomtomVerifyTop: number;
    workflow: "tactical" | "classic";
    contextVersion?: string;
    strategicHints: Array<{ id: string; kind: string; title: string; fromKm: number; toKm: number; candidateIds: string[]; priority: string; watchFor?: string }>;
  };
}

/** One auditable step taken while deciding (shown in the inspector). */
export interface ToolTraceEntry {
  tool: string;
  input: string;
  output: string;
  provenance?: "live" | "cached" | "fixture" | "simulated" | "unavailable" | "skipped";
  ms?: number;
}
