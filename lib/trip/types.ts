import { z } from "zod";
import { dietarySchema, needSchema } from "@/lib/domain/schemas";

/**
 * Shared contracts for the configurable real-data trip simulator (/trip).
 * Everything crossing a module or network boundary is described here with Zod.
 */

export const placeTypeSchema = z.enum(["home", "hotel", "other"]);
export type PlaceType = z.infer<typeof placeTypeSchema>;

export const placeRefSchema = z.object({
  label: z.string().min(1).max(200),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  type: placeTypeSchema.default("other"),
  source: z.enum(["search", "current_location", "preset"]).default("search")
});
export type PlaceRef = z.infer<typeof placeRefSchema>;

export const moodSchema = z.enum(["relaxed", "tired", "hungry", "hurry"]);
export const mealPreferenceSchema = z.enum(["auto", "quick_bite", "proper_meal", "coffee", "custom"]);
export const mealHistorySchema = z.object({
  kind: z.enum(["unknown", "already_ate", "last_meal_at"]),
  /** Local HH:mm of the last confirmed meal when kind = last_meal_at. */
  time: z.string().regex(/^\d{2}:\d{2}$/).optional()
});

export const carSetupSchema = z.object({
  id: z.enum(["car_a", "car_b", "car_c"]),
  label: z.string().min(1).max(40),
  adults: z.number().int().min(1).max(8).default(2),
  kids: z.number().int().min(0).max(8).default(0),
  dietary: z.array(dietarySchema).default([]),
  speedKph: z.number().min(40).max(130).default(100),
  /** Minutes this car starts behind the lead (0 = together). */
  startOffsetMinutes: z.number().min(0).max(120).default(0),
  initialNeeds: z.array(needSchema).default([])
});
export type CarSetup = z.infer<typeof carSetupSchema>;

export const tripSetupSchema = z.object({
  origin: placeRefSchema,
  destination: placeRefSchema,
  departure: z.object({
    mode: z.enum(["depart_at", "arrive_by"]),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    time: z.string().regex(/^\d{2}:\d{2}$/)
  }),
  mood: z.array(moodSchema).max(4).default(["relaxed"]),
  mealPreference: mealPreferenceSchema.default("auto"),
  customMeal: z.string().max(120).optional(),
  mealHistory: mealHistorySchema.default({ kind: "unknown" }),
  maxDetourMinutes: z.number().min(0).max(45).default(12),
  cars: z.array(carSetupSchema).min(1).max(3),
  scenarioText: z.string().max(600).optional(),
  /** "real" = real places/weather where available; "demo" = labelled fictional fixtures (401 only). */
  dataMode: z.enum(["real", "demo"]).default("real")
});
export type TripSetup = z.infer<typeof tripSetupSchema>;

/** A resolved real route, as returned by /api/route and consumed by createRouteModel(). */
export const tripRouteSchema = z.object({
  id: z.string().min(1),
  origin: placeRefSchema,
  destination: placeRefSchema,
  coordinates: z.array(z.tuple([z.number(), z.number()])).min(2),
  exits: z.array(
    z.object({
      id: z.string(),
      ref: z.string().nullable(),
      name: z.string().nullable(),
      exitTo: z.string().nullable(),
      lat: z.number(),
      lng: z.number(),
      km: z.number()
    })
  ),
  distanceKm: z.number().positive(),
  durationMinutes: z.number().positive(),
  source: z.enum(["osrm", "cache", "fixture"]),
  /** IANA time zone of the origin (sim clock + weather + daylight). */
  timezone: z.string().default("America/Toronto"),
  fetchedAt: z.string(),
  attribution: z.string()
});
export type TripRoute = z.infer<typeof tripRouteSchema>;

/** Stop lifecycle: PROPOSED → SELECTED → EN_ROUTE → ARRIVED → COMPLETED → RESUMED. */
export const stopStatusSchema = z.enum(["PROPOSED", "SELECTED", "EN_ROUTE", "ARRIVED", "COMPLETED", "RESUMED", "CANCELLED"]);
export type StopStatus = z.infer<typeof stopStatusSchema>;

export interface StopPlan {
  stopId: string;
  name: string;
  /** km along route of the stop's access point. */
  km: number;
  lat: number;
  lng: number;
  categories: string[];
  status: StopStatus;
  /** Extra driving off/on the highway (both ways), minutes. */
  detourMinutes: number;
  /** Planned time at the stop, minutes (editable). */
  plannedDwellMinutes: number;
  /** Cars taking part (independent participation). */
  participants: string[];
  selectedAtElapsed?: number;
  arrivedAtElapsed?: number;
  departedAtElapsed?: number;
  actualDwellMinutes?: number;
  /** Needs the user explicitly confirmed as satisfied at completion — never inferred. */
  satisfiedNeeds: string[];
}

export const dataProvenanceSchema = z.enum(["live", "cached", "fixture", "simulated", "unavailable"]);
export type DataProvenance = z.infer<typeof dataProvenanceSchema>;

export interface ProviderUsage {
  provider: string;
  enabled: boolean;
  usedInWindow: number;
  windowLimit: number;
  usedThisSession: number;
  sessionLimit: number;
  cacheHits: number;
  lastError?: string;
}
