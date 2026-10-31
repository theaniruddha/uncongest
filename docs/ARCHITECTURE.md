# Architecture and interfaces

## Application
Next.js App Router + TypeScript strict + Tailwind/shadcn. Supabase optional. UI shells: `/`, `/trip/new`, `/trip/[id]`, `/simulate`, `/join/[token]`. Use Zod contracts. No native application.

## Data flow
Trip settings → positions (simulator OR foreground browser GPS) → deterministic trigger engine → routing/places adapter → deterministic candidate filters/ranking → LLM tool/context reasoning → validate JSON + recheck latest ETA/lead time → notifications to lead passenger → group vote/confirmation → Maps URL.

## Provider adapters
- `RouteProvider.getRoute(origin,destination)`, `getMatrix(cars,stops)`: fixture or Mapbox; cached, debounce reroutes.
- `PlaceProvider.getCandidates(routeCorridor,needs)`: fixture or live API; include provenance fields, opening hours and parking verification flags. Never claim quality from ratings alone.
- `WeatherProvider.forecastAt(lat,lng,eta)`: fixture or Open-Meteo.
- `AIProvider.decide(prevalidatedContext)`: mock | mistral | meta; API key ONLY server-side, validate output.
- `Clock` and `PositionSource` injected: simulator vs realtime.

## Domain types
Trip { id, origin, destination, departureTime, status, config, leadMemberId, activeStopId }.
Member { id, carId, role: lead|passenger|solo, consentLocation, votedStopId?, vote? }.
Car { id, progressKm, lat, lng, etaDestination, positionUpdatedAt, needs, routeId }.
Stop { id, label, coordinates, exitId, category, tags, dietaryCapabilities, openingIntervals, facilitiesVerified, reviewSummary?, source, mock, detoursByCar, arrivalByCar }.
Decision { id, tripId, timestamp, action, stopId, reason, candidateIds, rejectedCandidates, inputVersion, model, isMock }.

## Suggested persistent tables (P1)
trips, trip_members, vehicles, vehicle_positions (short TTL), preferences, candidate_stops, suggestions, votes, audit_events, invites. RLS: only trip members can view; only lead can confirm; trip token unguessable; store minimum location precision; delete per retention policy.

## Engine behavior
Do not run LLM on GPS tick. Evaluate on trigger boundary or meaningful context change, and throttle per-trip. Prefer prefiltering within route corridor (not straight-line radius). ETA and route geometry from routing data, not the model. For multi-car stops compute detour **separately** for each car and waiting at verified parked location, considering arrival times and stop opening windows.
Use an explicit `locationFreshness` threshold (e.g. 3 min) and degrade to best-effort if stale. For simulation, virtual timestamp tracks simulated time; never mix with wall time.

## Reliability and deployment
Start with local in-memory / localStorage demo and fixtures. For group shared state use Supabase Realtime only after local simulator stable. Protect API routes with limits per trip/user and cache; do not leak API tokens to browser. Vercel deploy with server actions/API routes; no persistent timers in serverless functions—use client sim clock and event-triggered requests; later add durable scheduled background worker.
