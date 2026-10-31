# Open questions and nonblocking defaults

Do not block initial coding on these. Use defaults and keep configurable.
1. Product name is Uncongest. Trademark/domain availability not verified.
2. Route Toronto → Montréal, eastbound Highway 401 / A-20 demo; mocked progress geometry until routing API integrated.
3. Three cars max, one lead passenger. Solo notifications passive. No full GPS/background tracking in hackathon.
4. All group vegetarian, optional dining at familiar chains if verified menu needs; max detour 12 minutes per car, max waiting 15 minutes.
5. "Avoid GTA" applies optional stops, not emergency/urgent needs. Polygon can be coarse initially but must be labeled sample and not mistaken for authoritative municipal boundaries.
6. Input origin/destination initially manual; share-to-trip/import Maps URLs only later; external app doesn't reliably expose active route.
7. Maps are handoff only; the chosen Google/Apple Maps route may differ from Uncongest's calculation.
8. Demo stop properties and scores are synthetic and explicitly labeled. Real businesses/places must use verified IDs and provider data; no invented ratings.
9. Live API provider selection is environment-configurable and may change. Never hard-code a model name that cannot be reached by API credentials. Default mock.
10. Real location sharing: opt-in, browser foreground best-effort, no locked-screen guarantee; postpone until necessary.
