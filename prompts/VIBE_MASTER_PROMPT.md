# Mistral Vibe — first implementation prompt

You are my high-agency senior product engineer. Work directly in this repository and **SHIP a running Uncongest web MVP**. Read AGENTS.md, README.md, docs/PRD.md, docs/ARCHITECTURE.md, docs/DECISION_ENGINE.md, docs/UX_SPEC.md, docs/ROADMAP.md, and fixtures. Do not spend many rounds asking conceptual questions. Use the documented defaults and proceed.

I have a $150 development usage budget; speed and polish matter more than minimal model calls, but stay within sensible limits. Write and run code; don't just generate a plan. At each milestone show working screens, test/build results, precise limitations, and the next feature.

Build:
1. Scaffold Next.js App Router, TypeScript, Tailwind, shadcn/ui, icons, map with reliable offline fixture fallback. Create a stunning responsive landing page and a Highway 401 /simulate dashboard.
2. Implement deterministic 3-car trip simulator: start/pause/replay/step/speed, virtual clock, route progress, distinct car positions, ETA to candidate exit, dinner/temperature/dusk/groceries event switches, GTA exclusion. Ensure simulation is deterministic.
3. Implement pure TypeScript stop feasibility/decision engine with at least 10 unit tests. Inputs from data/scenarios + data/stops. Filter candidates before LLM by advance notice, corridor reachability, max detour for each car, hard dietary constraints, opening hours, excluded regions, and source validity. Score detour + group waiting + stop quality + need fit; explain rejected stops.
4. Add live recommendation cards to group lead, car join/skip votes, confirm meetup, passenger and solo modes, maps handoff and explicit simulated data notices.
5. Add provider interface AI_PROVIDER=mock|mistral|meta. Mock default must work completely; configure Mistral using MISTRAL_API_KEY, model by env. Optional Meta adapter with META_MODEL_API_KEY and configurable model/base URL; no secrets browser-side. Validate model JSON with Zod. LLM cannot invent facts, locations, ratings, ETAs or speeds. Use deterministic fallback on invalid output.
6. Add spoken suggestion button using speechSynthesis for active browser page. Add a decision/audit timeline and quiet/no-op state.
7. Run typecheck, lint, unit tests, Playwright smoke test, and npm run build. Fix failures. Document how to configure/deploy.

Critical: We DO NOT develop a native app, don't implement unsafe speed/exit advice, don't fake real-time reviews, don't claim browser GPS runs reliably while phone locked, and don't rely on paid APIs for essential demo.

Prefer completing full vertical slices over placeholder components. You may install packages and make incremental commits. Begin by inspecting files, scaffold app, run it, then continue through the milestones, validating as you go.
