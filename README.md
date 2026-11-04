# Uncongest

**Less stress between A and B.** A passenger-first road-trip simulator that anticipates useful stops, checks feasibility in deterministic code, and lets Meta Muse explain the choices. The submission focuses on one car; existing multi-car controls remain experimental.

## Run a clean clone

Use Node.js 20 LTS or 22 LTS and npm. From the repository root:

```bash
git clone --branch submission/readiness https://github.com/theaniruddha/uncongest.git
cd uncongest
npm ci
cp .env.example .env.local
npm run dev
```

Open **http://localhost:3000/trip**. No keys are needed. The default is the reproducible Toronto → Montréal trip: one car, two children, vegetarian preference, recorded road geometry, fictional businesses and dated mock weather. Click **Plan route & start simulation**. Use **▶ 3-minute demo** to restore this setup. `/simulate` preserves the classic simulator; `/simulate?demo=1` starts its scripted replay.

The optional OpenStreetMap basemap needs internet; route geometry, exits, controls and recommendations work without tiles. Demo never calls external data or model providers. Install dependencies before going offline.

## Connection modes

The collapsible **Connections** panel reports server configuration. It never accepts, stores or returns a key. Edit `.env.local` and restart the server after changing settings.

| Mode | Configuration | Behavior |
| --- | --- | --- |
| Demo (default) | `UNCONGEST_MODE=demo`, `AI_PROVIDER=mock` | No keys or live services. Deterministic Mock parsing, recommendations and strategic plan; interactive simulation and scenario changes. |
| Live Muse | `UNCONGEST_MODE=live-muse`, `AI_PROVIDER=meta`, `MODEL_API_KEY=your-key` | Real Agent 1 and Agent 2 inference over the same local evidence. No TomTom, routing, places, geocoding or weather credentials needed. |
| Full Live (optional) | `UNCONGEST_MODE=full-live`, `AI_PROVIDER=meta`, own Muse key | Allows budgeted OSRM, Overpass, Nominatim and Open-Meteo. Each provider can be disabled using its `*_LIVE=0` flag. Missing evidence or provider failures are labeled. |

Only the explicit `UNCONGEST_MODE` enables live services: an existing personal key or `AI_PROVIDER=meta` alone cannot opt the app in. Unknown modes default to Demo. Keep `.env.local` untracked. Never use `NEXT_PUBLIC_*` for credentials. Existing server-side `MUSE_API_KEY`, `META_API_KEY` and `META_MODEL_API_KEY` aliases work too. Default model: `muse-spark-1.3`; change `AI_MODEL` if your account uses another supported model. The Meta Responses endpoint is configurable with `META_API_BASE`.

**Live means an accepted actual model result**, not merely a configured key. Missing/invalid keys, rate limits, invalid model output and deadlines use a visibly labeled Mock/deterministic fallback. A model may also correctly stay silent. Inspect **Tactical**, **Strategic** and **Agent 1** to verify which path ran. No prerecorded Muse completion is claimed as live.

Live Muse example (replace the placeholder locally):

```dotenv
UNCONGEST_MODE=live-muse
AI_PROVIDER=meta
MODEL_API_KEY=your-own-meta-key
TOMTOM_LIVE=0
TACTICAL_DEADLINE_MS=12000
```

Tactical defaults to a 5-second deadline; the Live Muse example allows 12 seconds for recording latency. Agent 1 uses 8 seconds and strategic planning 30 seconds. Before recording, verify your key works and the visible results say Live Muse. Restart after changing deadlines; the simulation pauses during tactical decisions. The shared `LLM_MAX_CALLS_PER_10_MIN` guard defaults to 30 per server process.

## Reproduce the three-minute demo

1. **0:00–0:25:** Open `/trip`, expand Connections, show Demo or Live Muse configuration. Select **▶ 3-minute demo**, then plan. Explain the labeled recorded route, fictional businesses and mock weather.
2. **0:25–0:55:** Scrub to about **100 simulated minutes** (around 11:10), then choose **Hungry now**. Agent 1 updates passenger context; the deterministic watcher triggers Agent 2. Show the provider labels. Use **Replan now** if needed.
3. **0:55–1:35:** Compare the top stops, safe exit notice, detour, stop duration and destination ETA. Show **Later on this trip** for the strategic workflow over shared context.
4. **1:35–2:20:** Select a stop, **Skip ahead to arrival**, spend the planned time, confirm the needs actually satisfied, then resume. Show the updated ETA and cleared needs.
5. **2:20–3:00:** Try **Urgent washroom** or **Make it rain**; briefly open the inspector to show validated context and fallback/source labels. Explain that navigation handoff is optional and the simulator is not turn-by-turn navigation.

For a recording that demonstrates real Muse, configure Live Muse before starting and confirm Agent 1 and at least one Agent 2 result are live. Do not imply a fallback is live; retries are manual or watcher-triggered and budgeted. Do not open Maps links for fictional businesses as real destinations.

## Implemented architecture

- **Agent 1:** `/api/intent` parses passenger messages into validated per-car intent patches; `/api/scenario` interprets setup text for review before applying. Regex fallback is labeled Mock. Late conversation replies from reset/replanned trips are discarded.
- **Shared deterministic context:** intent state, route position, urgency, ETA, stop lifecycle, diet/facility evidence, weather provenance and decision versions.
- **Agent 2:** bounded tactical recommendation and strategic look-ahead workflows, with native Muse structured output + Zod validation. Strategic planning already exists; it is not a third runtime agent. Demo uses the same workflows with fixture evidence and deterministic fallback.
- **Deterministic engine and watcher:** filters reachability, advance notice, detour, diet, hours and stale positions before model ranking; invokes AI on useful changes, not every simulation tick. In-flight results are checked against trip/context versions and passed exits. Displayed recommendations clear on context changes.
- **Current simulator:** real recorded OSM road geometry/exits, playback/scrub/drag, needs and weather scenarios, ranked recommendations, editable dwell, select/arrive/confirm/resume, ETA impact and inspector. Existing real-route alternatives and explicit route switching are retained for routes with evidence; arbitrary live routing requires Full Live.

No LangGraph or new runtime agents. No background-GPS or traffic-control claims. Existing multi-car features are preserved but are outside the tested submission priority.

## Data, caching and optional providers

See [data provenance and licensing](docs/DATA_SOURCES.md) and [data notices](data/README.md). OSM-derived recordings are ODbL with attribution. Fictional businesses are authored fixtures. Weather is an authored CC0 mock snapshot dated 2026-11-04, replayed at scenario time, **not an observed forecast**. Optional live forecasts are attributed to Open-Meteo. No raw TomTom results or scraped reviews are distributed.

Routes and alternatives reuse memory/disk caches and committed recordings; places reuse bounded 30 km tiles; weather uses coarse cells and deduplicates concurrent requests. Runtime caches use `.cache/` (or `/tmp/uncongest-cache` on Vercel), overridable by `UNCONGEST_CACHE_DIR`. Runtime caches are untracked. Small committed recordings cover selected routes/windows only; the 401 fictional-stop preset is the reliable complete demonstration. Other presets may correctly report incomplete places or unavailable routes in offline modes.

Full Live public OSRM/Overpass/Nominatim services have usage policies, budgets and no SLA. Nominatim is throttled. Use hosted/self-managed services for public traffic. Live services can fail without blocking the fixture demo. TomTom remains disabled unless **all three** are present: Full Live mode, `TOMTOM_LIVE=1`, `TOMTOM_API_KEY`. **No live TomTom calls during development or automated tests without separate explicit owner approval.** Do not commit TomTom caches; redistribution permission has not been established. Do not bulk-download map tiles.

## Tests and production

```bash
npm run typecheck
npm test
npm run build
npm start
# Browser tests start an isolated, keyless Demo server on :3124:
npm run test:e2e
```

Browser tests use one worker and system Chrome by default. If Chrome is unavailable, install Playwright Chromium (`npx playwright install chromium`) and run with `E2E_CHANNEL=chromium npm run test:e2e`. Automated tests use mock model responses; no live TomTom calls are permitted. A separate live-key smoke check is needed before recording.

With your own key configured, explicitly verify real inference (up to three Muse calls, no external evidence providers):

```bash
npx vitest run --config scripts/verify-muse.config.ts
# Retry only strategic inference if its first call falls back:
npx vitest run --config scripts/verify-muse.config.ts -t strategic
```

The runtime pins Next.js 14.2.35, the patch specified for the 14.2 line in the [official security advisory](https://nextjs.org/blog/security-update-2025-12-11).

## Practical limits

This is a simulator with in-memory trip state, not a synchronized navigation service. Unknown OSM hours/facilities remain unknown; fictional fixture ratings are illustrative. Constant cruise speed excludes live traffic. The watcher requires an active tab. Timezone is the origin zone. LLM calls and provider budgets reset on process restart and apply per server instance. Public hosting needs appropriate access/rate controls before broad distribution.

Historical product/design documents in `docs/` include future ambitions; this README describes the current submission scope. See [submission verification](docs/SUBMISSION_READINESS.md) for measured results and remaining limitations.
