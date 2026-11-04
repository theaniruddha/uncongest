import type { RouteModel } from "@/lib/route/model";
import { TORONTO_MONTREAL } from "@/lib/route/route";
import type { TripRoute } from "@/lib/trip/types";
import { getStoredRoute, resolveExits, resolveRoute, routeModelFor } from "./routing";

export interface RouteRef {
  id: string;
  origin: { label: string; lat: number; lng: number; type: "home" | "hotel" | "other" };
  destination: { label: string; lat: number; lng: number; type: "home" | "hotel" | "other" };
}

export interface RouteModelForRefOpts {
  /**
   * How a store miss resolves the route. "defer" (default) returns geometry without waiting for
   * Overpass/Nominatim exits (they are filled in the background); "inline" waits for exits.
   */
  exits?: "inline" | "defer";
  /** In "defer" mode, wait up to this long for background exits before building the model. */
  exitsWaitMs?: number;
}

const MODELS_MAX = 50;
/** Built models, keyed by stored route id and tagged with the exit state they were built from. */
const models = new Map<string, { status: TripRoute["exitsStatus"]; model: RouteModel }>();

function remember(id: string, status: TripRoute["exitsStatus"], model: RouteModel): void {
  models.delete(id);
  models.set(id, { status, model });
  while (models.size > MODELS_MAX) {
    const oldest = models.keys().next().value;
    if (oldest === undefined) break;
    models.delete(oldest);
  }
}

/**
 * Server-side route lookup by id. Serverless instances may not share memory, so on a miss
 * the route is re-resolved from its endpoints (cached by the routing provider).
 * The route store is consulted on every call so a model built while exits were still pending is
 * rebuilt once the exits arrive; models of pending routes are never memoised.
 */
export async function routeModelForRef(ref: RouteRef, sessionId?: string, opts: RouteModelForRefOpts = {}): Promise<RouteModel> {
  if (ref.id === TORONTO_MONTREAL.id) return TORONTO_MONTREAL;
  let stored = getStoredRoute(ref.id);
  if (!stored) {
    const origin = { ...ref.origin, source: "search" as const };
    const destination = { ...ref.destination, source: "search" as const };
    stored = await resolveRoute(origin, destination, { sessionId, exits: opts.exits ?? "defer" });
    if (stored.exitsStatus === "pending") {
      // Fill exits in the background (deduped per id); a later call picks them up from the store.
      const exits = resolveExits(stored.id, { sessionId, origin, destination });
      exits.catch(() => undefined);
      if (opts.exitsWaitMs && opts.exitsWaitMs > 0) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), opts.exitsWaitMs);
        });
        const ready = await Promise.race([exits.catch(() => null), timeout]);
        if (timer) clearTimeout(timer);
        if (ready) stored = ready;
      }
    }
  }
  const status = stored.exitsStatus;
  const hit = models.get(stored.id);
  if (hit && hit.status === status) {
    remember(stored.id, status, hit.model);
    return hit.model;
  }
  const model = routeModelFor(stored);
  if (status !== "pending") remember(stored.id, status, model);
  return model;
}

/** For tests. */
export function clearRouteModelCache(): void {
  models.clear();
}
