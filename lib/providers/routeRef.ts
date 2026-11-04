import type { RouteModel } from "@/lib/route/model";
import { TORONTO_MONTREAL } from "@/lib/route/route";
import { getStoredRoute, resolveRoute, routeModelFor } from "./routing";

export interface RouteRef {
  id: string;
  origin: { label: string; lat: number; lng: number; type: "home" | "hotel" | "other" };
  destination: { label: string; lat: number; lng: number; type: "home" | "hotel" | "other" };
}

const models = new Map<string, RouteModel>();

/**
 * Server-side route lookup by id. Serverless instances may not share memory, so on a miss
 * the route is re-resolved from its endpoints (cached by the routing provider).
 */
export async function routeModelForRef(ref: RouteRef, sessionId?: string): Promise<RouteModel> {
  if (ref.id === TORONTO_MONTREAL.id) return TORONTO_MONTREAL;
  const hit = models.get(ref.id);
  if (hit) return hit;
  const stored =
    getStoredRoute(ref.id) ??
    (await resolveRoute({ ...ref.origin, source: "search" }, { ...ref.destination, source: "search" }, { sessionId }));
  const model = routeModelFor(stored);
  models.set(ref.id, model);
  if (stored.id !== ref.id) models.set(stored.id, model);
  return model;
}
