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
  lastMealMinutesAgo: z.number().min(0).nullable().optional()
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
