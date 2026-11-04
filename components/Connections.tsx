"use client";

import { useEffect, useState } from "react";

interface Status {
  mode: "demo" | "live-muse" | "full-live";
  museEnabled: boolean;
  museKeyConfigured: boolean;
  externalProvidersEnabled: boolean;
  tomtomEnabled: boolean;
}

export default function Connections() {
  const [status, setStatus] = useState<Status | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    fetch("/api/connections", { cache: "no-store" })
      .then(async (res) => { if (!res.ok) throw new Error(); return res.json(); })
      .then((data: Status) => { if (active) setStatus(data); })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, []);
  const label = status?.mode === "live-muse" ? "Live Muse Mode" : status?.mode === "full-live" ? "Full Live Mode" : status ? "Demo Mode" : failed ? "Status unavailable" : "Checking configuration…";
  return (
    <details className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600" data-testid="connections">
      <summary className="cursor-pointer font-semibold text-navy">Connections · {label}</summary>
      {status && <div className="mt-2 space-y-1">
        <p>{status.mode === "demo" ? "Recorded/Mock decisions · no model calls." : status.museEnabled && status.museKeyConfigured ? "Muse key configured · live inference enabled. Each result reports Live or Mock/fallback." : "Live Muse unavailable: check UNCONGEST_MODE, AI_PROVIDER=meta and MODEL_API_KEY in .env.local. Decisions use labeled Mock/fallback."}</p>
        <p>{status.externalProvidersEnabled ? `Live routing, places and weather allowed within budgets. TomTom ${status.tomtomEnabled ? "enabled" : "disabled"}.` : "Route/place fixtures and dated mock weather · external data providers disabled. Map tiles need internet."}</p>
        <p>Change modes in .env.local and restart the server. Keys stay on the server. See README for setup.</p>
      </div>}
      {failed && <p className="mt-2">Could not read server configuration. Reload to retry; inspect each decision’s provider label.</p>}
    </details>
  );
}
