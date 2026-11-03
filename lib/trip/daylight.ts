/**
 * Sunrise / sunset / civil dusk (NOAA spreadsheet solar position, no dependencies) and
 * IANA time-zone helpers built on Intl (DST-correct).
 *
 * Accuracy: ~1–2 minutes at mid-latitudes, which is plenty for "will we arrive after dark?".
 */

const RAD = Math.PI / 180;
const DAY_MS = 86_400_000;
const J1970 = 2440587.5;
const J2000 = 2451545.0;

export interface SunTimes {
  sunrise: Date | null;
  sunset: Date | null;
  /** End of civil twilight (sun 6° below the horizon). */
  civilDusk: Date | null;
  /** Set only in polar cases (no sunrise/sunset that day). */
  polar?: "day" | "night";
}

interface SolarDay {
  /** Solar noon, ms since epoch. */
  noonMs: number;
  decl: number; // radians
}

/** NOAA spreadsheet solar declination + equation of time (minutes) at instant `ms`. */
function solarAt(ms: number): { decl: number; eotMin: number } {
  const jd = ms / DAY_MS + J1970;
  const T = (jd - J2000) / 36525;
  const L0 = (((280.46646 + T * (36000.76983 + T * 0.0003032)) % 360) + 360) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C =
    Math.sin(M * RAD) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
    Math.sin(2 * M * RAD) * (0.019993 - 0.000101 * T) +
    Math.sin(3 * M * RAD) * 0.000289;
  const omega = 125.04 - 1934.136 * T;
  const appLong = L0 + C - 0.00569 - 0.00478 * Math.sin(omega * RAD);
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * RAD);
  const decl = Math.asin(Math.sin(eps * RAD) * Math.sin(appLong * RAD));
  const y = Math.tan((eps / 2) * RAD) ** 2;
  const eotMin =
    (4 / RAD) *
    (y * Math.sin(2 * L0 * RAD) -
      2 * e * Math.sin(M * RAD) +
      4 * e * y * Math.sin(M * RAD) * Math.cos(2 * L0 * RAD) -
      0.5 * y * y * Math.sin(4 * L0 * RAD) -
      1.25 * e * e * Math.sin(2 * M * RAD));
  return { decl, eotMin };
}

/** Solar noon + declination for the (mean-solar) day containing `date` at longitude `lng` (east +). */
function solarDay(date: Date, lng: number): SolarDay {
  const lngMs = (lng / 360) * DAY_MS;
  const dayIndex = Math.floor((date.getTime() + lngMs) / DAY_MS);
  let noonMs = dayIndex * DAY_MS + DAY_MS / 2 - lngMs;
  let s = solarAt(noonMs);
  for (let i = 0; i < 2; i++) {
    noonMs = dayIndex * DAY_MS + DAY_MS / 2 - lngMs - s.eotMin * 60_000;
    s = solarAt(noonMs);
  }
  return { noonMs, decl: s.decl };
}

/** cos of the hour angle at which the sun reaches altitude `altDeg`. */
function cosHourAngle(altDeg: number, lat: number, decl: number): number {
  const phi = lat * RAD;
  return (Math.sin(altDeg * RAD) - Math.sin(phi) * Math.sin(decl)) / (Math.cos(phi) * Math.cos(decl));
}

/**
 * Sun times for the local day containing `date` (pass any UTC instant on that local day,
 * ideally local noon — e.g. `localDateTimeToUtc(day, "12:00", tz)`).
 * Returns nulls in polar day / polar night.
 */
export function sunTimes(date: Date, lat: number, lng: number): SunTimes {
  const { noonMs, decl } = solarDay(date, lng);
  const cRise = cosHourAngle(-0.833, lat, decl);
  const cDusk = cosHourAngle(-6, lat, decl);
  let sunrise: Date | null = null;
  let sunset: Date | null = null;
  let civilDusk: Date | null = null;
  let polar: SunTimes["polar"];
  if (cRise >= -1 && cRise <= 1) {
    const w = (Math.acos(cRise) / (2 * Math.PI)) * DAY_MS;
    sunrise = new Date(noonMs - w);
    sunset = new Date(noonMs + w);
  } else {
    polar = cRise > 1 ? "night" : "day";
  }
  if (cDusk >= -1 && cDusk <= 1) civilDusk = new Date(noonMs + (Math.acos(cDusk) / (2 * Math.PI)) * DAY_MS);
  return polar ? { sunrise, sunset, civilDusk, polar } : { sunrise, sunset, civilDusk };
}

/** True when the sun is below the horizon (before sunrise or after sunset) at `at`. */
export function isDark(at: Date, lat: number, lng: number): boolean {
  const t = sunTimes(at, lat, lng);
  if (!t.sunrise || !t.sunset) return t.polar === "night";
  return at.getTime() < t.sunrise.getTime() || at.getTime() > t.sunset.getTime();
}

// ---------------------------------------------------------------- time zones

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = fmtCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
    fmtCache.set(timeZone, f);
  }
  return f;
}

function zonedParts(d: Date, timeZone: string) {
  const out: Record<string, number> = {};
  for (const p of partsFormatter(timeZone).formatToParts(d)) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return { year: out.year, month: out.month, day: out.day, hour: out.hour % 24, minute: out.minute, second: out.second };
}

/** Offset of `timeZone` from UTC at instant `d`, in ms (local − UTC). */
export function zoneOffsetMs(d: Date, timeZone: string): number {
  const p = zonedParts(d, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - (d.getTime() - d.getUTCMilliseconds());
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "HH:mm" (24h) of instant `d` in `timeZone`. */
export function formatInZone(d: Date, timeZone: string): string {
  const p = zonedParts(d, timeZone);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** Local calendar date + time of a UTC instant. */
export function utcToLocal(d: Date, timeZone: string): { date: string; time: string } {
  const p = zonedParts(d, timeZone);
  return { date: `${p.year}-${pad(p.month)}-${pad(p.day)}`, time: `${pad(p.hour)}:${pad(p.minute)}` };
}

/**
 * Convert a wall-clock local date/time in `timeZone` to a UTC instant. Correct across DST:
 * the offset is iterated until stable. Nonexistent times (spring-forward gap) resolve forward;
 * ambiguous times (fall-back) resolve to the first (daylight) occurrence.
 */
export function localDateTimeToUtc(localDate: string, localTime: string, timeZone: string): Date {
  const [y, mo, da] = localDate.split("-").map(Number);
  const [h, mi] = localTime.split(":").map(Number);
  const wall = Date.UTC(y, mo - 1, da, h, mi);
  // Start from the offset an hour earlier so fall-back ambiguity picks the first occurrence.
  let guess = wall - zoneOffsetMs(new Date(wall - 3_600_000 * 3), timeZone);
  for (let i = 0; i < 4; i++) {
    const next = wall - zoneOffsetMs(new Date(guess), timeZone);
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess);
}
