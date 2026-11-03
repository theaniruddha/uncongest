import baseFixture from "@/data/stops/highway-401.mock.json";
import extendedFixture from "@/data/stops/highway-401.extended.mock.json";
import type { Need, StopCandidate } from "@/lib/domain/types";
import { exitLabel, nearestExit, pointAtKm } from "@/lib/route/route";

/**
 * Fixture stops are FICTIONAL businesses. Their position along the route is kept, but their
 * map location is anchored to the real road geometry and labelled with the nearest real
 * eastbound exit (OSM), so the map and exit numbers are truthful while the business stays mock.
 */
export function anchorToRoute(stop: StopCandidate): StopCandidate {
  const exit = nearestExit(stop.distanceAlongRouteKm);
  const p = pointAtKm(stop.distanceAlongRouteKm);
  // offset ~400 m to the right of travel so the marker doesn't sit on the highway line
  const rightBearing = ((p.headingDeg + 90) * Math.PI) / 180;
  const dLat = (0.4 / 110.57) * Math.cos(rightBearing);
  const dLng = (0.4 / (111.32 * Math.cos((p.lat * Math.PI) / 180))) * Math.sin(rightBearing);
  return { ...stop, lat: p.lat + dLat, lng: p.lng + dLng, exitId: exit.id, exitLabel: exitLabel(exit), exitKm: exit.km };
}

const anchoredBase = (baseFixture as { stops: StopCandidate[] }).stops.map(anchorToRoute);
const anchoredExtended = (extendedFixture as { stops: StopCandidate[] }).stops.map(anchorToRoute);

/** Every fixture stop (both passes), anchored — for map display and the client-side watcher. */
export function allFixtureStops(): StopCandidate[] {
  return [...anchoredBase, ...anchoredExtended];
}

export interface PlaceProvider {
  name: string;
  isMock: boolean;
  /**
   * Discover candidate stops along the corridor.
   * pass: "initial" searches the primary fixture; "nextExits" performs a bounded
   * second search over the next one or two exits beyond the initially considered window.
   */
  getCandidates(pass: "initial" | "nextExits", opts: { minKm: number; maxKm: number; needs: Need[] }): Promise<StopCandidate[]>;
}

export class MockPlaceProvider implements PlaceProvider {
  name = "mock-places";
  isMock = true;
  async getCandidates(pass: "initial" | "nextExits", opts: { minKm: number; maxKm: number; needs: Need[] }): Promise<StopCandidate[]> {
    const base = anchoredBase;
    const extended = anchoredExtended;
    if (pass === "initial") {
      return base.filter((s) => s.distanceAlongRouteKm >= opts.minKm && s.distanceAlongRouteKm <= opts.maxKm);
    }
    return extended.filter((s) => s.distanceAlongRouteKm >= opts.minKm && s.distanceAlongRouteKm <= opts.maxKm);
  }
}

export function getPlaceProvider(): PlaceProvider {
  return new MockPlaceProvider();
}
