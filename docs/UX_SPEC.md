# UX & identity

Name: **Uncongest**. Tagline: *Less stress between A and B.*

Style: clean, reassuring, contemporary transportation intelligence. Off-white/light neutral surfaces, slate typography, deep navy, restrained teal/blue accents; a few sparing amber urgency states. Clear contrast and excellent mobile layout. Avoid generic AI gradients, clutter, giant icons, fake data badges, and map tiles obscured by cards.

Screen hierarchy:
- Landing: one sentence value proposition + "Try 401 simulation" prominent; "Plan trip" second.
- Setup: start/destination, passenger/solo, car count, food preferences, optional stop exclusions, max detour, group waiting, weather concern.
- Simulator: route map should occupy ~60% desktop; side rail with cars (ETA to next exit), event timeline, upcoming choices, top recommendation; mobile bottom sheet, map behind.
- Recommendation card: why now, comparison top 2, extra minutes by car, group max wait, review provenance, unknown attributes, lead approve/skip. If no suggestion, intentional "Monitoring — no interruption needed".
- Debug reason view: rejected candidates and calculation summary; toggle for judges.
- Voice: mute by default, enable explicitly by user click; cancelable speech.
- Device states: loading, network failure, provider unavailable, stale GPS, invite expired, no eligible stop, refusal.

Simulation labels must always say SAMPLE/SIMULATED when using fixture data. Avoid fabricated live ratings or cleanliness. Each control actually changes a state/result.
Accessibility: semantic buttons, keyboard, visible focus, reduced motion, aria live for recommendations, adequate touch targets.
