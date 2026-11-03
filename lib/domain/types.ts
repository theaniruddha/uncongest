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
}

export interface TripContext {
  destination: string;
  direction: "eastbound" | "westbound";
  highway: string;
  elapsedMinutes: number;
  localTime: string;
  minutesSinceLastStop?: number;
}

export interface CollectiveIntent {
  need: Need[];
  hungerLevel: 0 | 1 | 2 | 3;
  dietary: Dietary[];
  maxDetourMinutes: number;
  kids: boolean;
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
  distanceAlongRouteKm: number;
  lat: number;
  lng: number;
  isMock: true;
  vegetarianVerified: boolean | null;
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
  mock: true;
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
}

export interface RecommendStopsRequest {
  trip: TripContext;
  config: TripConfig;
  cars: CarState[];
  collectiveIntent: CollectiveIntent;
  environment: Environment;
}
