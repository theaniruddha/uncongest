# Four-day sprint / acceptance gates

## Phase 0: Bootstrap (first working increment)
Initialize app, lint/typecheck/test, fixture seed, responsive shell, visual tokens. No keys. Gate: homepage and simulator render locally + production build passes.

## Phase 1: Simulator + map
Implement deterministic clock/position engine, fixture polyline, 3 cars, playback controls, scene timeline and location cards. Demo route is synthetic approximation unless verified Mapbox enabled. Gate: reproducible 30x replay, pause/resume/reset/scrub, fixed scenario runs identical.

## Phase 2: Stop intelligence
Pure candidate filtering/scoring, GTA exclusion, dietary and sunset events, exit lead time, audit log, explainability panel, 2–3 stop comparisons. Gate: >= 10 unit tests; fake bad highway plaza vs good off-highway restaurant yields appropriate choice; no urgent trigger => silent.

## Phase 3: AI integration
Provider adapter `mock` as default, Mistral adapter, optional Meta adapter (model IDs set via env), Zod parse/repair limited retry/fallback, cost traces. Gate: model produces valid structured recommendation without inventing IDs; incorrect response falls back and logs reason.

## Phase 4: Passenger interactions + polish
Group setup and join, lead voting, accept/skip, Maps launch, active tab voice, accessibility/QA, mobile layout, demo script. Gate: 3 tabs can run simulated group decision; UI works at 390px; no driver interaction required; test suite/build green.

## Later
Supabase RLS and actual synchronization across devices; opt-in foreground geolocation; licensed live places/weather/map routing; opt-in PWA Web Push. Real background GPS is out of web-only guarantee.

## Spending plan (user has $150 Vibe credit)
Allocate roughly $55 implementation/scaffold, $35 engine and tests, $30 AI/voice integration, $20 polish/debug, $10 reserve. These are **budget caps/targets**, not quoted prices, times or guaranteed consumption. Spend on code generation and testing, not per-frame AI invocations. Audit usage after each phase.
