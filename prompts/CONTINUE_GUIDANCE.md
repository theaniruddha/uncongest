# Guidance for continuing the existing Uncongest implementation

This is **guidance**, not a deadline, new architecture, or instruction to restart. Continue the current PR and working code. The earlier `AGENTIC_25_MIN_SPRINT.md` is a source of behavioral scenarios ONLY; disregard its timebox and any mandate to restructure.

## Mission
Improve the existing recommendation engine, chat experience, and tests incrementally. Preserve working interfaces and behavior. Each iteration: inspect current state → identify highest-value weakness → implement small improvement → test and inspect → fix regression → commit. Repeat while productive and permitted.

## Priorities
1. Interpret conversational and collective intent robustly; preserve evidence, uncertainty and explicit corrections.
2. Consider context together: urgency, hunger, kids, fatigue, last *confirmed* stop time, time of day, weather/daylight, traffic, EV needs, car positions/heading and detour flexibility. Do not invent missing values.
3. Avoid blanket exclusions: Walmart/ONroute/low ratings can be appropriate under urgency; compare with better later exits when flexibility permits.
4. Bounded 0–2 investigation rounds when information can change the decision; search/verify next exits, combined charger+food and alternatives; honor exit lead time.
5. Rank 1–3 real feasible options, with source/provenance and understandable tradeoffs; show investigation trace in existing inspector.
6. Retain deterministic reachability/safety checks, fallback on model failure, stable API, current UI and demo fixtures.
7. Expand tests covering urgent-vs-relaxed choices, group conflict, weather, stop history, poor-rating fallback, no hallucinated queue claims.

## Operating rules
No rebuilding from scratch, unnecessary agent proliferation, architecture upheaval, time limits or token-burning loops. Delegate independent QA or bounded implementation only if supported. Preserve passing tests and functional demo. Prefer working code over planning. Commit tested improvements and report actual verification.
