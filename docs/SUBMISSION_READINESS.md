# Submission readiness audit — 2026-11-04

The actual repository is the nested `uncongest/` workspace. The starting branch was `feature/real-data-trip-sim` at `6398c93`, with no uncommitted changes. Work is isolated on `submission/readiness`; no existing changes were discarded.

## Outcomes and dependency order

| Task | Dependency | Verifiable success criterion |
| --- | --- | --- |
| Preserve baseline | Inspect actual Git status and instructions | Separate branch; original commit retained |
| Routing/data audit | Baseline | Safe fixture provenance; no TomTom recordings; zero live TomTom requests |
| Explicit deployment modes | Routing and Muse inspection | Unset mode is Demo; local evidence works in Demo and Live Muse; Full Live explicit |
| Muse/context reliability | Deployment policy | Same key aliases; accepted live results distinguished from fallback; stale replies rejected |
| Focused UX | Mode and provenance contract | Connections status; reproducible one-car preset; honest evidence and inference labels |
| Automated QA | Implementation | Typecheck, units, production build, browser demo and failure/race cases |
| Submission instructions | Verified behavior | README + env example + data notices + reproducible demo steps |

Inspections were delegated to Routing/Data, Muse/Context and QA/UX with separate file ownership. QA alone controlled the browser. Dependent changes were consolidated by the lead.

## Actual architecture and retained behavior

Two runtime agents already existed. Agent 1 parses messages and setup descriptions; Agent 2 runs tactical recommendation and strategic look-ahead workflows. Both use deterministic shared context, bounded model calls and output validation. The ambient watcher controls when decisions are useful. Strategic planning was implemented before this audit, including future windows, place evidence, weather, destination daylight, alternatives, expiry and version checks.

The current simulator supports route planning/display, scenario controls, playback/scrub/drag, changing needs, ranked stop comparisons, selection, arrival, dwell, explicit completion and resume, destination ETA impacts, and an inspector. Existing alternative-route comparison/switching is retained. One car is the submission priority; no additional agent framework or multi-car coordination was introduced.

## Problems found and focused changes

- Most external data providers defaulted live; weather did not spend a provider budget. Deployment mode now gates all provider budgets; weather is budgeted and concurrent cell requests coalesce.
- Cached routes did not imply complete place coverage. The default and three-minute preset now use the complete 401 fictional-stop dataset over the recorded OSM road geometry. Real-place coverage remains limited and honestly reported.
- Demo data previously disabled the strategic UI/tools. Strategic now consumes labeled fixture evidence, independently of whether Muse inference is live.
- Muse key aliases differed between adapters, and two rate guards could exceed the configured total. They now share key lookup and one call cap.
- Provider errors could expose raw response/network details. Muse errors are sanitized before logging or returning.
- A configured live provider could label a fallback non-mock. Accepted inference now controls `isMock`/`inferenceSource`, with explicit Live or Recorded/Mock labels in the primary UI.
- Agent 1 could apply an old reply after reset/replan. Primary trip replies now check generation/context; classic simulator replies check reset generation. Context signatures include kids and detour limits; displayed primary recommendations clear after context changes. Classic pending recommendation replies also respect reset generation.
- Weather quick actions did not refresh road-ahead evidence. Override conditions now refresh the waypoint snapshot and are included in strategic input.
- Browser tests could inherit personal providers or reuse a live server. They now start a separate keyless Demo server with live data flags disabled and one browser worker.
- README/env setup described older defaults and incomplete demo coverage. Updated instructions distinguish deployment mode, fixture provenance and accepted inference. All `.env*` files except `.env.example` are ignored.
- Clean installation flagged the old Next.js pin. Updated only the 14.2 patch line to 14.2.35, following the [official advisory](https://nextjs.org/blog/security-update-2025-12-11), and regenerated the lockfile.

## Verification

Automated inference tests use mocks; actual live Muse smoke results are listed separately. No Playwright MCP capability was exposed in this session. The lead used the repository's local Playwright runner and installed system Chrome after the QA agent prepared isolated configuration; only the lead launched a browser. Port binding, clean-install subprocess checks and external inference required main-thread sandbox escalation.

| Check | Result |
| --- | --- |
| Typecheck | Passed |
| Unit/contract tests | 311 passed across 16 files |
| Production build | Passed on Next.js 14.2.35 |
| Clean installation | `npm ci --offline --no-audit --no-fund` passed in a fresh temporary directory with the patched lockfile |
| Clean-source production build | Passed from exported source with no personal `.env` or `.env.local` |
| Configured-secret scan | No configured credential values found in tracked files, 264 reachable historical blobs, or built browser bundles |
| Live TomTom requests | Zero; no TomTom key or live service was used in verification |
| Final browser suite | 25 passed, 1 optional Full Live test skipped; 1.7 minutes; one Chrome worker |

Actual Meta Muse (`muse-spark-1.3`) accepted **Agent 1** structured intent in **5.382 s**, **Agent 2 tactical** in **4.996 s** (5.003 s including handler work), and **Agent 2 strategic** in **21.814 s** (five validated opportunities). These used local route/place/weather fixtures and the configured server-side key. The first strategic attempt fell back quickly; a separate isolated retry completed live. Its original failure code was not retained, so no cause is asserted. No live credential is included in the report or smoke scripts. Live latency and provider availability can vary.

The explicit smoke command is `npx vitest run --config scripts/verify-muse.config.ts`; the three tests share a three-request cap and block every non-Muse host. Use `-t strategic` to check only the strategic workflow. This command is deliberately excluded from normal unit/browser tests.

Browser coverage includes trip geometry/ETA before deferred evidence, bounded playback requests, strategic version rejection, tactical staleness, alternative-route comparison and explicit switching, keyless default and clean console, weather changes, missing-key status, intent provider failure, pending Agent 1 reset, retracted needs, failed routing then cached recovery, classic simulator placement/playback/needs, stop selection/arrival/completion/resume with ETA impact, reviewed scenario interpretation, disabled TomTom budgets, and desktop/mobile layout. Missing/invalid Muse credentials and echoed-secret handling are additionally covered by unit/contract tests. The optional Full Live external-service browser test remains skipped deliberately.

The default keyless desktop flow produced **zero browser page errors or console errors**. In the mocked slow-exits test, map + baseline ETA appeared in **0.976 s** while exit evidence was held for 12 s. Accelerated short-trip playback made one route, one alternatives, one places-prefetch, four weather and two strategic requests, with zero tactical requests because no stop was needed. These are local test measurements, not a hosted-service SLA.

Screenshots are generated locally under ignored `test-results/` (`submission-desktop.png`, `mobile.png`). No screenshot is represented as proof of a live model call; live acceptance was checked against the actual provider result.

## Remaining practical limits

- The recommended 401 demonstration uses **fictional businesses** and a **dated authored mock weather snapshot**. These are reusable evidence, not current business/forecast claims.
- Recorded real-place windows do not cover every preset or arbitrary trip. Full Live depends on optional public providers, their policies, budgets and availability.
- Existing route switching needs alternatives with usable via points; no new route intelligence was added.
- Simulation uses constant cruise speeds; no live traffic, reliable background GPS, cross-device trip persistence or production-grade public access controls are claimed.
- Live inference depends on the judge's key, model access and latency. Missing/invalid keys, output errors, rate limits and deadlines intentionally fall back; verify live provider labels before recording.

See [README](../README.md) for setup and the timed three-minute script; [data provenance](DATA_SOURCES.md) documents licensing and recording coverage.
