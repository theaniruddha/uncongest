# Uncongest — Mistral Vibe coding instructions

You are the principal full-stack engineer implementing this project. Read `README.md`, `docs/PRD.md`, `docs/ARCHITECTURE.md`, `docs/DECISION_ENGINE.md`, `docs/UX_SPEC.md`, and `docs/ROADMAP.md` before coding. Use `prompts/VIBE_MASTER_PROMPT.md` as the execution brief.

## North star
Build a beautiful, fully working **web** demonstration of proactive group travel intelligence on Highway 401. No React Native / native app. Users may keep Google Maps or Apple Maps as navigation. Be practical, decisive, and implement rather than endlessly plan.

## Nonnegotiable principles
1. **Offline demo first:** app loads and runs a deterministic Toronto→Montréal replay without needing Mistral, Mapbox, Supabase, or any other API key. Provide clearly marked mock route geometry, stops, ratings, times, weather, and reviews. Never silently pass mocks as live data.
2. **AI is not the router:** deterministic code checks reachability, max detour, exclusions, opening hours, dietary needs, notification lead time, position freshness, and group approvals. LLM chooses among prevalidated candidates and explains tradeoffs, including `STAY_SILENT`. Validate model output with Zod/JSON Schema, reject hallucinated IDs, and use a deterministic fallback on error.
3. **Safety:** do not suggest specific speed changes, speeding, slowing traffic, sudden exits or unsafe parking. If lead time is insufficient, reject that exit. Driver should not interact with multi-step UI; passenger approves. Solo mode is brief notification/voice only, subject to browser restrictions.
4. **Privacy:** location is off until explicit permission; trip invitations use unpredictable tokens; participants can leave and stop sharing; only group members see locations; ephemeral retention; secrets server-side. Browser geolocation is not reliable in background when Maps is active—never claim otherwise.
5. **App quality:** build functional controls, loading/empty/error states, event log and readable mobile UI. Avoid decorative buttons and fake integrations.
6. **Code quality:** strict TypeScript, small pure functions for simulation/scoring, provider interfaces, schema validation, unit tests for eligibility and notification timing, at least one end-to-end demo test.
7. **API cost:** throttle and cache; call LLM only on relevant triggers, never every render or GPS tick; add env `AI_PROVIDER=mock|mistral|meta`, API usage logging, timeouts, and graceful fallback. Do not spend money just to demo animation.
8. **Versioning:** commit coherent working increments. Keep `npm run build` and `npm run test` green. Record known limitations in README.

## Implementation order
A. Bootstrap Next.js + styles + fixture loading + deterministic simulator + map with offline fallback.
B. Build 3-car trip state, event playback, ETA/exit window logic, candidate filtering, and decision log.
C. Add recommendation panel and lead approval, car join/skip, cross-tab group state; start local, add Supabase adapter when ready.
D. Add pluggable live routing/Places/AI adapters behind toggles and real weather; never block demo if credentials are absent.
E. Add active-page speechSynthesis and opt-in Web Push where supported; live foreground location as optional experimental feature.
F. End-to-end tests, mobile QA, deployment instructions and demo polish.

## Project layout suggestion
`app/` routes; `components/` UI; `lib/domain/` pure engine; `lib/providers/` adapters; `lib/simulator/`; `data/` fixtures; `tests/` unit and e2e. Follow established Next.js conventions.

## Done means
`npm run dev` displays a compelling, interactive route demo; a user can start/replay/pause a simulated trip, trigger scenarios, see all three car ETAs, inspect why recommendations were made/suppressed, accept/skip, and open a Maps link. `npm run build` and tests succeed. No API key is required for demo.
