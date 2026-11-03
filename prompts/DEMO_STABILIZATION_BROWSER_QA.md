# Uncongest — stabilize the actual running demo (browser QA feedback)

## Continuation instructions
Continue on PR #1 branch `vibe/uncongest-mvp-2dfbf7`. **Do not restart, rewrite, replatform, or restructure. No arbitrary timebox.** This is a repair-and-verify sprint on the existing Next.js app, API, simulator, route engine, tests, fixtures, and provider interfaces. Preserve working architecture, and improve it incrementally until the user flow genuinely works in Chrome.

This report is based on cloud Chrome testing of commit `b5d2ed5`. Browser QA found the main recommendation flow broken, despite 33 passing unit tests and clean TypeScript.

## P0 — blocking end-to-end correctness; do these before any new features
1. **Make simulator → API contract valid**. Reproduce `HTTP 422` from `/simulate` on "All very hungry", "Ask now", and `/simulate?demo=1`. Inspect actual Zod response issues, not just the status. Current fixture cars B/C lack `role` and emit `needs:["dinner"]` although schema expects `meal`. Correct fixtures/source normalization with safe canonical values and valid car roles. Remove unsafe casts masking raw fixture/schema incompatibilities, use explicit adapters/Zod validation at fixture-to-domain boundary, and keep schema strict for real external requests. No silent dropping of inputs. Add an integration/contract test that sends the *actual simulator-generated* request through the API validation layer and gets 200, not 422.
2. **Persist collective preferences**. The current component reconstructs saved intent from defaults on every render. A message "We need halal food" adds halal only to the immediate request and "Ask now" loses it. Keep a single authoritative `CollectiveIntent` React state and merge each new message against that. Persist dietary requirements, needs, hunger, kids, detour limits and explicit corrections until changed/reset. Test chat -> Ask now; repeated chat; negation; mixed-car contributions. Do not erase existing vegetarian when adding halal; distinguish explicit remove vs new request.
3. **Correct error vs STAY_SILENT UX**. HTTP 422/500/network errors are FAILED decisions, never "Monitoring / no interruption needed". Clear or mark stale previous recommendations when a request fails; show a precise but user-friendly error with retry and troubleshooting detail. Render STAY_SILENT only when the response is a successful validated engine decision. Test both cases.
4. **Inspector must show full request + response + validation errors**. On 422 show status and Zod issue paths/messages. On 200 show structured result, understood/exploration/verified/rejected, which provider ran, and source flags. Keep information inspectable without exposing API keys.
5. **Fix scripted replay**. `/simulate?demo=1` must trigger real engine calls and display 1–3 valid recommendation cards. Replay should be deterministic, and Reset should restore the entire scenario state including car count/locations, clock, hunger, weather, traffic, collective intent, votes, approved stop, messages, errors, result, and log. The scripted trigger should replay after resetting when appropriate. Beware stale closures and timer cleanup.

## P1 — visible usability/accuracy
6. **Playback clock is mislabeled**. Existing 1× advances 10 simulated seconds per 100ms of real time (~100×). Choose correct honest semantics: 1× truly real-time; 10×/30× scaled appropriately; accelerated scripted demo mode explicitly labeled. Clamp at exactly t+240 and make displayed time/elapsed consistent (no 16:59 at t+240). Avoid accumulating float drift.
7. **Map layout and daylight**. Prevent overlapping car labels and clipped markers at the route endpoint. Collide/offset labels, bound to viewBox, use clustering/stacking indications for 2–3 nearby cars; preserve legibility on mobile. Make stop markers discoverable with hover/click legend/selection. Clamp tiny floating point daylight residues to zero and display rounded integer minutes.
8. **Make actions functional**. "Skip" should actually exclude that recommended stop from the current proposal and recompute/replan (unless user later explicitly reverses). Store votes indexed by stopId and carId, not a global vote for each car. Clear/reconcile approvals/votes when changing stop/reset. Maps handoff must use selected real/simulated coordinates with appropriate labeling.
9. **Transparent and safe choices**. When zero candidates, state unable to recommend, not successful silence if needs are active. Honor safety lead-time and dietary constraints; do not conflate low rated/walmart with universal exclusion. Do not invent places, live facts or queue times. Keep all mock data labeled.
10. After P0/P1 stable, enhance the requested demo minimally: 1/2/3 car selector; explicit driver vs copassenger message source; simulated driver voice transcript fallback; separate per-car intents. **Do not build these before the current recommendation flow works.**

## Browser acceptance checklist (required, not optional)
Use the actual running app via cloud Chrome / browser automation if available:
- Landing → /simulate works without transient runtime error.
- "All very hungry" sends a valid request and produces recommendation cards, not HTTP 422.
- "Ask now" after "We need halal food" preserves halal; engine may return no valid candidates transparently.
- /simulate?demo=1 produces valid recommendations; restart/reset works.
- Play/pause/scrub/clock speeds behave as labeled; no time or daylight float artifacts.
- Choose/approve/skip/vote per stop; decisions reflect actual state changes.
- Inspect request AND success response AND validation error detail.
- Cars and stop labels are readable, including t+240; test at mobile width.
- Validate a **real** no-trigger `STAY_SILENT` and a **real** error state separately.

Build Vitest integration/regression tests AND preferably Playwright browser tests that exercise the UI against the real API handler with real scenario fixtures. Unit tests alone are not sufficient. Run `npm run test`, `npm run typecheck`, `npm run build`, and smoke browser flows after repairs. If an automated browser isn't available, say so explicitly; don't claim to have visually verified. Preserve all passing tests, fix regressions, and commit tested improvements to existing PR branch.

## How to work
Begin by reproducing the 422, printing validation issue paths, and fixing P0. Don't pause at a plan or expand into live providers, WhatsApp, maps API redesign, agent frameworks, or cosmetic overhauls before demo works. Iterate implement → test → browser-check → fix. Delegate isolated QA/unit-test work to subagents when supported. Give a factual result: actual browser flows completed, new test counts, changes, remaining blockers and PR commit SHA. 
