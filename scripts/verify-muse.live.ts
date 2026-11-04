import { afterAll, beforeAll, expect, it } from "vitest";
import { loadEnvConfig } from "@next/env";
import { interpretIntent } from "@/lib/providers/intentAgent";
import { POST } from "@/app/api/recommend-stops/route";
import { TORONTO_MONTREAL } from "@/lib/route/route";
import { runStrategicPlanner } from "@/lib/agent2/strategic";
// Opt-in only: each test makes one real Muse call; never included by npm test.
// All three tests share a hard cap of three HTTP requests and fixture-only provider evidence.
const realFetch = globalThis.fetch;
let networkCalls = 0;
beforeAll(() => {
    loadEnvConfig(process.cwd(), true);
    process.env.UNCONGEST_MODE = "live-muse";
    process.env.AI_PROVIDER = "meta";
    process.env.TOMTOM_LIVE = "0";
    const modelHost = new URL(process.env.META_API_BASE || "https://api.meta.ai/v1").host;
    globalThis.fetch = async (url, init) => {
        if (new URL(String(url)).host !== modelHost)
            throw new Error("Non-Muse network disabled for verification");
        networkCalls++;
        if (networkCalls > 3)
            throw new Error("Live verification call cap");
        return realFetch(url, init);
    };
});
afterAll(() => { globalThis.fetch = realFetch; });
const ref = {
    id: TORONTO_MONTREAL.id, origin: {
        label: "Toronto", lat: 43.65, lng: -79.38, type: "home" as const
    }, destination: {
        label: "Montréal", lat: 45.50, lng: -73.57, type: "hotel" as const
    }
};
it("Agent1 live intent with fixture context", async () => {
    const started = Date.now();
    const intent = await interpretIntent({
        carId: "car_a", source: "copassenger_text", text: "We are vegetarian and hungry; a quick lunch please", localTime: "12:00", cars: [{
                id: "car_a", label: "Car A"
            }], current: {
            car_a: {
                needs: [], hungerLevel: 0, restroomUrgent: false, notHungry: false, dietary: [], kids: false, history: []
            }
        }
    });
    console.log(JSON.stringify({
        verification: "Agent1", model: process.env.AI_MODEL || "muse-spark-1.3", isMock: intent.isMock, provider: intent.provider, ms: Date.now() - started, updateCount: intent.updates.length, fallbackReason: intent.fallbackReason
    }));
    expect(intent.isMock).toBe(false);
});
it("tactical live decision with fixture evidence", async () => {
    const body = {
        trip: {
            destination: "Montréal", direction: "eastbound", highway: "401", elapsedMinutes: 150, localTime: "12:00", localDate: "2026-11-04", minutesSinceLastStop: 60, lastMealMinutesAgo: null
        },
        config: {
            avoidRegion: "GTA", noOptionalStopsFirstMinutes: 60, maximumDetourMinutesPerCar: 12, maximumRegroupWaitMinutes: 15, advanceNoticeMinutes: 10, requiredDiet: [], groceriesCompleted: false, passengerLed: true
        },
        cars: [{
                id: "car_a", label: "Car A", role: "lead", progressKm: 180, speedKph: 100, passengers: 2, kids: false, ev: false, positionUpdatedMinutesAgo: 0, needs: ["meal"]
            }],
        collectiveIntent: {
            need: ["meal"], hungerLevel: 2, dietary: ["vegetarian"], maxDetourMinutes: 12, kids: false, restroomUrgent: false, notHungry: false
        },
        environment: {
            weather: "sunny", trafficDelayMinutes: 0, daylightMinutes: 300
        },
        options: {
            weatherMode: "simulated", excludeStopIds: []
        },
        context: {
            route: ref, dataMode: "demo", workflow: "tactical", contextVersion: "verification", sessionId: "live-verification", timeZone: "America/Toronto"
        }
    };
    const response = await POST(new Request("http://local/api/recommend-stops", {
        method: "POST", body: JSON.stringify(body)
    }));
    const tactical = await response.json();
    console.log(JSON.stringify({
        verification: "Agent2 tactical", status: response.status, isMock: tactical.isMock, inferenceSource: tactical.inferenceSource, tacticalStatus: tactical.tactical?.status, ms: tactical.tactical?.totalMs, recommendationCount: tactical.recommendations?.length
    }));
    expect(tactical.inferenceSource).toBe("Live");
});
it("strategic live plan with fixture evidence", async () => {
    const strategic = await runStrategicPlanner({
        routeRef: ref, routeVersion: "fixture", contextVersion: "verification", sessionId: "live-verification", timeZone: "America/Toronto", departureUtc: "2026-11-04T14:30:00Z", elapsedMinutes: 150, leadKm: 180, leadSpeedKph: 100, localTime: "12:00", needs: {
            car_a: ["meal"]
        }, mood: ["hungry"], mealPreference: "quick_bite", mealHistory: {
            kind: "unknown"
        }, lastMealMinutesAgo: null, dietary: ["vegetarian"], kids: false, drivingMinutesSinceRest: 60, dataMode: "demo"
    }, {
        noCache: true
    });
    console.log(JSON.stringify({
        verification: "Agent2 strategic", status: strategic.meta.status, provider: strategic.meta.provider, ms: strategic.meta.ms, opportunities: strategic.plan.opportunities.length, error: strategic.meta.muse?.error, networkCalls
    }));
    expect(strategic.meta.status).toBe("completed");
});
