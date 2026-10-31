# Vibe next iteration — live adaptive reasoning (PR #1 follow-up)

Objective: upgrade the existing implementation on `vibe/uncongest-mvp-2dfbf7`, NOT recreate it. First merge/rebase consciously; work on branch from current PR. Preserve all 20 existing tests.

## Must build
1. **Event-sourced trip state** with `startedAt`, `completedStops[{id,arrivedAt,departedAt,confirmedBy}]`, `lastStopAt`, `lastPositionAt`, `timezone`, explicit `hunger`/fatigue with `source` and `confidence`. Calculate elapsed and since-last-stop from timestamps; if missing show UNKNOWN, never assume. Use ISO timestamps/timezone-correct conversion and simulated clock for demo.
2. **Context aggregator** `getTripContext`: time-of-day, weather *at projected candidate arrival location/time*, daylight/sunset, traffic delay, live location freshness, speed/heading, party needs. Every datum carries `source=live|user|simulated|derived`, `observedAt`, `confidence`, and `stale`.
3. **Live weather adapter**: Open-Meteo current/hourly forecast via server-side fetch, with caching 10–15 minutes, timeout, and mock fallback clearly labeled. Use relevant coordinates and expected arrival times. Explicitly support live-mode demo; do not block offline mode.
4. **Intent extraction adapter**: Mistral/other model structured JSON via schema, with `intent`, `entities`, `urgency`, `hardRequirements`, `softPreferences`, `missingFields`, `confidence`, `evidenceSpans`. Merge new message into collective state without erasing other passengers' requirements; explicit overrides only. Deterministic mock fallback; protect against prompt injection in reviews/chat.
5. **Multi-model abstraction**: `IntentModel.parse`, `ReasoningModel.rank`; adapters/mock, Mistral and configurable Meta. Different models for extraction and ranking via env. JSON schema validation + retry-once for malformed output + deterministic fallback; record model IDs, latency and token use if provider reports it.
6. **Adaptive tradeoffs**: replace blanket bad-weather multiplier with weather-dependent scoring features and reasoned constraints. Allow a nearby indoor stop on poor weather; sunny permits discretionary scenic/quality detour, but do not compromise safe exit lead time or urgent needs. Low review rating remains a soft penalty, never total exclusion. Traffic ahead of a plaza can be labeled a congestion risk, NOT proven queue.
7. **Live Places / route provider interfaces** with licensed provider integration if key available; Google Places Text Search along route plus routingSummaries and routing verification recommended, otherwise simulations. No invented businesses or reviews. Prioritize working deterministic route corridor before buying APIs.
8. **Decision inspector UI**: display structured input, provenance, hard constraints, filtered candidates, LLM rationale, scores, chosen 2–3 options; toggles live/simulated, rain/sun, stop completed/not, car/EV/children. If no live key, show clearly that routes and places are simulated.
9. **Tests and validation**: timestamp/stop-history calculations, timezone rollover, stale weather, schema malformed/unknown, conflicting group preferences, location/route staleness, indoor weather choice, low-quality-only fallback, EV+restaurant combo, hallucinated IDs and model provider failure. Run typecheck/build/test and browser smoke where possible; fix and iterate.

## Key core safety
Never assume background browser GPS updates under lock; never instruct speed changes or last-minute exits; never treat selected stop as visited. Show missing facts honestly. Never place secret keys in client bundles. Avoid generating fake route distances, reviews, queue times or proven amenities.

## API contract
`POST /api/interpret-intent` for messages (optional facade), `POST /api/recommend-stops` remains canonical; optional `GET /api/context/weather?lat&lng&at`. Return structured, validated and versioned data; keep provider adapters reusable for WhatsApp/voice later.

## Loop
Implement next best vertical slice; test; inspect via browser if supported; fix; repeat. Prioritize real usability. Ask no nonessential questions. Commit to existing Vibe feature branch or a clearly identified follow-up PR. Summarize features verified vs still simulated.
