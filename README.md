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
The repository is **specification-first**. Mistral Vibe will scaffold the executable Next.js app. After scaffolding, expected commands are `npm install`, `npm run dev`, `npm run test`, `npm run build`, and `npm run test:e2e`. See [the build prompt](prompts/VIBE_MASTER_PROMPT.md).

**Never commit API keys, credentials, precise live location traces, or real traveler identities.** Demo data is synthetic; mock review quality and candidate locations are *not* claims about real businesses.

## Current status
**Working MVP implemented.** `npm install && npm run dev` starts a fully offline demo (no API keys required):

- `POST /api/recommend-stops` — the reusable engine endpoint: Zod-validated collective trip snapshot in, 2–3 ranked, explained stop recommendations out (or `STAY_SILENT`).
- `/simulate` — deterministic Highway 401 Toronto → Montréal simulation with 3 cars, play/pause/scrub/speed controls, interactive SVG corridor map, chat with sample utterance chips, scenario sliders (weather, traffic, hunger), recommendation cards with per-car detours and trade-offs, lead approve + per-car join/skip, Google Maps handoff, opt-in voice readout, request/response inspector, rejection reasons and event log. Open `/simulate?demo=1` for a scripted auto-run.
- Deterministic eligibility engine (lead time, GTA exclusion, hard dietary rules, EV charger compatibility, detour caps, group regroup wait, opening hours, stale-position degradation) with a pluggable AI provider (`AI_PROVIDER=mock|mistral`) that only ranks prevalidated candidates; hallucinated IDs are dropped and a deterministic ranker is the fallback.
- `npm run test` (20 unit tests), `npm run build`, `npm run typecheck` all green. All stop/route data is synthetic and labeled SIMULATION.

### Known limitations
- In-memory demo state (no Supabase sync yet); map is a schematic SVG, not map tiles; voice works only while the page is active; no background GPS claims.
