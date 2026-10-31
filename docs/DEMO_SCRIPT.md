# 2-minute judge demo

0:00–0:15 — Hook: "Your maps app knows the fastest route. It doesn't know three cars have kids, everyone's vegetarian, and dinner is approaching."
0:15–0:30 — Open Uncongest /simulate. Display three cars eastbound on 401; preferences "avoid GTA", max 12-min detour, all vegetarian.
0:30–0:55 — Accelerate journey. Bad highway plaza candidate appears; real decision engine filters and ranks alternatives; show data source badges and per-car detours.
0:55–1:15 — Decision window: lead car only ~7 min from exit; if insufficient warning reject and offer next candidate. Show reason log. Passenger approves.
1:15–1:35 — Other passengers vote join/skip; shared meetup, wait time, open in preferred Maps app.
1:35–1:50 — Weather gets cold/dark; groceries needed triggers suggestion. Toggle purchased = no notification.
1:50–2:00 — Reveal AI calls/schemas + "We don't replace navigation—we make the journey smarter together."

Demo fallback: fully offline fixtures and deterministic mock model; no keys required. Never imply synthetic Yelp/Google scores are real. Prepare a rehearsal video if network fails.
