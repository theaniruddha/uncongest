# Uncongest

**Less stress between A and B.**

Uncongest is a web-first AI road-trip companion that works *alongside* Google Maps or Apple Maps. It predicts useful stops before they become urgent, compares verified options, and coordinates groups of 2–3 cars without requiring everyone to navigate in a new app.

## First demo: Highway 401
Simulate three cars traveling Toronto → Montréal. One car has children, the group needs vegetarian dinner, stops in the GTA are excluded, and a candidate exit is approaching. Watch the cars progress, see deterministic trigger/feasibility checks, inspect an LLM recommendation, let a lead passenger approve it, and open directions in a preferred maps app.

### MVP
- Responsive Next.js web app with route map, scenario playback, 1–3 car positions, shared trip lobby, and passenger-first UI.
- Deterministic trip simulation that works with **no API keys**.
- AI decision adapter with verified candidate inputs, schema-validated responses, and a functional mock fallback.
- Event log explaining when the agent recommends a stop **and when it stays quiet**.
- Lead-passenger approval + per-car join/skip; solo mode only provides non-distracting alerts.
- Geography filter: "avoid GTA" and "no optional stops in first 60 minutes"; override only for urgent needs.
- Source/destination and location-sharing flows are explicitly future-ready, never presented as reliable background web GPS.

## Repo navigation
- [AGENTS.md](AGENTS.md) — Mistral Vibe's project instructions and safety guardrails.
- [Product requirements](docs/PRD.md)
- [Architecture and contracts](docs/ARCHITECTURE.md)
- [Decision engine](docs/DECISION_ENGINE.md)
- [Milestones and acceptance tests](docs/ROADMAP.md)
- [Demo script](docs/DEMO_SCRIPT.md)
- [UX / brand specification](docs/UX_SPEC.md)
- [Assumptions and open questions](docs/QUESTIONS.md)
- [First Vibe prompt](prompts/VIBE_MASTER_PROMPT.md)
- [Simulated corridor seed](data/scenarios/highway-401.json)
- [Sample candidate stops](data/stops/highway-401.mock.json)
- [Decision JSON schema](schemas/stop-decision.schema.json)

## Proposed stack
Next.js App Router / TypeScript / Tailwind / shadcn/ui / Mapbox GL JS (optional MapLibre/OSM demo fallback), Supabase PostgreSQL + Realtime when enabled, Zod, Vitest, Playwright, Mistral or a configurable hackathon model provider, Open-Meteo.

## Run and development
```bash
npm install
npm run dev          # http://localhost:3000/simulate  (works offline with AI_PROVIDER=mock)
npm run test         # Vitest unit + route-handler contract tests
npm run test:e2e     # Playwright in system Chrome; starts its own mock-AI server on :3124
npm run typecheck && npm run build
```
`.env` (never committed): `AI_PROVIDER=mock|meta|mistral`. For Meta Muse set `MODEL_API_KEY` (or `MUSE_API_KEY`); optional
`AI_MODEL` (default `muse-spark-1.3`), `META_DECISION_REASONING_EFFORT` (default `medium`), `META_INTENT_REASONING_EFFORT`
(default `low`), `META_MAX_OUTPUT_TOKENS`, `META_TIMEOUT_MS`, `LLM_MAX_CALLS_PER_10_MIN` (default 30, process-wide cost guard).
Regenerate the cached route/exit fixture with `node scripts/build-route-fixture.mjs` (one-off; the app never calls OSRM/Overpass at runtime).

**Never commit API keys, credentials, precise live location traces, or real traveler identities.** Stop businesses are fictional; their *locations and exit numbers* are real.

## Trip simulator (`/trip`) — configurable, real-data
Pick an origin and destination (search, presets, or "Use current location"), depart-at or arrive-by, mood, meal preference, diets, kids, meal history, 1–3 cars — or describe the trip in plain English and review Agent 1's suggestions before applying. Then **Plan route & start simulation**:

1. `/api/route` resolves a **real route** (OSRM) with **real exits** (OSM `motorway_junction`, or OSRM ramp steps when Overpass is down — labelled). Unresolvable trips show a clear error and suggest the 401 demo; geometry is never invented.
2. Deterministic **opportunity windows** (meal times, rest breaks, coffee) pick a few road segments; `/api/places/prefetch` discovers **real places from OpenStreetMap** only there (30 km tiles, cached in memory + disk + committed recordings). More is fetched lazily only when a need is active and nothing is known ahead.
3. The car moves along the real geometry in simulated time. The **ambient watcher** calls **Agent 2** only when a decision is useful; simulated time pauses while it decides.
4. Agent 2 runs the deterministic checks, the urgency-bounded horizon, **Open-Meteo forecasts at each stop's arrival time and at the destination** (real forecast date shown), and one LLM call. Results show detour, editable stop length, **destination-ETA impact** and arrival daylight.
5. **Stop lifecycle**: Select → drive there / skip ahead → ARRIVED (paused) → spend N min → confirm what actually happened (nothing is assumed) → COMPLETED → Resume. ETA, last stop, driving-since-rest (reset after ≥ 60 min) and meal history update; each car's participation is independent.

**Data labels**: "REAL · OSM" places vs "FICTIONAL DEMO" fixtures (401 demo preset only); routes show `osrm` / `cache` / `fixture`; weather shows Open-Meteo vs simulated/unavailable; recorded data shows its date.

**API budgets** (server-side, per process, shown in the inspector): TomTom is **off** unless `TOMTOM_LIVE=1` (+ `TOMTOM_API_KEY`), then capped per hour and per session and used only for along-route fallback/verification. Overpass, OSRM, Nominatim (1 req/s) and Open-Meteo are budgeted and cached. Override with `<PROVIDER>_WINDOW_LIMIT`, `<PROVIDER>_SESSION_LIMIT`, `<PROVIDER>_WINDOW_MS`.

**Recordings**: `npx vitest run --config vitest.record.config.ts` records preset routes + their OSM tiles to `data/recorded/` (committed; served as cached data with its date).

### Hosting for friends
- Keep secrets server-side (`MODEL_API_KEY`/`MUSE_API_KEY`, `TOMTOM_API_KEY`); leave `TOMTOM_LIVE` unset unless you want live TomTom.
- Set `LLM_MAX_CALLS_PER_10_MIN` (default 30) and conservative Overpass/OSRM/Nominatim limits; budgets are in-memory per server instance.
- Public OSRM / Overpass / Nominatim demo servers have usage policies and no SLA — for real traffic, point `OVERPASS_URL` at your own instance and use a hosted router.
- Runtime caches go to `UNCONGEST_CACHE_DIR` (default `.cache`, `/tmp/uncongest-cache` on Vercel).

## Current status
**Architecture: two bounded agents + deterministic context layer + deterministic watcher.**

- **Agent 1 — Intent & Conversation** (`POST /api/intent`, `lib/providers/intentAgent.ts`): one LLM call per driver voice transcript or co-passenger message → Zod-validated per-car updates (needs, hunger, urgent restroom, diet, kids, corrections such as "actually no coffee" / "we already ate"). Unknown car ids dropped; regex parser fallback.
- **Context layer** (`app/api/recommend-stops/route.ts`, `lib/domain/carIntent.ts`, `lib/route/route.ts`, `lib/providers/weather.ts`): one authoritative per-car intent state (persistent diet/kids; temporary needs expire after 120 min or clear at a confirmed stop); car positions/heading on the real route; live Open-Meteo weather at each car now and at each candidate stop at its ETA (cached 30 min per 0.1° cell; failures labelled, simulated fallback).
- **Agent 2 — Exploration & Decision** (`POST /api/recommend-stops`, `lib/domain/engine.ts`): deterministic hard checks (exit notice, reachability, detour, region, hours, diet, EV), then an **urgency-bounded horizon** — high: nearest suitable exit(s) ≤ 60 km, nearest-first; moderate: next 1–2 usable exits ≤ 120 km; low: up to 220 km for a better stop/weather — widened at most once, plus one bounded second search. One LLM call ranks the validated candidates (or STAY_SILENT, allowed only at low urgency). Notes limited facilities ahead.
- **Ambient Trip Watcher** (`lib/domain/watcher.ts`, pure): runs every tick in the page; calls Agent 2 only when urgency is high, a suitable exit is approaching with enough notice, a recommendation became unusable (missed/skipped), or urgency/needs changed. Dedupes and rate-limits; quiet while a recommendation is still actionable or a stop is confirmed. Works only while the page is open — no background GPS claims.
- **Diet:** vegetarian/vegan = veg-friendly preference (Subway-style chains and plazas are fine; steakhouse/bar-style diners excluded, only for meal stops). Halal/gluten-free are strict for meal stops.
- **Map** (`components/TripMap.tsx`, Leaflet + OpenStreetMap tiles, no key): real 547 km OSRM road geometry, 98 real eastbound 401/A-20 exits (OSM), 1–3 independently moving cars with heading/speed, click-to-place or drag (snaps to the route), recommended stops ranked. **Road ahead** strip (`components/RoadAhead.tsx`): next ~160 km with exits, stops, notice zone, limited-facility gaps and ETA weather.
- `/simulate` controls: departure time, honest playback rates (1× = real time … 300×), scrub, per-car speed / kids / frozen GPS, add/remove cars, live vs simulated weather, meal history (unknown by default), skip (excludes + re-plans) / approve / per-stop per-car votes, request/response inspector for both agents, event log. `/simulate?demo=1` auto-runs the one-car lunch scenario.

### Known limitations
- `/trip`: public Overpass servers were overloaded during development (20–70 s per query, frequent timeouts); discovery then degrades to fewer/no real places, clearly traced. Recordings cover the presets.
- `/trip`: OSM rarely has opening hours, menus or restroom access — shown as unverified, never invented. TomTom category ids for along-route search are unverified until TomTom is enabled.
- Sunset/daylight uses the NOAA solar algorithm at the destination; time zone is the origin's (via Open-Meteo), so cross-time-zone trips show times in the origin zone.
- Stop businesses, ratings and hours are fictional fixtures (anchored to real exits); no live Places provider yet.
- In-memory demo state (no Supabase sync); the watcher stops when the tab is suspended.
- Simulated cars use constant cruise speed; no live traffic. OSM tiles need network (route/exits still draw offline).
- Meta Muse at medium reasoning effort takes ~15–25 s per decision.
