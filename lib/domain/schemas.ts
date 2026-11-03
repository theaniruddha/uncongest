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
  needs: z.array(needSchema)
});

export const tripContextSchema = z.object({
  destination: z.string().min(1),
  direction: z.enum(["eastbound", "westbound"]),
  highway: z.string().min(1),
  elapsedMinutes: z.number().min(0),
  localTime: z.string().regex(/^\d{2}:\d{2}$/),
  minutesSinceLastStop: z.number().min(0).optional()
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
  kids: z.boolean()
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
  environment: environmentSchema
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
