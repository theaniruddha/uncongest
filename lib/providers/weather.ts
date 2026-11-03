import type { Weather } from "@/lib/domain/types";

/**
 * Weather at a point for a given local hour (America/Toronto, which covers the whole corridor).
 * Live source: Open-Meteo hourly forecast (no key). Cached per 0.1° grid cell for 30 minutes.
 * On failure we return the caller's simulated fallback, explicitly labelled — never silently.
 */
export interface WeatherPointRequest {
  id: string;
  lat: number;
  lng: number;
  /** Local wall-clock time "YYYY-MM-DDTHH:mm" in America/Toronto. */
  localDateTime: string;
}

export interface WeatherReading {
  id: string;
  condition: Weather;
  tempC: number | null;
  precipProbability: number | null;
  weatherCode: number | null;
  description: string;
  source: "open-meteo" | "simulated" | "unavailable";
  /** Hour the reading applies to, local. */
  forHour: string;
  fetchedAt: string | null;
  stale: boolean;
  note?: string;
}

export interface WeatherProvider {
  name: string;
  getReadings(points: WeatherPointRequest[], fallback: Weather): Promise<WeatherReading[]>;
}

const TTL_MS = 30 * 60 * 1000;
const TIMEOUT_MS = 6000;
const DEFAULT_TZ = "America/Toronto";
/** Open-Meteo serves up to 16 forecast days (+ a little history); beyond that we say so. */
const FORECAST_DAYS = 16;

interface CellForecast {
  fetchedAtMs: number;
  time: string[];
  temp: Array<number | null>;
  precip: Array<number | null>;
  code: Array<number | null>;
}

const cache = new Map<string, CellForecast>();

function cellKey(lat: number, lng: number, tz = DEFAULT_TZ): string {
  return `${tz}|${lat.toFixed(1)},${lng.toFixed(1)}`;
}

export function describeWmo(code: number | null): string {
  if (code == null) return "unknown";
  if (code === 0) return "clear";
  if (code <= 2) return "partly cloudy";
  if (code === 3) return "overcast";
  if (code === 45 || code === 48) return "fog";
  if (code >= 51 && code <= 57) return "drizzle";
  if (code >= 61 && code <= 67) return "rain";
  if (code >= 71 && code <= 77) return "snow";
  if (code >= 80 && code <= 82) return "rain showers";
  if (code >= 85 && code <= 86) return "snow showers";
  if (code >= 95) return "thunderstorm";
  return `WMO ${code}`;
}

/** Map a WMO weather code + temperature onto the engine's coarse condition enum. */
export function conditionFromWmo(code: number | null, tempC: number | null): Weather {
  if (code != null && ((code >= 71 && code <= 77) || code === 85 || code === 86)) return "snow";
  if (code != null && ((code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code >= 95)) return "rain";
  if (tempC != null && tempC <= 3) return "cold";
  if (code != null && code >= 2) return "cloudy";
  return "sunny";
}

const SEVERITY: Record<Weather, number> = { sunny: 0, cloudy: 1, cold: 2, rain: 3, snow: 4 };
export function worseWeather(a: Weather, b: Weather): Weather {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

function hourKey(localDateTime: string): string {
  return `${localDateTime.slice(0, 13)}:00`;
}

/** Today's date in America/Toronto as YYYY-MM-DD. */
export function todayLocalDate(now = new Date(), timeZone = DEFAULT_TZ): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** "YYYY-MM-DD" + "HH:mm" + minutes → "YYYY-MM-DDTHH:mm" (calendar-correct, DST ignored). */
export function addMinutesLocal(localDate: string, localTime: string, minutes: number): string {
  const [y, mo, d] = localDate.split("-").map(Number);
  const [h, mi] = localTime.split(":").map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi) + Math.round(minutes) * 60000);
  return dt.toISOString().slice(0, 16);
}

export class OpenMeteoWeatherProvider implements WeatherProvider {
  name = "open-meteo";
  constructor(private fetchImpl: typeof fetch = fetch, private timeZone: string = DEFAULT_TZ) {}

  private async fetchCells(cells: Array<{ key: string; lat: number; lng: number }>): Promise<void> {
    if (cells.length === 0) return;
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", cells.map((c) => c.lat.toFixed(2)).join(","));
    url.searchParams.set("longitude", cells.map((c) => c.lng.toFixed(2)).join(","));
    url.searchParams.set("hourly", "temperature_2m,precipitation_probability,weather_code");
    url.searchParams.set("past_days", "2");
    url.searchParams.set("forecast_days", String(FORECAST_DAYS));
    url.searchParams.set("timezone", this.timeZone);
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(url.toString(), { signal: controller.signal });
      if (!res.ok) throw new Error(`open-meteo http ${res.status}`);
      const json = await res.json();
      const list = Array.isArray(json) ? json : [json];
      const now = Date.now();
      list.forEach((loc: any, i: number) => {
        const cell = cells[i];
        if (!cell || !loc?.hourly) return;
        cache.set(cell.key, {
          fetchedAtMs: now,
          time: loc.hourly.time ?? [],
          temp: loc.hourly.temperature_2m ?? [],
          precip: loc.hourly.precipitation_probability ?? [],
          code: loc.hourly.weather_code ?? []
        });
      });
      console.info(`[weather] open-meteo fetched ${cells.length} cell(s)`);
    } finally {
      clearTimeout(t);
    }
  }

  async getReadings(points: WeatherPointRequest[], fallback: Weather): Promise<WeatherReading[]> {
    const now = Date.now();
    const needed = new Map<string, { key: string; lat: number; lng: number }>();
    for (const p of points) {
      const key = cellKey(p.lat, p.lng, this.timeZone);
      const c = cache.get(key);
      if (!c || now - c.fetchedAtMs > TTL_MS) needed.set(key, { key, lat: Number(p.lat.toFixed(1)), lng: Number(p.lng.toFixed(1)) });
    }
    let fetchError: string | null = null;
    try {
      await this.fetchCells([...needed.values()]);
    } catch (err) {
      fetchError = (err as Error).message;
      console.warn(`[weather] ${fetchError}; using cached/simulated fallback`);
    }
    return points.map((p) => {
      const forHour = hourKey(p.localDateTime);
      const c = cache.get(cellKey(p.lat, p.lng, this.timeZone));
      const idx = c ? c.time.indexOf(forHour) : -1;
      if (!c || idx < 0) {
        return {
          id: p.id,
          condition: fallback,
          tempC: null,
          precipProbability: null,
          weatherCode: null,
          description: `simulated ${fallback}`,
          source: "unavailable",
          forHour,
          fetchedAt: null,
          stale: false,
          note: fetchError
            ? `live weather unavailable (${fetchError}); using simulated "${fallback}"`
            : c && c.time.length && forHour > c.time[c.time.length - 1]
              ? `${forHour.slice(0, 10)} is beyond the ${FORECAST_DAYS}-day forecast range; using simulated "${fallback}"`
              : `no forecast for ${forHour}; using simulated "${fallback}"`
        };
      }
      const tempC = c.temp[idx] ?? null;
      const code = c.code[idx] ?? null;
      const stale = now - c.fetchedAtMs > TTL_MS;
      return {
        id: p.id,
        condition: conditionFromWmo(code, tempC),
        tempC,
        precipProbability: c.precip[idx] ?? null,
        weatherCode: code,
        description: describeWmo(code),
        source: "open-meteo",
        forHour,
        fetchedAt: new Date(c.fetchedAtMs).toISOString(),
        stale,
        note: stale ? "cached forecast older than 30 min (refresh failed)" : undefined
      };
    });
  }
}

/** Offline mode: returns the UI-selected weather, labelled as simulated. */
export class SimulatedWeatherProvider implements WeatherProvider {
  name = "simulated";
  async getReadings(points: WeatherPointRequest[], fallback: Weather): Promise<WeatherReading[]> {
    return points.map((p) => ({
      id: p.id,
      condition: fallback,
      tempC: null,
      precipProbability: null,
      weatherCode: null,
      description: `simulated ${fallback}`,
      source: "simulated",
      forHour: hourKey(p.localDateTime),
      fetchedAt: null,
      stale: false
    }));
  }
}

export function getWeatherProvider(mode: "live" | "simulated", timeZone: string = DEFAULT_TZ): WeatherProvider {
  return mode === "live" ? new OpenMeteoWeatherProvider(fetch, timeZone) : new SimulatedWeatherProvider();
}
