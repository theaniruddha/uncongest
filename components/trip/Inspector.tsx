"use client";

import { useState } from "react";
import type { EngineResult } from "@/lib/domain/types";

export interface Agent1Trace {
  time: string;
  carId: string;
  source: string;
  text: string;
  provider: string;
  understood: string[];
}

/** Agent 1 / Agent 2 inspector: real tool traces and API budget counters; raw JSON tucked away. */
export default function Inspector({
  result,
  usage: usageProp,
  request,
  agent1,
  contextIncluded,
  prefetchTrace
}: {
  result: (EngineResult & { dataMode?: string }) | null;
  usage?: NonNullable<EngineResult["usage"]>;
  request: unknown;
  agent1: Agent1Trace[];
  contextIncluded: string[];
  prefetchTrace: string[];
}) {
  const [tab, setTab] = useState<"agent2" | "agent1" | "budget">("agent2");
  const usage = usageProp?.length ? usageProp : result?.usage ?? [];
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-3 text-xs" data-testid="inspector">
      <div className="flex gap-1" role="tablist">
        {(
          [
            ["agent2", "Agent 2 · decision"],
            ["agent1", "Agent 1 · intent"],
            ["budget", "API budgets"]
          ] as const
        ).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`rounded px-2 py-1 ${tab === k ? "bg-navy text-white" : "border border-slate-300"}`}>
            {l}
          </button>
        ))}
      </div>

      {tab === "agent2" && (
        <div className="mt-2 space-y-2">
          {!result && <p className="text-slate-500">No decision yet.</p>}
          {result && (
            <>
              <p>
                <strong>{result.provider}</strong> · urgency {result.urgency?.level ?? "?"} · {result.dataMode === "real" ? "real places" : "demo fixtures"} · decided {result.decidedAtLocal}
              </p>
              <table className="w-full table-fixed border-collapse">
                <thead>
                  <tr className="text-left text-slate-500">
                    <th className="w-[28%] pb-1">Tool</th>
                    <th className="pb-1">Result</th>
                    <th className="w-12 pb-1 text-right">ms</th>
                  </tr>
                </thead>
                <tbody>
                  {(result.toolTrace ?? [])
                    .filter((t) => t.tool !== "places.osm.detail")
                    .map((t, i) => (
                      <tr key={i} className="border-t border-slate-100 align-top">
                        <td className="break-all py-1 pr-1 font-mono text-[10px] text-navy">{t.tool}</td>
                        <td className="break-words py-1">
                          <span className="text-slate-500">{t.input}</span>
                          {t.input && " → "}
                          {t.output}
                          {t.provenance && <span className="ml-1 rounded bg-slate-100 px-1 text-[10px] text-slate-500">{t.provenance}</span>}
                        </td>
                        <td className="py-1 text-right text-slate-400">{t.ms ?? ""}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
              <details>
                <summary className="cursor-pointer font-semibold text-navy">Exploration ({result.exploration.length})</summary>
                <ul className="mt-1 space-y-0.5">
                  {result.exploration.map((e) => (
                    <li key={e}>• {e}</li>
                  ))}
                </ul>
              </details>
              <details>
                <summary className="cursor-pointer font-semibold text-navy">Place discovery detail</summary>
                <ul className="mt-1 space-y-0.5">
                  {[...prefetchTrace, ...(result.toolTrace ?? []).filter((t) => t.tool === "places.osm.detail").map((t) => t.output)].map((e, i) => (
                    <li key={i}>• {e}</li>
                  ))}
                </ul>
              </details>
              <details>
                <summary className="cursor-pointer font-semibold text-navy">Rejected / caveats ({result.rejected.length})</summary>
                <ul className="mt-1 space-y-0.5">
                  {result.rejected.slice(0, 40).map((r) => (
                    <li key={r.stopId}>
                      <strong>{r.stopId}</strong>: {r.reasons.join("; ")}
                    </li>
                  ))}
                </ul>
              </details>
              <details>
                <summary className="cursor-pointer font-semibold text-navy">Context sent to agents</summary>
                <p className="mt-1">Destination/daylight included because: {contextIncluded.join("; ") || "not relevant right now"}</p>
                <pre className="mt-1 max-h-48 overflow-auto rounded bg-slate-900 p-2 text-[10px] text-slate-100">{JSON.stringify(request, null, 1)}</pre>
              </details>
            </>
          )}
        </div>
      )}

      {tab === "agent1" && (
        <ul className="mt-2 space-y-1">
          {agent1.length === 0 && <li className="text-slate-500">No messages yet.</li>}
          {agent1.map((a, i) => (
            <li key={i} className="rounded bg-slate-50 px-2 py-1">
              <span className="font-mono text-slate-400">{a.time}</span> {a.carId} {a.source === "driver_voice" ? "🎙" : "💬"} “{a.text}”
              <div className="text-slate-600">
                → {a.understood.join("; ") || "no change"} · <span className="font-mono text-[10px]">{a.provider}</span>
              </div>
            </li>
          ))}
        </ul>
      )}

      {tab === "budget" && (
        <div className="mt-2">
          {usage.length === 0 && <p className="text-slate-500">No external calls yet.</p>}
          <table className="w-full">
            <thead>
              <tr className="text-left text-slate-500">
                <th>Provider</th>
                <th>Status</th>
                <th className="text-right">Window</th>
                <th className="text-right">Session</th>
                <th className="text-right">Cache hits</th>
              </tr>
            </thead>
            <tbody>
              {usage.map((u) => (
                <tr key={u.provider} className="border-t border-slate-100" data-testid={`usage-${u.provider}`}>
                  <td className="py-1 font-mono">{u.provider}</td>
                  <td>{u.enabled ? "on" : "off"}</td>
                  <td className="text-right">
                    {u.usedInWindow}/{u.windowLimit}
                  </td>
                  <td className="text-right">
                    {u.usedThisSession}/{u.sessionLimit}
                  </td>
                  <td className="text-right">{u.cacheHits}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1 text-slate-500">TomTom stays off unless the server sets TOMTOM_LIVE=1; requests are capped per hour and per session.</p>
        </div>
      )}
    </section>
  );
}
