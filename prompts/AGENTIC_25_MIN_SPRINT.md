# UNCONGEST: 25-minute agentic build sprint (highest priority)

This document overrides previous priorities where they conflict. **Improve the EXISTING working MVP/PR, never start from scratch.** Aim for the highest amount of **working, tested, user-visible functionality** possible in a single 20–25 minute coding session. Time is a target, not a guarantee; do not waste the interval or inflate scope with scaffolding. Work in short implementation/test/repair loops, delegate independent tasks to subagents if supported, and commit improvements.

## The product
An adaptive **conversation → structured collective intent → live/simulated context → explore candidate stops 0–2 times → validate → recommend 1–3 choices** engine usable from web chat today and WhatsApp/voice later. Context can include current approximate locations/headings/speeds of 1–3 cars, destination, duration since departure/last completed stop, hunger, tiredness/traffic, kids/restrooms, food/diet, EV+charger, weather/daylight, detour tolerance and feedback/rejected stops.

## CRITICAL: contextual preferences, not unconditional bans
- **Never globally exclude Walmart counters, ONroutes, poorly reviewed chains, etc.** If user has 5 minutes, bad weather, an urgent restroom need, or it's the only feasible stop, recommend the appropriate option with candid caveats. If group is relaxed and sunny, a 10-minute detour to a stronger alternative can win.
- Hard bans are only explicit user safety/accessibility/dietary constraints, reachable exits, supported chargers, legal routes, etc. 'Prefer standalone Tim Hortons' is a soft preference, not a categorical filter.
- Don't conflate crowds and congested highway traffic: infer **possible plaza congestion** as uncertainty, not a verified queue.
- When 3 options are not actually feasible, return fewer. No invented places, reviews, drive minutes, bathroom cleanliness or charger availability.
- Never advise unsafe speed or last-minute exits.

## Core architectural pipeline
A. **Parse**: model-agnostic intent schema from text with evidence, hard/soft constraints, urgency, party/vehicle details, unknowns and confidence. Preserve latest explicit instruction over defaults. A direct 'coffee' request remains coffee regardless of hunger=3. Merge different passenger intents without silently dropping conflicts.
B. **Enrich**: contextual trip snapshot with provenance and freshness (user, live, simulated, derived), weather (Open-Meteo optional), actual local time, last-stop-completed timestamp, ETA, approximate vehicle positions, optional battery percentage. Never infer unreported stop time.
C. **Discover**: look ahead along route, first 1–2 exits then later 1–2 exits when needed, route/detour matrix from provider or clearly tagged simulated fixture.
D. **Explore boundedly**: decision agent uses tools/actions `VERIFY_STOP`, `SEARCH_NEXT_EXITS`, `FIND_BUNDLE`, `COMPARE_STOP_NOW_VS_LATER`, `ASK_ONE_QUESTION`, `RECOMMEND`, `STAY_SILENT`. Max 2 exploration rounds, max ~8 candidate POIs per round, bounded latency and cost, stop when user urgent or approaching exit deadline. Deterministic tool adapters implement searches and feasibility; LLM chooses whether more information changes the decision.
E. **Verify and rank**: hard constraints (route reachable, advance notice, dietary if hard, charger compatibility, available/open), then soft, scenario-dependent ranking (ratings, restrooms, convenience, traffic uncertainty, distance, weather, group wait). Low ratings and Walmart/ONroute are **penalties with explanation**, not default rejection. Build compound stop options (charger+food) if verified walkable and accessible.
F. **Return**: typed JSON with top 1–3 options and classification FASTEST / BEST_FIT / MULTI_NEED; candidate IDs, verified detour and per-car ETA, human-readable reasons, tradeoffs, source/freshness/confidence and optional future stop time; Yes/Next/No and Maps handoff. Log investigation trace with tool calls, candidate rejection reasons and reason for stopping.
G. **Model-independent adapters**: `IntentModel` / `DecisionModel` interfaces, mock deterministic fallback plus Mistral adapter behind env. Keep existing API backwards compatible. No multi-model orchestration complexity unless core works.

## UX to ship
- Most prominent: text chat with scenario chips ('Quick coffee', 'Very hungry', 'Kids need bathroom', 'EV charge + meal', 'In a hurry, nearest stop', 'Prefer better stop even with detour').
- Inputs: 1–3 cars adjustable progress/location and approximate speed; trip elapsed/last stop; hunger, children, EV, weather, daylight, traffic, detour, hurry vs leisurely.
- Recommendation cards with 1–3 actionable choices, individual tradeoffs, verified-vs-simulated badge, and accept/next/decline.
- 'How Uncongest thought' inspector showing 0/1/2 exploration steps and why it searched or stopped.
- Demo must work with ZERO API keys using labeled simulated Highway 401 stops including: highway plaza, Walmart-embedded coffee counter (fictional), standalone coffee, Subway-like chain, meal restaurant, charger + café, restroom stop. Add fixtures as needed.
- Weather live when available; use gracefully labeled simulated fallback. Keep no native app or background GPS claim.

## Critical acceptance scenarios (automate)
1. Urgent coffee + Walmart counter nearest/open: prefer it if truly fastest; explain no drive-through if known, not invent.
2. Relaxed group + sunny: explore one or two later exits and prefer better standalone coffee within detour allowance.
3. Heavy traffic near ONroute: compare plaza vs detour; congestion risk marked *hypothesis*, not fact.
4. Kids + urgent restroom in bad weather: short accessible restroom first, regardless of modest review score.
5. Hunger 3, 2 hours to destination: substantial food along the route rather than waiting until destination.
6. EV low battery + meal: verify compatible charging and food bundle; no unverified cross-highway walk.
7. All-vegetarian group: verify suitability as hard requirement if specified.
8. No completed stop timestamp => unknown, not fabricated.
9. Multiple people want different stops => summarize competing needs and tradeoffs.
10. If exit too near or already passed => reject it; safe later exit.
11. Model bad JSON/hallucinated POI ID/timeout => deterministic fallback.
12. No meaningful need => STAY_SILENT.
13. No feasible choices => transparent inability/one clarification, no invented recommendation.
14. 'No, not that one' => remember rejection without permanently banning chain.

## Work plan — 25-minute focus, not a fixed deadline
First make core reusable adaptive engine and deterministic exploration/test scenarios work; then surface it in current chat/map UI; then optionally add actual weather/voice/providers if time permits. No auth, WhatsApp webhook, Supabase, native GPS, new landing page, full route replacement, cosmetic redesign until engine works.
Test after each change; run tests/typecheck/build, inspect UI via browser if supported, fix regressions. Run independent QA subagent only if delegation supported and worthwhile. Do not claim tests or visual checks that weren't performed. Commit to the existing PR branch (or follow-up PR) and give a verified feature list and limitations.

## Pragmatic implementation
Use existing TypeScript domain types and engine instead of replacing architecture; add Zod versioned schemas, controlled action/result union, pure exploration controller, route and POI provider interface, instrumentation. The agent's additional search budget should be bounded by *real* user value and safe route timing. If live provider keys absent, simulated fixture exploration still genuinely runs the controller (not static canned answers).

**Start coding immediately; no additional architecture-only proposal.**
