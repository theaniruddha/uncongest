# Uncongest — START NOW (Vibe Code Web goal-driven run)

**One goal:** Build the best usable, demo-ready **Uncongest** web application possible during this session. Target up to ~2 hours of useful implementation, verification and refinement; **do not idle or wait out the clock** if the goal is achieved. No four-day schedule. Start implementing immediately.

## Read once
Read `AGENTS.md`, `docs/PRD.md`, `docs/DECISION_ENGINE.md`, `docs/UX_SPEC.md`, and `data/scenarios/highway-401.json`; treat docs as constraints, not an excuse to overplan. Don't ask for nonessential clarification.

## Nonnegotiable demo goal
A user opens `/simulate` and sees a polished, working Toronto → Montréal Highway 401 map/corridor with **three independently simulated cars**. The virtual clock advances; dinner approaches; group dietary needs and stop exclusions are evaluated; nearby stop options are ranked; the passenger lead sees a useful recommendation, can accept or decline, and other passengers can join/skip. Show per-car arrival estimates and a safe early exit decision. Later weather/dusk and grocery-completed toggles change whether a suggestion fires. Quiet/silent decisions are visible in a debug trace. Working demo **without any credentials**.

## Your execution loop
1. Inspect current repo and pick the highest-value missing *user-visible* behavior.
2. Implement a complete vertical slice, no placeholder buttons.
3. Run typecheck, tests, and build; inspect errors and fix.
4. Start the dev server internally; use Playwright or a browser/screenshot tool **if available** to actually inspect the page at desktop and mobile sizes. If screenshots/preview are unsupported, state that and rely on Playwright checks; don't claim visual QA you didn't do.
5. Act as your own QA: click controls (Play/Pause/Reset, scenario toggles, voting, Maps handoff), try failure states, identify top 1–3 defects, fix them, then repeat.
6. Delegate bounded, independent tasks to subagents **if the Vibe environment supports delegation** (e.g. read-only QA/a11y review, test generation, code architecture review). Integrate findings yourself; do not assume subagents are available.
7. Commit a working checkpoint after each meaningful success. Continue while there are high-value improvements and the session/budget allows. Prefer improving the real experience over adding scope.
8. Conclude with working feature inventory, tests run, screenshots/artifact locations if any, known limitations and a GitHub branch/PR.

## Priority order
A. Runnable polished /simulate with three moving virtual cars on a map-like corridor (prefer a real tile map if easy; **offline canvas/SVG fallback mandatory**).
B. Deterministic decision engine with visible triggering and ranking + tests.
C. Passenger decisions, group join/skip demo and real Google/Apple Maps URL handoff.
D. Pluggable AI API (mock default; Mistral if API key provided), Zod validation, timeout and fallback.
E. Optional live weather, voice, realtime sync, auth **only if A–D already work**.

## Safety and truth
Don't present simulated reviews as real; no speed directives or dangerous late exits; no claim of locked-screen browser GPS or access to Google Maps' route. No paid APIs without provided credentials. Secrets server-side. Nothing that requires a production deployment.

## Budget discipline
User has $150 total available usage, not a blank check or guaranteed cost meter. Limit unnecessary LLM invocations and package installs. Never run a timed busy loop that burns credits. You can stop early with a solid result.

## Deliverable
Working code pushed to a branch/PR, passing tests and a clear command `npm run dev -- --hostname 0.0.0.0`. The user will preview via GitHub Codespaces private port 3000 without deploying a website.

**Start coding, not discussing.**
