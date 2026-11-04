import { z } from "zod";

export const needSchema = z.enum(["meal", "coffee", "restroom", "ev_charge", "grocery"]);
export const dietarySchema = z.enum(["vegetarian", "vegan", "halal", "gluten_free"]);
export const weatherSchema = z.enum(["sunny", "cloudy", "rain", "snow", "cold"]);

export const carSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  role: z.enum(["lead", "passenger"]),
  progressKm: z.number().min(0),
  speedKph: z.number().min(0).max(200),
  passengers: z.number().int().min(1).max(8),
  kids: z.boolean(),
  ev: z.boolean(),
  connector: z.enum(["NACS", "CCS1"]).optional(),
  batteryPercent: z.number().min(0).max(100).optional(),
  positionUpdatedMinutesAgo: z.number().min(0),
  needs: z.array(needSchema),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  headingDeg: z.number().min(0).max(360).optional()
});

export const tripContextSchema = z.object({
  destination: z.string().min(1),
  direction: z.string().min(1).max(40),
  highway: z.string().min(1),
  elapsedMinutes: z.number().min(0),
  localTime: z.string().regex(/^\d{2}:\d{2}$/),
  minutesSinceLastStop: z.number().min(0).optional(),
  /** Local calendar date (America/Toronto) of the simulated/live clock; used for weather lookup. */
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** Minutes since last confirmed meal; null/absent = unknown (never assumed). */
  lastMealMinutesAgo: z.number().min(0).nullable().optional(),
  overrideInitialQuiet: z.boolean().optional()
});

export const tripConfigSchema = z.object({
  avoidRegion: z.string().nullable(),
  noOptionalStopsFirstMinutes: z.number().min(0),
  maximumDetourMinutesPerCar: z.number().min(0),
  maximumRegroupWaitMinutes: z.number().min(0),
  advanceNoticeMinutes: z.number().min(0),
  requiredDiet: z.array(dietarySchema),
  groceriesCompleted: z.boolean(),
  passengerLed: z.boolean()
});

export const collectiveIntentSchema = z.object({
  need: z.array(needSchema),
  hungerLevel: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  dietary: z.array(dietarySchema),
  maxDetourMinutes: z.number().min(0),
  kids: z.boolean(),
  restroomUrgent: z.boolean().optional(),
  notHungry: z.boolean().optional()
});

export const environmentSchema = z.object({
  weather: weatherSchema,
  trafficDelayMinutes: z.number().min(0),
  daylightMinutes: z.number().min(0)
});

export const recommendStopsRequestSchema = z.object({
  trip: tripContextSchema,
  config: tripConfigSchema,
  cars: z.array(carSchema).min(1).max(3),
  collectiveIntent: collectiveIntentSchema,
  environment: environmentSchema,
  /** Real-data trip context (/trip). Absent for the legacy 401 demo page. */
  context: z
    .object({
      route: z.object({
        id: z.string().min(1).max(120),
        origin: z.object({ label: z.string().max(200), lat: z.number(), lng: z.number(), type: z.enum(["home", "hotel", "other"]).default("other") }),
        destination: z.object({ label: z.string().max(200), lat: z.number(), lng: z.number(), type: z.enum(["home", "hotel", "other"]).default("other") }),
        via: z.array(z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) })).max(2).optional()
      }),
      sessionId: z.string().min(1).max(64).default("anon"),
      dataMode: z.enum(["real", "demo"]).default("real"),
      timeZone: z.string().min(1).max(64).default("America/Toronto"),
      mood: z.array(z.enum(["relaxed", "tired", "hungry", "hurry"])).max(4).default([]),
      mealPreference: z.enum(["auto", "quick_bite", "proper_meal", "coffee", "custom"]).default("auto"),
      customMeal: z.string().max(120).optional(),
      /** Compact relevance-aware context from lib/context/builder.ts (already filtered client-side). */
      agentContext: z.record(z.unknown()).optional(),
      /** Opt-in TomTom verification of the top N candidates (still budgeted server-side). */
      tomtomVerifyTop: z.number().int().min(0).max(3).default(0),
      /** "tactical" = Agent 2 Tactical workflow (5 s deadline, cached data only); "classic" = original path. */
      workflow: z.enum(["tactical", "classic"]).default("classic"),
      /** Client's context version; echoed back so late results can be recognised as stale. */
      contextVersion: z.string().max(80).optional(),
      strategicHints: z
        .array(
          z.object({
            id: z.string().max(80),
            kind: z.string().max(40),
            title: z.string().max(140),
            fromKm: z.number(),
            toKm: z.number(),
            candidateIds: z.array(z.string().max(120)).max(8),
            priority: z.string().max(10),
            watchFor: z.string().max(200).optional()
          })
        )
        .max(6)
        .default([])
    })
    .optional(),
  options: z
    .object({
      weatherMode: z.enum(["live", "simulated"]).default("simulated"),
      /** Stops the group skipped; excluded until the user reverses it. */
      excludeStopIds: z.array(z.string()).max(50).default([])
    })
    .optional()
});

export const llmDecisionSchema = z.object({
  action: z.enum(["STAY_SILENT", "PROPOSE_STOP", "REPLAN", "ESCALATE_TO_PASSENGER"]),
  picks: z
    .array(
      z.object({
        stopId: z.string().min(1),
        kind: z.enum(["FASTEST", "BEST_FIT", "ALTERNATIVE"]).optional(),
        reason: z.string().min(1).max(600),
        tradeoffs: z.array(z.string()).max(6)
      })
    )
    .max(3),
  speakMessage: z.string().max(300).optional()
});

export type LlmDecision = z.infer<typeof llmDecisionSchema>;
