import Link from "next/link";
import TripPlanner from "@/components/trip/TripPlanner";

export const metadata = {
  title: "Uncongest — plan & simulate your road trip"
};

export default function TripPage() {
  return (
    <main className="min-h-screen">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-white px-3 py-2">
        <div className="flex items-baseline gap-3">
          <Link href="/" className="focus-ring text-lg font-bold text-navy">
            Uncongest
          </Link>
          <span className="text-xs text-slate-500">Trip simulator · real routes, real places, real forecasts</span>
        </div>
        <nav className="flex gap-3 text-xs">
          <Link href="/simulate" className="text-slate-600 underline">
            Classic 401 demo
          </Link>
        </nav>
      </header>
      <TripPlanner />
    </main>
  );
}
