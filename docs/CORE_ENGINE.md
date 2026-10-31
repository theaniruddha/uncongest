# Uncongest — Reusable Core Decision Engine (supersedes earlier prioritization)

## Product principle
Build one reusable service, independent of delivery channels: `POST /api/recommend-stops`. Its input is a **structured collective trip snapshot**; output is **2–3 ranked, feasible, explained stop bundles** (or fewer if nothing valid). The conversational web UI and Highway 401 multi-car simulator are the first clients. WhatsApp, voice and real GPS will plug in later. Do not focus on transport integrations before engine and demo work.

## Architecture
1. **Intent extraction** (LLM or deterministic fallback): parse freeform chat e.g. "quick coffee", "kids need bathroom", "all very hungry", "EV charge and lunch" into schema. Preserve unexpressed information as unknown; don't overwrite saved group preferences unless explicitly changed.
2. **Collective context reducer** merges intents from all passengers, trip info, real/simulated vehicle coordinates+speed+direction, car attributes (EV, charge level when supplied), elapsed time, time of day, traffic delay and fatigue hints, daylight, forecast and max detour. Record confidence/provenance/freshness of data. Do not infer hunger or EV charge without input.
3. **Candidate discovery** fetches suitable POIs ahead along travel corridor, possibly multiple POIs within a nearby walking-distance *stop cluster* (e.g. verified Tesla Supercharger + restaurant across street). Provider adapters: mock default; optional Places/Maps/Charging providers. Use provider-backed opening hours, connectors, charger access/compatibility and verified walkability. Do NOT assume one street can safely be crossed.
4. **Deterministic eligibility**: ahead-of-car direction, legal reachable exit, adequate lead time, route detour/ETA per car, dietary hard constraints, parking/charging compatibility, opening hours, privacy/location freshness. Don't reject low ratings automatically. If no high-quality choices exist, show best available with warning and option to defer.
5. **Tradeoff scoring**: quality, per-car detour, wait/time, access, needs, traffic congestion *risk* and weather; weather influences *detour tolerance*, not binary exclusion. Downweight low-confidence predictions: queue at ONroute due to upstream traffic is only a hypothesis unless measured. Weather good may justify discretionary detour; poor weather may favor quick reliable nearby stop. Consider long gaps to next facilities, tiredness and sunset. No unsafe speed advice.
6. **LLM reasoning** over up to 10 already-eligible stop bundles; picks/rationalizes 2–3 distinct options, e.g. FASTEST, BEST_FIT, ALTERNATIVE, each with verified candidate IDs, reasons, tradeoffs, and uncertainties. Model never invents ETA, score, review, place or charger facts. Validate JSON schema + candidate IDs + latest positions; fallback deterministic ranker on failure.
7. **Structured result**: stop bundle IDs, rank, optional nearby second facility, user-facing explanation, each car's additional drive minutes and ETA, review-summary provenance, confidence, known risks, navigation destination, safety warning and whether passenger approval required.
8. **Action**: user chooses option; accepted stop added to Uncongest's trip waypoint list and directions URL handed off to Google/Apple Maps. Don't promise injection into another app's active route; launch a new navigation request.

## Simplest real demo
- Web chat: text field + send; sample utterance chips; sidebar settings for 1–3 cars with manually adjustable approximate position and speed; EV toggle per car; hunger 1–3; kids; weather preset; time-of-day and traffic delay sliders.
- Visual Highway 401 corridor map (fictional stop data clearly labeled SIMULATION). 3 suggested stop cards tied to route. Example scenarios:
  A: "Quick coffee" -> nearest convenient coffee vs slightly better alternate.
  B: "We are very hungry, kids need washrooms" -> restaurant with verified toilets versus limited facilities.
  C: EV in car B, request coffee + charge -> eligible charger-plus-food bundle; if none, explain and suggest separate stops.
  D: Heavy traffic near ONroute + weather sunny -> compare congestion-risk plaza against short off-highway detour; flag congestion as *unverified hypothesis* unless queue data available.
  E: Cold/rain -> shorter safer nearby options; skip excessive detours.
  F: Low-quality-only corridor -> still provide best available option with transparent caveat.
- Demonstrate same `/api/recommend-stops` endpoint invoked by the chat and by scenario controls; store its validated request/response in developer inspector.
- Tests: intent merging, unknown fields, EV compatibility, composite stop feasible walking distance, min lead time, low-rating fallback, option diversity, weather sensitivity, no fabricated queues, correct per-car ETAs, and model invalid ID fallback.

## Example input (simplified)
```json
{
  "trip": {"destination":"Montréal","direction":"eastbound","highway":"401","elapsedMinutes":125,"localTime":"17:10"},
  "cars": [{"id":"car_a","lat":44.05,"lng":-77.9,"speedKph":95,"passengers":3,"kids":true,"ev":false},{"id":"car_b","lat":44.0,"lng":-78.1,"speedKph":90,"passengers":2,"ev":true,"connector":"NACS","batteryPercent":24}],
  "collectiveIntent": {"need":["meal","restroom","ev_charge"],"hungerLevel":3,"dietary":["vegetarian"],"maxDetourMinutes":12},
  "environment": {"weather":"sunny","trafficDelayMinutes":25,"daylightMinutes":95}
}
```
Coordinates and speeds above are illustrative and may not be on the actual route; production requires snapping and validation.

## Implementation requirements for Vibe
Read this document before implementing the engine. This file now overrides the earlier simulator-first instruction where inconsistent. Deliver a working chat and recommendation UI first. Mock fallback works without keys, then wire real APIs. Iterate/test/visual-check; use optional subagents if the Vibe runtime supports it. Never claim web background GPS reliability.
