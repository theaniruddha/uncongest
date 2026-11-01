import baseFixture from "@/data/stops/highway-401.mock.json";
import extendedFixture from "@/data/stops/highway-401.extended.mock.json";
import type { Need, StopCandidate } from "@/lib/domain/types";

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
    const base = (baseFixture as { stops: StopCandidate[] }).stops;
    const extended = (extendedFixture as { stops: StopCandidate[] }).stops;
    if (pass === "initial") {
      return base.filter((s) => s.distanceAlongRouteKm >= opts.minKm && s.distanceAlongRouteKm <= opts.maxKm);
    }
    return extended.filter((s) => s.distanceAlongRouteKm >= opts.minKm && s.distanceAlongRouteKm <= opts.maxKm);
  }
}

export function getPlaceProvider(): PlaceProvider {
  return new MockPlaceProvider();
}
