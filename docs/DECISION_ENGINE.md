# Decision Engine Contract

## Core rule
Geographic safety, route reachability, temporal relevance, and group constraints are deterministic. The LLM only performs contextual ranking/explanation over candidates already deemed feasible.

## Trigger rules
- Meal window approaching in 30–90 min and no meal completed, with a feasible dining opportunity ahead.
- Restroom/rest break due or long gap before next verified facility.
- Sunset/temperature/forecast changes making a planned activity unsuitable.
- Grocery need pending, destination cold/late and last suitable shopping stop approaching.
- Group ETA separation makes a joint stop valuable, or one car needs a break.
- Re-evaluate if route changed, favorite stop closed, driver/lead rejects.

## Candidate filters
1. Future stop on plausible travel corridor; safe approach lead time configured (e.g. >= 8–12 minutes, not guaranteed instruction).
2. Valid drive route and <= max additional minutes for each participating vehicle.
3. Exclude GTA or Toronto polygon and no-optional-stop threshold. Exceptions for explicitly urgent needs, with acknowledgement.
4. Open throughout expected arrival/dwell period, or show opening hours unknown with conservative treatment.
5. Match *hard* dietary restrictions or remove; keep restrooms/parking unknown visibly unknown.
6. Disallow candidates beyond already-passed exit, unreachable left turns/unsafe reversals.
7. Validate location freshness and limit notification frequency.

## Scoring
Normalize each penalty to 0–1. Example weighted cost:
0.35 * group detour + 0.25 * max waiting + 0.25 * poor/uncertain quality + 0.15 * unmet needs.
Weights are demo assumptions. Hard dietary and safe exit constraints always outrank score. Expose the breakdown in developer/debug panel.

## Recommended LLM prompt
System: You are Uncongest's contextual stop-decision assistant. You receive a snapshot with user intent, timestamp, verified candidate stops and deterministic eligibility status. You cannot invent places, stars, opening hours, distances, turn instructions or travel speeds. Choose only IDs in eligibleCandidateIds. You may choose STAY_SILENT. Respect all dietary, group, safety and user constraints. Your message is concise and phrased as a passenger suggestion, not a driver command. Never say slow down, speed up, brake, or take an immediate exit. Return JSON conforming to schema and nothing else.
Input: TripStateSnapshot, triggerReasons, eligibleCandidates with numeric detour/ETA/wait, top rejected reasons for transparency.
Output: `schemas/stop-decision.schema.json`.
Guardrails: validate IDs after response; if selected stop no longer eligible, recalculate or stay silent; if no eligible stops => STAY_SILENT; throttle same recommendation.

## Notification policy
Passenger/lead receives compare-and-vote card. Solo receives passive alert only. SpeechSynthesis only with active-page user opt-in. Web Push requires support/permissions; no guaranteed spoken push while screen locked.

## Tests
No trigger/no notify; excluded Toronto/GTA; all-veg hard rule; max detour; insufficient exit warning; stop after passed exit; stale positions; group votes; shopping completed; model hallucinated ID; model timeout; repeated notification suppression.
