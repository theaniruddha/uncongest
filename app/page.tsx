import Link from "next/link";

export default function Landing() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center px-6 py-16 text-center">
      <p className="mb-3 rounded-full border border-teal/40 bg-teal/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-teal">
        Simulation demo — no API keys needed
      </p>
      <h1 className="text-4xl font-bold tracking-tight text-navy sm:text-5xl">Uncongest</h1>
      <p className="mt-3 text-xl font-medium text-slate-600">Less stress between A and B.</p>
      <p className="mt-4 max-w-xl text-slate-600">
        Proactive, passenger-first stop recommendations for one to three cars traveling together.
        Uncongest works alongside Google Maps or Apple Maps — it never replaces your navigation.
      </p>
      <div className="mt-8 flex flex-col gap-3 sm:flex-row">
        <Link
          href="/trip"
          className="focus-ring rounded-lg bg-teal px-6 py-3 font-semibold text-white shadow hover:bg-teal/90"
        >
          Plan & simulate your own trip
        </Link>
        <Link
          href="/simulate"
          className="focus-ring rounded-lg border border-navy/20 bg-white px-6 py-3 font-semibold text-navy hover:bg-slate-50"
        >
          Highway 401 demo
        </Link>
        <Link
          href="/simulate?demo=1"
          className="focus-ring rounded-lg border border-navy/20 bg-white px-6 py-3 font-semibold text-navy hover:bg-slate-50"
        >
          Replay scripted demo
        </Link>
      </div>
      <ul className="mt-10 grid gap-3 text-left text-sm text-slate-600 sm:grid-cols-3">
        <li className="rounded-lg border border-slate-200 bg-white p-4">
          <strong className="block text-navy">2–3 ranked stops</strong>
          Each with real reasoning, per-car detour minutes, group wait and transparent trade-offs.
        </li>
        <li className="rounded-lg border border-slate-200 bg-white p-4">
          <strong className="block text-navy">Deterministic safety checks</strong>
          Exit lead time, dietary hard rules, detour caps, opening hours and stale-GPS handling are code, not model guesses.
        </li>
        <li className="rounded-lg border border-slate-200 bg-white p-4">
          <strong className="block text-navy">Honest mock data</strong>
          All stops, ratings and routes in this demo are synthetic and clearly labeled SIMULATION.
        </li>
      </ul>
    </main>
  );
}
