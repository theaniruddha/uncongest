import type { Need } from "./types";

/**
 * Deterministic stop-urgency rules. Shared by the client-side Ambient Trip Watcher and by
 * Agent 2 on the server, so both agree on when a decision is needed and how far to look.
 */
export type UrgencyLevel = "none" | "low" | "moderate" | "high";

export interface UrgencyInput {
  needs: Need[];
  hungerLevel: 0 | 1 | 2 | 3;
  restroomUrgent?: boolean;
  /** Explicitly said they are not hungry / already ate — suppresses meal reminders. */
  notHungry?: boolean;
  kids: boolean;
  ev?: boolean;
  batteryPercent?: number;
}

export interface UrgencyTripInput {
  elapsedMinutes: number;
  localTime: string; // HH:mm
  /** Minutes since the last *confirmed* stop; departure counts as a stop. */
  minutesSinceLastStop: number;
  /** Minutes since the last confirmed meal; null = unknown (never assume "hasn't eaten"). */
  lastMealMinutesAgo: number | null;
  /** Trip mood from setup: tired → earlier rest break; hungry → meal-time counts more; never "hungry now". */
  mood?: Array<"relaxed" | "tired" | "hungry" | "hurry">;
}

export interface UrgencyResult {
  level: UrgencyLevel;
  reasons: string[];
  /** Needs the decision should serve (explicit + inferred reminders). */
  needs: Need[];
  /** True when the only driver is an inferred meal-time reminder (no explicit request). */
  reminderOnly: boolean;
}

export const URGENCY_RANK: Record<UrgencyLevel, number> = { none: 0, low: 1, moderate: 2, high: 3 };

export const MEAL_WINDOWS = [
  { name: "lunch", start: 11 * 60 + 30, end: 14 * 60 },
  { name: "dinner", start: 17 * 60 + 30, end: 20 * 60 }
] as const;

/** Exploration horizon per urgency (Agent 2). Bounded by design. */
export const HORIZON = {
  high: { maxKm: 60, exits: 1, label: "nearest safely reachable suitable stop" },
  moderate: { maxKm: 120, exits: 2, label: "next one or two usable exits" },
  low: { maxKm: 220, exits: 4, label: "farther ahead for a better stop or weather" },
  none: { maxKm: 220, exits: 4, label: "no active need" }
} as const;

function toMin(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function activeMealWindow(localTime: string): { name: string; minutesLeft: number } | null {
  const t = toMin(localTime);
  for (const w of MEAL_WINDOWS) if (t >= w.start && t < w.end) return { name: w.name, minutesLeft: w.end - t };
  return null;
}

function raise(cur: UrgencyLevel, to: UrgencyLevel): UrgencyLevel {
  return URGENCY_RANK[to] > URGENCY_RANK[cur] ? to : cur;
}

export function evaluateUrgency(input: UrgencyInput, trip: UrgencyTripInput): UrgencyResult {
  let level: UrgencyLevel = "none";
  const reasons: string[] = [];
  const needs = new Set<Need>(input.needs);
  let explicit = false;

  if (input.restroomUrgent) {
    level = raise(level, "high");
    needs.add("restroom");
    reasons.push("urgent restroom request");
    explicit = true;
  }
  if (input.hungerLevel >= 3) {
    level = raise(level, "high");
    needs.add("meal");
    reasons.push("very hungry (3/3)");
    explicit = true;
  }
  if (input.ev && input.batteryPercent != null && input.batteryPercent <= 15) {
    level = raise(level, "high");
    needs.add("ev_charge");
    reasons.push(`battery ${input.batteryPercent}% ≤ 15%`);
    explicit = true;
  }
  if (input.kids && needs.has("restroom")) {
    level = raise(level, "high");
    reasons.push("children need a restroom");
  }
  if (input.needs.length > 0) {
    level = raise(level, "moderate");
    reasons.push(`requested: ${input.needs.join(", ")}`);
    explicit = true;
  }
  if (input.hungerLevel === 2) {
    level = raise(level, "moderate");
    needs.add("meal");
    reasons.push("hungry (2/3)");
    explicit = true;
  }
  if (input.hungerLevel === 1) {
    level = raise(level, "low");
    reasons.push("a little hungry (1/3)");
    explicit = true;
  }

  const tired = trip.mood?.includes("tired") ?? false;
  if (tired && trip.minutesSinceLastStop >= 90 && trip.minutesSinceLastStop < 150) {
    level = raise(level, "moderate");
    needs.add("restroom");
    reasons.push(`tired; ${Math.round(trip.minutesSinceLastStop)} min of driving since last rest`);
  }
  if (trip.minutesSinceLastStop >= 150) {
    level = raise(level, "moderate");
    needs.add("restroom");
    reasons.push(`${Math.round(trip.minutesSinceLastStop)} min since last confirmed stop`);
  } else if (trip.minutesSinceLastStop >= 120 || (input.kids && trip.minutesSinceLastStop >= 90)) {
    level = raise(level, "low");
    reasons.push(`${Math.round(trip.minutesSinceLastStop)} min since last confirmed stop${input.kids ? " (children aboard)" : ""}`);
  }

  // Meal-time reminder: only when no explicit "not hungry", and meal history is unknown or old.
  const meal = activeMealWindow(trip.localTime);
  const ateRecently = trip.lastMealMinutesAgo != null && trip.lastMealMinutesAgo < 180;
  if (meal && !ateRecently && !input.notHungry && trip.elapsedMinutes >= 90) {
    const history = trip.lastMealMinutesAgo == null ? "meal history unknown" : `last meal ${trip.lastMealMinutesAgo} min ago`;
    const expectsHunger = trip.mood?.includes("hungry") ?? false;
    if (meal.minutesLeft <= 45 || expectsHunger) {
      level = raise(level, "moderate");
      reasons.push(
        expectsHunger
          ? `${meal.name} time and the group expected to be hungry by now; ${history}`
          : `${meal.name} window closes in ${meal.minutesLeft} min; ${history}`
      );
    } else {
      level = raise(level, "low");
      reasons.push(`${meal.name} time; ${history} — reminder only`);
    }
    needs.add("meal");
  }

  return { level, reasons, needs: [...needs], reminderOnly: !explicit && level !== "none" };
}

export function maxUrgency(results: UrgencyResult[]): UrgencyResult {
  if (results.length === 0) return { level: "none", reasons: [], needs: [], reminderOnly: false };
  const top = results.reduce((a, b) => (URGENCY_RANK[b.level] > URGENCY_RANK[a.level] ? b : a));
  return {
    level: top.level,
    reasons: [...new Set(results.flatMap((r) => r.reasons))],
    needs: [...new Set(results.flatMap((r) => r.needs))],
    reminderOnly: results.every((r) => r.reminderOnly || r.level === "none")
  };
}
