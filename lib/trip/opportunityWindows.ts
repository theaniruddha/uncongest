import { MEAL_WINDOWS } from "@/lib/domain/urgency";

/**
 * Deterministic "where might a stop be needed?" windows for a planned trip.
 * Used to pre-warm real-place discovery for just a few road segments instead of the whole journey.
 * These are opportunity windows, NOT decisions — the watcher + Agent 2 still decide at run time.
 */
export interface OpportunityWindow {
  minKm: number;
  maxKm: number;
  reason: string;
}

export interface OpportunityInput {
  routeKm: number;
  speedKph: number;
  departureLocal: string; // HH:mm
  mood: string[];
  mealPreference: string;
  mealHistory: { kind: "unknown" | "already_ate" | "last_meal_at"; time?: string };
  noticeMinutes?: number;
}

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

export function opportunityWindows(i: OpportunityInput): OpportunityWindow[] {
  const speed = Math.max(i.speedKph, 1);
  const driveMin = (i.routeKm / speed) * 60;
  const dep = toMin(i.departureLocal);
  const notice = i.noticeMinutes ?? 10;
  const kmAt = (minutesAfterDeparture: number) => Math.min(Math.max((minutesAfterDeparture / 60) * speed, 0), i.routeKm);
  const out: OpportunityWindow[] = [];
  const earliest = kmAt(notice);

  // Meal windows that fall inside the drive (unless a recent meal is known).
  const lastMeal = i.mealHistory.kind === "already_ate" ? dep : i.mealHistory.kind === "last_meal_at" && i.mealHistory.time ? toMin(i.mealHistory.time) : null;
  for (const w of MEAL_WINDOWS) {
    const start = Math.max(w.start, dep) - dep;
    const end = Math.min(w.end, dep + driveMin) - dep;
    if (end <= start || end < notice) continue;
    if (lastMeal != null && w.start - lastMeal < 180) continue;
    const from = Math.max(kmAt(start), earliest);
    const to = Math.min(kmAt(end), from + 70);
    if (to > from) out.push({ minKm: from, maxKm: to, reason: `${w.name} window` });
  }

  // First rest break.
  const restAt = i.mood.includes("tired") ? 90 : 120;
  if (driveMin > restAt + 15) {
    out.push({ minKm: Math.max(kmAt(restAt - 20), earliest), maxKm: kmAt(restAt + 25), reason: `rest break around ${restAt} min` });
  }

  // Coffee-first trips: the first stretch.
  if (i.mealPreference === "coffee" || i.mood.includes("tired")) {
    out.push({ minKm: earliest, maxKm: Math.min(earliest + 45, i.routeKm), reason: "early coffee" });
  }

  // Merge overlaps, keep at most 3, in route order.
  out.sort((a, b) => a.minKm - b.minKm);
  const merged: OpportunityWindow[] = [];
  for (const w of out) {
    const last = merged[merged.length - 1];
    if (last && w.minKm <= last.maxKm + 5) {
      last.maxKm = Math.max(last.maxKm, w.maxKm);
      last.reason = `${last.reason} + ${w.reason}`;
    } else merged.push({ ...w });
  }
  return merged.slice(0, 3);
}
