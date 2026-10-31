# Uncongest — Product Requirements (MVP)

## Vision
Web-first journey co-pilot for one to three cars. Navigation stays in existing maps apps. It anticipates food, rest, restroom, groceries, bad weather, limited services, and regrouping opportunities, and recommends feasible stops at useful times.

## Personas
- Trip lead passenger: creates trip, sets preferences, sees recommendations, proposes and confirms stops.
- Other-car passenger: joins by invitation, opts into location sharing, votes join/skip and opens navigation.
- Solo traveler: receives brief, non-interactive alerts and optional speech while page active. Interacts only while stopped.

## Primary demo
A deterministic simulation of Highway 401, Toronto → Montréal. Three virtual cars have different positions/ETAs; GTA optional stops excluded. Group prefers vegetarian meals and a max 12-minute additional driving detour per car. As dinner approaches, app compares fake-but-labeled ONroute-like highway plaza and off-highway restaurants, finds a good stop, checks leading car's notification window and group waiting time, presents the options to lead, and captures accept/join/skip. A cold-after-dark trigger later recommends groceries if not already purchased; if purchased, no notification.

## Features P0
1. Web landing + Start Solo / Create Group / Join via link / Replay Demo.
2. Trip preferences: origin/destination, departure, cars, child presence, dietary requirements, max detour, max group wait, avoid Toronto/GTA, first-stop-after elapsed time, groceries done, minimum notification lead time.
3. Map: 401 route, three differentiated moving car markers, upcoming stops, route progress and candidate comparisons; clear mock badge.
4. Simulation: play/pause/step/reset, time scale 1x/10x/30x, scrub, scripted events, coherent timestamps, deterministic seeded progression.
5. Deterministic candidate filter and scorer; group ETA/wait calculation; candidate exit warning; reasons for rejection; never recommend unsafe last-minute exit.
6. AI decision adapter + validated response; `mock` works offline; live AI optional.
7. Passenger-first suggestion card: top 2–3 choices, source of ratings, missing-info notice, detour and wait by car, lead accept/skip, others join/skip; pending/confirmed states.
8. Driver safety mode: concise status-only alert, optional read aloud on active page, no interactions while moving.
9. Event log including no-op, trigger, filtered options, AI recommendation, approval and navigation handoff.
10. Link to Google/Apple Maps directions for confirmed stop.

## P1 after core MVP
Supabase persistence and realtime, invitation access control; weather from Open-Meteo; road routing from Mapbox; real places/reviews as licensed provider permits; foreground browser GPS; opt-in push; PWA install; accessible audio.

## Out of scope / honesty
Not turn-by-turn nav, automated speed control, live traffic queue sensing, verified restroom cleanliness without data, guaranteed active GPS while browser backgrounded, automatic reading of Google Maps destination. Mock stop scores are illustrative. No social-media review scraping by default.

## Success metrics
Demo starts without keys in under 10 seconds; 3 moving cars; all 3 main scenarios repeatable; tests pass; two browser tabs can interact with demo session; zero made-up live claims; model failure recovers to deterministic recommendation; no surprise API charge.

## Acceptance cases
A. No need => STAY_SILENT.
B. GTA excluded => optional GTA stop removed.
C. Dinner + all vegetarian => choose verified vegetarian-capable candidate.
D. Exit too close => candidate rejected; next suitable exit offered.
E. Car behind 10 min => compute waiting penalty; never recommend unsafe slowdown.
F. Cold + dusk + no groceries => shopping reminder; toggling groceries complete suppresses.
G. Lead rejects => don't repeat same suggestion until materially changed.
H. Missing reviews/attributes => show unknown; no invented quality or safety.
I. Stale car GPS => exclude from precision claims or ask passenger to refresh.
J. Maps link opens destination without claiming linked nav state.
