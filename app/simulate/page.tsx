import Simulator from "@/components/Simulator";
import Link from "next/link";

export const metadata = {
  title: "Uncongest — Highway 401 simulation"
};

export default function SimulatePage({ searchParams }: { searchParams: { demo?: string } }) {
  return (
    <main className="min-h-screen">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3">
        <Link href="/" className="focus-ring text-lg font-bold text-navy">Uncongest</Link>
        <span className="rounded-full bg-amber/15 px-3 py-1 text-xs font-semibold text-amber">
          SIMULATION — synthetic data, no live APIs
        </span>
      </header>
      <Simulator autoDemo={searchParams.demo === "1"} />
    </main>
  );
}
