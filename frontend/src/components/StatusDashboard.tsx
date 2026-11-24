"use client";

/**
 * The /status page body: one row per component (ok / warn / fail / off) from
 * GET /api/status, plus a filterable view of the app's own log from
 * GET /api/status/logs. Read-only; refreshes itself every 10 s.
 */

import { useCallback, useEffect, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL || "";

type State = "ok" | "warn" | "fail" | "off";
interface Component {
  key: string; label: string; state: State; summary: string; ms: number;
  detail: Record<string, unknown>;
}
interface StatusResp { overall: State; checked_at: string; components: Component[] }
interface LogEntry { time: string; level: string; component: string; message: string; extra: string }
interface LogsResp { log_file: string; components: Record<string, number>; total: number; entries: LogEntry[] }

const DOT: Record<State, string> = {
  ok: "bg-emerald-500", warn: "bg-amber-400", fail: "bg-red-500", off: "bg-gray-600",
};
const OVERALL: Record<State, [string, string]> = {
  ok: ["All systems working", "border-emerald-700 bg-emerald-950/40 text-emerald-300"],
  warn: ["Working — something needs a look", "border-amber-700 bg-amber-950/40 text-amber-300"],
  fail: ["Something is broken — see the red rows", "border-red-700 bg-red-950/40 text-red-300"],
  off: ["", ""],
};
const LEVEL_COLOR: Record<string, string> = {
  ERROR: "text-red-400", CRITICAL: "text-red-400", WARNING: "text-amber-300",
  INFO: "text-gray-400", DEBUG: "text-gray-600",
};

function fmt(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "object") return Array.isArray(v) ? v.join(", ") : JSON.stringify(v);
  return String(v);
}

function Guide() {
  return (
    <details className="mb-5 rounded-lg border border-gray-800 bg-gray-900/50 text-sm">
      <summary className="cursor-pointer px-4 py-2 text-gray-300 select-none">
        📖 How to use this page
      </summary>
      <div className="px-4 pb-4 space-y-3 text-gray-400 leading-relaxed">
        <p><b className="text-gray-200">1. Look at the colours.</b> Each row is one part of the system.
          {" "}<span className="text-emerald-400">Green</span> = working.
          {" "}<span className="text-amber-300">Yellow</span> = working, but needs a look.
          {" "}<span className="text-red-400">Red</span> = broken — this is probably your problem.
          {" "}<span className="text-gray-500">Grey</span> = not set up on this server (not an error).
          Click a row to see its details.</p>
        <p><b className="text-gray-200">2. Read &ldquo;Errors, last hour&rdquo;.</b> It counts errors per
          component, e.g. <code>webrtc_infer ×5</code> means the WebRTC code complained 5 times.
          Click that component name in the log filter below to see only its lines.</p>
        <p><b className="text-gray-200">3. Read the log.</b> Newest line first. Set the level to
          {" "}<i>Errors</i> to hide normal activity. Lines marked ▸ have a traceback — click to open it.
          {" "}<b>The last line of a traceback is the actual error</b>; the lines above it show which code
          led there (look for files under <code>backend/</code>, not <code>site-packages/</code>).</p>
        <p><b className="text-gray-200">4. Reproduce it live.</b> Leave this page open in a second tab,
          make the problem happen in the app, then come back: new lines appear within 10 seconds.</p>
        <p><b className="text-gray-200">Common patterns:</b></p>
        <ul className="list-disc pl-5 space-y-1">
          <li><b>Frontend red / page is white</b> → the last frontend deploy is broken. Re-run
            {" "}<code>sh deploy-frontend.sh</code> on the server.</li>
          <li><b>AI model red</b> → model file missing or failed to load. &ldquo;Running on CPU, not GPU&rdquo; means
            it works but slowly — check the GPU row.</li>
          <li><b>WebRTC red</b> → the video relay (coturn) is down: <code>sudo systemctl restart coturn</code>.</li>
          <li><b>Disk red</b> → recordings filled the disk; nothing new can be saved.</li>
          <li><b>&ldquo;Cannot call send once a close message has been sent&rdquo;</b> → the browser disconnected
            first. Usually a side effect; look at what happened just <i>before</i> it.</li>
          <li><b>This page won&apos;t load at all</b> → the backend itself is down. On the server:
            {" "}<code>systemctl status polyp-backend</code> and
            {" "}<code>journalctl -u polyp-backend -n 50</code>.</li>
        </ul>
      </div>
    </details>
  );
}

function Components({ data }: { data: StatusResp }) {
  const [open, setOpen] = useState<string | null>(null);
  const [label, cls] = OVERALL[data.overall];
  return (
    <section className="mb-6">
      <div className={`mb-3 rounded-lg border px-4 py-2 font-medium ${cls}`}>{label}</div>
      <div className="rounded-lg border border-gray-800 divide-y divide-gray-800/80">
        {data.components.map((c) => (
          <div key={c.key}>
            <button onClick={() => setOpen(open === c.key ? null : c.key)}
                    className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-gray-900">
              <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${DOT[c.state]}`} />
              <span className="w-44 shrink-0 text-sm text-gray-200">{c.label}</span>
              <span className={`text-sm flex-1 ${c.state === "fail" ? "text-red-300" : c.state === "warn" ? "text-amber-200" : "text-gray-400"}`}>
                {c.summary}
              </span>
              <span className="text-xs text-gray-600 tabular-nums">{c.ms} ms</span>
            </button>
            {open === c.key && (
              <dl className="px-9 pb-3 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-0.5 text-xs">
                {Object.entries(c.detail).length === 0
                  ? <dd className="text-gray-600">no extra detail</dd>
                  : Object.entries(c.detail).map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="text-gray-500">{k}</dt>
                      <dd className="text-gray-300 font-mono break-all">{fmt(v)}</dd>
                    </div>
                  ))}
              </dl>
            )}
          </div>
        ))}
      </div>
      <p className="mt-1 text-xs text-gray-600">Checked {data.checked_at} (server time)</p>
    </section>
  );
}

function Logs({ tick }: { tick: number }) {
  const [minutes, setMinutes] = useState(60);
  const [level, setLevel] = useState("WARNING");
  const [component, setComponent] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [data, setData] = useState<LogsResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    const p = new URLSearchParams({ minutes: String(minutes), level, limit: "300" });
    if (component) p.set("component", component);
    if (q.trim()) p.set("q", q.trim());
    const ctl = new AbortController();
    fetch(`${API}/api/status/logs?${p}`, { credentials: "include", cache: "no-store", signal: ctl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => { setData(d); setErr(null); })
      .catch((e) => { if (e.name !== "AbortError") setErr(String(e.message || e)); });
    return () => ctl.abort();
  }, [minutes, level, component, q, tick]);

  const sel = "bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm";
  return (
    <section>
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <h2 className="text-lg font-semibold mr-2">Log</h2>
        <select className={sel} value={level} onChange={(e) => setLevel(e.target.value)}>
          <option value="ERROR">Errors only</option>
          <option value="WARNING">Warnings + errors</option>
          <option value="INFO">Everything</option>
        </select>
        <select className={sel} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
          <option value={15}>last 15 min</option>
          <option value={60}>last hour</option>
          <option value={360}>last 6 hours</option>
          <option value={1440}>last 24 hours</option>
          <option value={10080}>last 7 days</option>
        </select>
        <input className={`${sel} w-48`} placeholder="search text…" value={q}
               onChange={(e) => setQ(e.target.value)} />
      </div>
      {data && (
        <div className="flex flex-wrap gap-1.5 mb-3 text-xs">
          <button onClick={() => setComponent(null)}
                  className={`px-2 py-0.5 rounded-full border ${!component ? "border-sky-500 text-sky-300" : "border-gray-700 text-gray-400"}`}>
            all components
          </button>
          {Object.entries(data.components).map(([c, n]) => (
            <button key={c} onClick={() => setComponent(component === c ? null : c)}
                    className={`px-2 py-0.5 rounded-full border ${component === c ? "border-sky-500 text-sky-300" : "border-gray-700 text-gray-400 hover:border-gray-500"}`}>
              {c} <span className="text-gray-600">{n}</span>
            </button>
          ))}
        </div>
      )}
      {err && <p className="text-red-400 text-sm">Could not load the log: {err}</p>}
      {data && (
        <>
          <p className="text-xs text-gray-600 mb-1">
            {data.total} matching line(s){data.total > data.entries.length ? `, newest ${data.entries.length} shown` : ""} · {data.log_file}
          </p>
          <div className="rounded-lg border border-gray-800 font-mono text-xs divide-y divide-gray-900 max-h-[60vh] overflow-auto">
            {data.entries.length === 0 && <p className="p-3 text-gray-600">Nothing here — good news, or widen the filters.</p>}
            {data.entries.map((e, i) => (
              <div key={i}>
                <button onClick={() => e.extra && setOpen(open === i ? null : i)}
                        className={`w-full text-left px-2 py-1 flex gap-2 ${e.extra ? "hover:bg-gray-900 cursor-pointer" : "cursor-default"}`}>
                  <span className="text-gray-600 shrink-0">{e.time.slice(11)}</span>
                  <span className={`w-14 shrink-0 ${LEVEL_COLOR[e.level] || ""}`}>{e.level}</span>
                  <span className="w-28 shrink-0 text-sky-400 truncate" title={e.component}>{e.component}</span>
                  <span className="text-gray-300 break-all">{e.extra ? (open === i ? "▾ " : "▸ ") : ""}{e.message}</span>
                </button>
                {open === i && e.extra && (
                  <pre className="px-4 py-2 bg-black/40 text-red-200 whitespace-pre-wrap break-all">{e.extra}</pre>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

export default function StatusDashboard() {
  const [data, setData] = useState<StatusResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);
  const [tick, setTick] = useState(0);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    fetch(`${API}/api/status`, { credentials: "include", cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => { setData(d); setErr(null); })
      .catch((e) => setErr(String(e.message || e)))
      .finally(() => setLoading(false));
    setTick((t) => t + 1);
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!auto) return;
    const id = setInterval(load, 10_000);
    return () => clearInterval(id);
  }, [auto, load]);

  return (
    <>
      <div className="flex items-center gap-3 mb-4 text-sm">
        <button onClick={load} disabled={loading}
                className="px-3 py-1 rounded border border-gray-700 hover:border-gray-500 disabled:opacity-50">
          {loading ? "Checking…" : "↻ Refresh"}
        </button>
        <label className="flex items-center gap-1.5 text-gray-400">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          auto-refresh every 10 s
        </label>
      </div>
      <Guide />
      {err && (
        <div className="mb-4 rounded-lg border border-red-700 bg-red-950/40 px-4 py-2 text-red-300 text-sm">
          Could not reach the backend ({err}). The backend itself may be down — on the server run
          {" "}<code>systemctl status polyp-backend</code>.
        </div>
      )}
      {data && <Components data={data} />}
      <Logs tick={tick} />
    </>
  );
}
