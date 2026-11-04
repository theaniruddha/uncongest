import { safeLlmError } from "@/lib/agent2/llmSafety";
import { z } from "zod";
import { dietarySchema, needSchema } from "@/lib/domain/schemas";
import { mealHistorySchema, mealPreferenceSchema, moodSchema, tripSetupSchema, type TripSetup } from "@/lib/trip/types";
import { extractJson, getLlmClient } from "./ai";

/**
 * Agent 1 extension — custom scenario interpreter.
 * Turns a free-text trip description into SUGGESTED setup changes for the /trip form.
 * Safety: never emits coordinates or geometry. Origin/destination come back only as free-text
 * queries that the UI geocodes and the user confirms. One bounded LLM call; deterministic
 * keyword fallback when no model is configured or the call/validation fails.
 */

export const scenarioRequestSchema = z.object({
  text: z.string().trim().min(1).max(600),
  current: tripSetupSchema,
  todayLocalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  localTime: z.string().regex(/^\d{2}:\d{2}$/)
});
export type ScenarioRequest = z.infer<typeof scenarioRequestSchema>;

const hhmmSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const carIdSchema = z.enum(["car_a", "car_b", "car_c"]);
const placeQuerySchema = z
  .string()
  .trim()
  .min(2)
  .max(120)
  .refine((s) => !COORD_RE.test(s), "place queries must not contain coordinates");

const COORD_RE = /-?\d{1,3}\.\d+\s*[,;\s]\s*-?\d{1,3}\.\d+/;

export const carSuggestionSchema = z
  .object({
    id: carIdSchema,
    adults: z.number().int().min(1).max(8).optional(),
    kids: z.number().int().min(0).max(8).optional(),
    dietary: z.array(dietarySchema).max(4).optional(),
    initialNeeds: z.array(needSchema).max(5).optional()
  })
  .strict();
export type CarSuggestion = z.infer<typeof carSuggestionSchema>;

export const scenarioSuggestionsSchema = z
  .object({
    originQuery: placeQuerySchema.optional(),
    destinationQuery: placeQuerySchema.optional(),
    departureTime: hhmmSchema.optional(),
    departureMode: z.enum(["depart_at", "arrive_by"]).optional(),
    mood: z.array(moodSchema).max(4).optional(),
    mealPreference: mealPreferenceSchema.optional(),
    customMeal: z.string().trim().min(1).max(120).optional(),
    mealHistory: mealHistorySchema.optional(),
    maxDetourMinutes: z.number().min(0).max(45).optional(),
    cars: z.array(carSuggestionSchema).max(3).optional()
  })
  .strict();
export type ScenarioSuggestions = z.infer<typeof scenarioSuggestionsSchema>;

export const scenarioSuggestionSchema = z.object({
  suggestions: scenarioSuggestionsSchema,
  understood: z.array(z.string().max(200)).max(6),
  warnings: z.array(z.string().max(300)),
  provider: z.string(),
  isMock: z.boolean(),
  fallbackReason: z.string().optional()
});
export type ScenarioSuggestion = z.infer<typeof scenarioSuggestionSchema>;

/* ------------------------------------------------------------------------------------------
 * Sanitizer: field-by-field validation of untrusted (LLM) output. Unknown keys and invalid
 * values are dropped with a warning; numbers are clamped; unknown car ids are dropped.
 * ---------------------------------------------------------------------------------------- */

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const SUGGESTION_KEYS = Object.keys(scenarioSuggestionsSchema.shape) as Array<keyof ScenarioSuggestions>;
const CAR_KEYS = ["id", "adults", "kids", "dietary", "initialNeeds"] as const;

export function sanitizeSuggestions(raw: unknown, warnings: string[]): ScenarioSuggestions {
  const out: Record<string, unknown> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push("suggestions were not an object; ignored");
    return {};
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!(SUGGESTION_KEYS as string[]).includes(key)) {
      warnings.push(`ignored unsupported field "${key}"`);
    }
  }
  for (const key of SUGGESTION_KEYS) {
    let value = obj[key];
    if (value === undefined || value === null) continue;
    if (key === "maxDetourMinutes") {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        warnings.push("ignored non-numeric maxDetourMinutes");
        continue;
      }
      value = clamp(Math.round(value), 0, 45);
    }
    if (key === "cars") {
      value = sanitizeCars(value, warnings);
      if ((value as unknown[]).length === 0) continue;
    }
    const fieldSchema = scenarioSuggestionsSchema.shape[key];
    const parsed = fieldSchema.safeParse(value);
    if (parsed.success) {
      out[key] = parsed.data;
    } else {
      warnings.push(`ignored invalid ${key}: ${parsed.error.issues.map((i) => i.message).join("; ")}`.slice(0, 300));
    }
  }
  return scenarioSuggestionsSchema.parse(out);
}

function sanitizeCars(value: unknown, warnings: string[]): CarSuggestion[] {
  if (!Array.isArray(value)) {
    warnings.push("ignored cars: not an array");
    return [];
  }
  const seen = new Set<string>();
  const cars: CarSuggestion[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const id = carIdSchema.safeParse(e.id);
    if (!id.success) {
      warnings.push(`dropped suggestion for unknown car id ${JSON.stringify(e.id)}`.slice(0, 300));
      continue;
    }
    if (seen.has(id.data)) continue;
    seen.add(id.data);
    const candidate: Record<string, unknown> = { id: id.data };
    for (const k of CAR_KEYS) {
      if (k === "id" || e[k] === undefined || e[k] === null) continue;
      let v = e[k];
      if (k === "adults" && typeof v === "number") v = clamp(Math.round(v), 1, 8);
      if (k === "kids" && typeof v === "number") v = clamp(Math.round(v), 0, 8);
      candidate[k] = v;
    }
    const parsed = carSuggestionSchema.safeParse(candidate);
    if (parsed.success) cars.push(parsed.data);
    else warnings.push(`dropped invalid suggestion for ${id.data}`);
  }
  if (cars.length > 3) cars.length = 3;
  return cars;
}

/* ------------------------------------------------------------------------------------------
 * Deterministic keyword fallback.
 * ---------------------------------------------------------------------------------------- */

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, "a couple of": 2, couple: 2
};
const PLACE = String.raw`([A-ZÀ-Ý][\p{L}.'’-]*(?:\s+(?:[A-ZÀ-Ý][\p{L}.'’-]*|of|de|du|la|on|upon)){0,5})`;
const STOP_TAIL = /\s+(?:of|de|du|la|on|upon)$/;

function cleanPlace(s: string | undefined): string | undefined {
  if (!s) return undefined;
  let t = s.trim().replace(/[.,;:!?]+$/, "");
  while (STOP_TAIL.test(t)) t = t.replace(STOP_TAIL, "");
  return t.length >= 2 ? t : undefined;
}

function matchPlace(text: string, keywords: string[]): string | undefined {
  for (const kw of keywords) {
    const re = new RegExp(String.raw`\b${kw}\s+${PLACE}`, "u");
    const m = re.exec(text);
    if (m) return cleanPlace(m[1]);
  }
  return undefined;
}

function toHHmm(h: number, m: number, ampm?: string): string | undefined {
  let hour = h;
  if (ampm) {
    const pm = /p/i.test(ampm);
    if (hour < 1 || hour > 12) return undefined;
    if (pm && hour !== 12) hour += 12;
    if (!pm && hour === 12) hour = 0;
  }
  if (hour > 23 || m > 59) return undefined;
  return `${String(hour).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

const TIME_RE = String.raw`(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?`;

function parseTimeAfter(text: string, keyword: string): string | undefined {
  const re = new RegExp(String.raw`\b${keyword}\s+(?:around\s+|about\s+|at\s+)?${TIME_RE}(?!\d|\.\d)`, "i");
  const m = re.exec(text);
  if (!m) return undefined;
  if (!m[2] && !m[3]) return undefined; // bare numbers ("to 2 cars") are not times
  return toHHmm(Number(m[1]), Number(m[2] ?? 0), m[3]);
}

export function fallbackScenario(req: ScenarioRequest): { suggestions: ScenarioSuggestions; understood: string[]; warnings: string[] } {
  const text = req.text;
  const lower = text.toLowerCase();
  const s: ScenarioSuggestions = {};
  const understood: string[] = [];
  const warnings: string[] = [];

  // Places — free-text queries only; the UI geocodes and the user confirms.
  const origin = matchPlace(text, ["[Ll]eaving\\s+from", "[Ll]eaving", "[Ss]tarting\\s+(?:from|in|at)", "[Dd]eparting\\s+(?:from)?", "[Ff]rom"]);
  const destination = matchPlace(text, [
    "[Dd]riving\\s+(?:toward|towards|to)",
    "[Hh]ead(?:ing|ed)\\s+(?:toward|towards|to|for)",
    "[Gg]oing\\s+to",
    "[Tt]owards?",
    "[Tt]o"
  ]);
  if (origin) {
    s.originQuery = origin;
    understood.push(`Starting from "${origin}" (please confirm the place)`);
  }
  if (destination && destination !== origin) {
    s.destinationQuery = destination;
    understood.push(`Heading to "${destination}" (please confirm the place)`);
  }

  // Departure time.
  const arriveBy = parseTimeAfter(text, "arriv(?:e|ing)\\s+by") ?? parseTimeAfter(text, "be\\s+there\\s+by");
  const departAt =
    parseTimeAfter(text, "(?:leav(?:e|ing)|depart(?:ing)?|start(?:ing)?|head(?:ing)?\\s+out)") ??
    (arriveBy ? undefined : parseTimeAfter(text, "at"));
  if (arriveBy) {
    s.departureMode = "arrive_by";
    s.departureTime = arriveBy;
    understood.push(`Arrive by ${arriveBy}`);
  } else if (departAt) {
    s.departureMode = "depart_at";
    s.departureTime = departAt;
    understood.push(`Depart at ${departAt}`);
  } else if (/\bearly\b/.test(lower)) {
    s.departureMode = "depart_at";
    s.departureTime = "07:30";
    warnings.push('"Early" was interpreted as a 07:30 departure — adjust the time if needed.');
  }

  // Mood + meal.
  const mood = new Set<z.infer<typeof moodSchema>>();
  const hungry = /\b(hungry|starving|peckish|lunch(?:time)?|dinner(?:time)?|supper)\b/.test(lower);
  if (hungry) mood.add("hungry");
  if (/\b(tired|exhausted|sleepy|drowsy|worn out)\b/.test(lower)) mood.add("tired");
  if (/\b(in a hurry|hurry|rushed|rushing|asap|tight schedule|running late)\b/.test(lower)) mood.add("hurry");
  if (/\b(relaxed|no rush|leisurely|take our time|taking our time|scenic)\b/.test(lower)) mood.add("relaxed");
  if (mood.size) {
    s.mood = [...mood];
    understood.push(`Mood: ${s.mood.join(", ")}`);
  }

  if (/\b(quick bite|quick snack|grab (?:something|a bite)|something quick)\b/.test(lower)) s.mealPreference = "quick_bite";
  else if (/\b(proper meal|sit[- ]down|real meal|nice lunch|nice dinner)\b/.test(lower)) s.mealPreference = "proper_meal";
  else if (hungry) s.mealPreference = "auto";
  if (s.mealPreference) understood.push(`Meal preference: ${s.mealPreference.replace("_", " ")}`);
  if (hungry) understood.push("Hunger expected later — nobody is marked hungry right now");

  const lastMeal = /\b(?:ate|eaten|had (?:lunch|breakfast|dinner))\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/i.exec(text);
  const lastMealTime = lastMeal && (lastMeal[2] || lastMeal[3]) ? toHHmm(Number(lastMeal[1]), Number(lastMeal[2] ?? 0), lastMeal[3]) : undefined;
  if (lastMealTime) {
    s.mealHistory = { kind: "last_meal_at", time: lastMealTime };
    understood.push(`Last meal at ${lastMealTime}`);
  } else if (/\b(already ate|already eaten|just ate|just had (?:lunch|breakfast|dinner)|we(?:'ve| have) eaten)\b/.test(lower)) {
    s.mealHistory = { kind: "already_ate" };
    understood.push("Already ate");
  }

  // Detour.
  const detourMin = /\b(?:detours?\s+(?:of\s+)?(?:up\s+to\s+|under\s+|max(?:imum)?\s+)?(\d{1,3})\s*(?:min|minutes?)|(\d{1,3})[- ]?(?:min|minute)s?\s+detour)/i.exec(text);
  if (detourMin) {
    const n = clamp(Number(detourMin[1] ?? detourMin[2]), 0, 45);
    s.maxDetourMinutes = n;
    understood.push(`Max detour ${n} min`);
  } else if (
    /\b(no (?:big|large|long|major) detours?|(?:don'?t|do not|dont)\s+want\s+(?:a\s+|any\s+)?(?:big|large|long|major)?\s*detours?|minimal detours?|short detours?|small detours?|no detours?)\b/.test(lower.replace(/’/g, "'"))
  ) {
    s.maxDetourMinutes = 8;
    understood.push("Keep detours small (≤ 8 min)");
  } else if (/\b(happy to detour|don'?t mind (?:a )?detour|long detour is fine)\b/.test(lower.replace(/’/g, "'"))) {
    s.maxDetourMinutes = 20;
    understood.push("Longer detours OK (≤ 20 min)");
  }

  // Lead car: kids/adults/diet/needs.
  const leadId = req.current.cars[0]?.id ?? "car_a";
  const leadCurrent = req.current.cars.find((c) => c.id === leadId);
  const carS: CarSuggestion = { id: leadId };
  const kidsM = /\b(\d|a couple of|couple|one|two|three|four|five|six|seven|eight)\s+(?:little\s+|young\s+|small\s+)?(?:kids?|children|child|little ones|toddlers?)\b/i.exec(text);
  if (kidsM) {
    const k = NUMBER_WORDS[kidsM[1].toLowerCase()] ?? Number(kidsM[1]);
    if (Number.isFinite(k)) carS.kids = clamp(k, 0, 8);
  } else if (/\b(with|have|bringing)\s+(?:the\s+|our\s+|my\s+)?(kids|children|child|toddler|baby)\b/.test(lower)) {
    carS.kids = leadCurrent && leadCurrent.kids > 0 ? leadCurrent.kids : 1;
    if (!(leadCurrent && leadCurrent.kids > 0)) warnings.push("Number of kids not stated — assumed 1; adjust if needed.");
  } else if (/\b(no kids|without (?:the )?kids|just adults|adults only)\b/.test(lower)) {
    carS.kids = 0;
  }
  if (carS.kids !== undefined) understood.push(`Kids: ${carS.kids}`);
  const adultsM = /\b(\d|one|two|three|four|five|six|seven|eight)\s+adults?\b/i.exec(text);
  if (adultsM) {
    const a = NUMBER_WORDS[adultsM[1].toLowerCase()] ?? Number(adultsM[1]);
    if (Number.isFinite(a)) carS.adults = clamp(a, 1, 8);
  }

  const diet = new Set<z.infer<typeof dietarySchema>>(leadCurrent?.dietary ?? []);
  const before = diet.size;
  if (/\bvegetarian\b/.test(lower)) diet.add("vegetarian");
  if (/\bvegan\b/.test(lower)) diet.add("vegan");
  if (/\bhalal\b/.test(lower)) diet.add("halal");
  if (/\bgluten[- ]?free\b|\bceliac\b|\bcoeliac\b/.test(lower)) diet.add("gluten_free");
  if (diet.size > before) {
    carS.dietary = [...diet];
    understood.push(`Dietary: ${carS.dietary.join(", ").replace("gluten_free", "gluten free")}`);
  }

  const needs = new Set<z.infer<typeof needSchema>>();
  if (/\b(coffee|espresso|latte|tim hortons|timmies)\b/.test(lower)) needs.add("coffee");
  if (/\b(washroom|restroom|bathroom|toilet|potty|pee)\b/.test(lower)) needs.add("restroom");
  if (/\b(ev charg\w*|charge the car|charging stop|need to charge|low battery)\b/.test(lower)) needs.add("ev_charge");
  if (/\b(groceries|grocery)\b/.test(lower)) needs.add("grocery");
  if (needs.size) {
    carS.initialNeeds = [...new Set([...(leadCurrent?.initialNeeds ?? []), ...needs])];
    understood.push(`Needs at start: ${[...needs].join(", ").replace("ev_charge", "EV charge")}`);
  }

  if (Object.keys(carS).length > 1) s.cars = [carS];

  if (Object.keys(s).length === 0) warnings.push("Couldn't pick out any trip details — try naming places, a time, or who's travelling.");

  return { suggestions: scenarioSuggestionsSchema.parse(s), understood: dedupe(understood).slice(0, 6), warnings };
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

/* ------------------------------------------------------------------------------------------
 * LLM path.
 * ---------------------------------------------------------------------------------------- */

const SYSTEM = [
  "You are Agent 1 (Intent & Conversation) of Uncongest, a road-trip stop assistant, configuring a trip SIMULATION.",
  "Read the user's free-text scenario and suggest changes to the trip setup. Do not recommend stops or places to eat.",
  "NEVER output coordinates, latitude/longitude, addresses you invented, or route geometry. Places are free-text queries only (e.g. \"Mississauga, ON\", \"Letchworth State Park\"); the app geocodes them and the user confirms.",
  "Only include fields the text actually implies; omit everything else.",
  "departureTime is local HH:mm (24h). If the text says only 'early', suggest 07:30 and add a warning that it was assumed.",
  "'arrive by HH:mm' → departureMode arrive_by. Otherwise depart_at.",
  "mood ⊂ [relaxed, tired, hungry, hurry]. 'Hungry by lunchtime' means hunger is EXPECTED later: add mood hungry and mealPreference auto, but do not claim anyone is hungry now.",
  "mealPreference ∈ auto|quick_bite|proper_meal|coffee|custom (customMeal ≤ 120 chars when custom). mealHistory: {kind: unknown|already_ate|last_meal_at, time?: HH:mm}.",
  "maxDetourMinutes 0–45; 'no big detour' ≈ 8.",
  "cars: only ids car_a, car_b, car_c; fields adults 1–8, kids 0–8, dietary ⊂ [vegetarian, vegan, halal, gluten_free], initialNeeds ⊂ [meal, coffee, restroom, ev_charge, grocery]. Default to car_a unless another car is named.",
  'Return JSON only, no markdown: {"suggestions":{"originQuery"?,"destinationQuery"?,"departureTime"?,"departureMode"?,"mood"?,"mealPreference"?,"customMeal"?,"mealHistory"?,"maxDetourMinutes"?,"cars"?:[{"id","adults"?,"kids"?,"dietary"?,"initialNeeds"?}]},"understood":["≤6 short plain-English notes"],"warnings":["assumptions the user should check"]}'
].join(" ");

/** Compact, coordinate-free view of the current setup for the model. */
function describeCurrent(current: TripSetup) {
  return {
    origin: current.origin.label,
    destination: current.destination.label,
    departure: current.departure,
    mood: current.mood,
    mealPreference: current.mealPreference,
    mealHistory: current.mealHistory,
    maxDetourMinutes: current.maxDetourMinutes,
    cars: current.cars.map((c) => ({ id: c.id, label: c.label, adults: c.adults, kids: c.kids, dietary: c.dietary, initialNeeds: c.initialNeeds }))
  };
}

const stringList = (v: unknown, max: number, len: number): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim().slice(0, len)).slice(0, max) : [];

function applyEarlyGuard(text: string, suggestions: ScenarioSuggestions, warnings: string[]) {
  const explicitTime = /\d{1,2}(:\d{2}|\s*[ap]\.?m)/i.test(text);
  if (/\bearly\b/i.test(text) && !explicitTime && suggestions.departureTime && !warnings.some((w) => /early/i.test(w))) {
    warnings.push(`"Early" was interpreted as a ${suggestions.departureTime} departure — adjust the time if needed.`);
  }
}

export async function interpretScenario(input: ScenarioRequest): Promise<ScenarioSuggestion> {
  const req = scenarioRequestSchema.parse(input);
  const client = getLlmClient("intent");
  if (!client) {
    return finalize({ ...fallbackScenario(req), provider: "regex-parser", isMock: true });
  }
  try {
    const { text } = await client.complete(
      SYSTEM,
      JSON.stringify({ scenario: req.text, today: req.todayLocalDate, localTime: req.localTime, currentSetup: describeCurrent(req.current) })
    );
    const raw = extractJson(text);
    if (!raw || typeof raw !== "object" || !("suggestions" in raw)) throw new Error("model output missing suggestions");
    const r = raw as Record<string, unknown>;
    const warnings = stringList(r.warnings, 8, 300);
    const suggestions = sanitizeSuggestions(r.suggestions, warnings);
    applyEarlyGuard(req.text, suggestions, warnings);
    return finalize({
      suggestions,
      understood: stringList(r.understood, 6, 200),
      warnings,
      provider: client.name,
      isMock: false
    });
  } catch (err) {
    const reason = safeLlmError(err);
    console.warn(`[ai:scenario] ${client.name} failed (${reason}); keyword fallback used`);
    return finalize({ ...fallbackScenario(req), provider: `${client.name} failed; keyword fallback`, isMock: true, fallbackReason: reason.slice(0, 300) });
  }
}

function finalize(result: ScenarioSuggestion): ScenarioSuggestion {
  return scenarioSuggestionSchema.parse({
    ...result,
    understood: result.understood.slice(0, 6),
    warnings: dedupe(result.warnings).slice(0, 10).map((w) => w.slice(0, 300))
  });
}
