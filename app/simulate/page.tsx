import Simulator from "@/components/Simulator";
import Link from "next/link";
import Connections from "@/components/Connections";

export const metadata = {
  title: "Uncongest — Highway 401 simulation"
};

export default function SimulatePage({ searchParams }: { searchParams: { demo?: string } }) {
  return (
    <main className="min-h-screen">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3">
        <Link href="/" className="focus-ring text-lg font-bold text-navy">Uncongest</Link>
        <span className="rounded-full bg-amber/15 px-3 py-1 text-xs font-semibold text-amber">
          SIMULATED trip · real route &amp; exits (OSM) · live weather optional · fictional businesses
        </span>
      </header>
      <div className="px-3 pt-3"><Connections /></div>
      <Simulator autoDemo={searchParams.demo === "1"} />
    </main>
  );
}
