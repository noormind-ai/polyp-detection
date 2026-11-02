"use client";

/**
 * /clinic-test UI: a form, a 7-step progress line, and a comparison table
 * over past reports. All measurement logic lives in lib/clinicDiagnostic.ts.
 *
 * Internal debugging tool — English-only, LTR (the page sets dir), and the
 * styling intentionally mirrors the rest of the app's gray-950 chrome.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  MACHINE_TYPES, CONNECTIONS,
  runDiagnostic, uploadDiagnostic, downloadDiagnostic,
  fetchReportList, fetchReport,
  type ClinicReport, type DiagnosticProgress, type DiagnosticResult,
  type ReportSummary, type StatSummary,
} from "@/lib/clinicDiagnostic";

type Phase = "form" | "running" | "uploading" | "done" | "upload-failed" | "failed";

const input = "w-full px-3 py-2 rounded-lg bg-gray-900 border border-gray-700 text-gray-200 text-sm";
const label = "block text-xs text-gray-500 uppercase tracking-wide mb-1";

// ------------------------------------------------------- comparison rows ----

type R = ClinicReport;
const g = (r: R, path: string): unknown =>
  path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], r);
const num = (v: unknown, digits = 2): string =>
  typeof v === "number" ? v.toFixed(digits).replace(/\.00$/, "") : "—";
const stat = (v: unknown): string => {
  const s = v as StatSummary | null;
  return s && typeof s.median === "number" ? `${s.median} (p90 ${s.p90})` : "—";
};

interface Row { name: string; render: (r: R) => string; warn?: (r: R) => boolean }

/** The handful of numbers worth reading before anything else, shown inline
 *  the moment a run finishes. The full table is still the comparison view. */
const RESULT_HIGHLIGHTS: Array<{ name: string; render: (r: R) => string }> = [
  { name: "Signal", render: (r) => {
      const c = g(r, "signal.comb.median");
      const interlaced = typeof c === "number" && c > 1.0;
      return `${describeMode(r)} · comb ${num(c)} → ${interlaced ? "interlaced" : "progressive"}`;
    } },
  { name: "Endoscope", render: (r) => {
      const rect = g(r, "scope.picture_rect") as { w: number; h: number } | null;
      const stated = [r.processor_model, r.scope_model].filter(Boolean).join(" / ");
      return `${stated || "model not stated"} · picture ${rect ? `${rect.w}×${rect.h}` : "?"} · overlay ink ${num(g(r, "scope.osd_ink_left_pct"), 1)}%`;
    } },
  { name: "Levels", render: (r) => `crushed ${num(g(r, "signal.histogram.pct_0_5"), 1)}% · clipped ${num(g(r, "signal.histogram.pct_250_255"), 1)}% · noise ${num(g(r, "signal.temporal_noise.mean_abs_diff"))}` },
  { name: "Proc-amp controls", render: (r) => {
      const p = g(r, "mode_scan.proc_amp") as Record<string, boolean> | undefined;
      if (!p) return "unknown";
      const on = Object.entries(p).filter(([, v]) => v).map(([k]) => k);
      return on.length ? `available: ${on.join(", ")}` : "none exposed by this driver";
    } },
  { name: "CPU per frame", render: (r) => `deinterlace ${stat(g(r, "timings.deinterlace_ms"))} · downscale ${stat(g(r, "timings.downscale_ms"))} · JPEG ${stat(g(r, "timings.jpeg_encode_ms"))}` },
  { name: "Capture rate", render: (r) => `${stat(g(r, "timings.rvfc_fps"))} fps of an expected 29.97` },
  { name: "Recording", render: (r) => {
      const rec = r.recording as Array<Record<string, unknown>> | undefined;
      if (!rec?.length) return "—";
      return rec.map((x) => (x.error ? `${x.key}: failed` : `${x.key} ${x.effective_kbps} kbps`)).join(" · ");
    } },
  { name: "Sample kept", render: (r) => {
      const s = r.sample as Record<string, unknown> | undefined;
      if (!s) return "none";
      const mb = (n: unknown) => (typeof n === "number" ? `${(n / 1e6).toFixed(1)} MB` : "—");
      return `${s.seconds}s clip ${mb(s.bytes)} (${s.effective_kbps ?? "?"} kbps) · ${s.burst_frames ?? 0} lossless frames ${mb(s.burst_bytes)}`;
    } },
  { name: "Network", render: (r) => `RTT ${num(g(r, "network.rtt_median_ms"), 1)} ms · upload ${num(g(r, "network.upload.mbps"))} Mbps` },
];

function describeMode(r: R): string {
  return String(g(r, "mode_scan.description") || "mode unknown");
}

const ROWS: Row[] = [
  { name: "Machine", render: (r) => `${r.machine_type ?? "—"}` },
  { name: "Connection", render: (r) => `${r.connection ?? "unknown"}` },
  { name: "Run by / date", render: (r) => `${r.user ?? "?"} · ${r.created_at ? new Date((r.created_at as number) * 1000).toLocaleString() : "?"}` },
  { name: "Device label", render: (r) => String(g(r, "device.label") || "—") },
  { name: "Hardware ID (manual)", render: (r) => String(r.hardware_id || "—") },
  { name: "Processor / scope (stated)", render: (r) => `${r.processor_model || "—"} / ${r.scope_model || "—"}` },
  { name: "Picture area in signal", render: (r) => {
      const rect = g(r, "scope.picture_rect") as { x: number; y: number; w: number; h: number } | null;
      return rect ? `${rect.w}×${rect.h} at ${rect.x},${rect.y} (${num(g(r, "scope.picture_aspect"))}:1)` : "—";
    } },
  { name: "Border / overlay", render: (r) => `${num(g(r, "scope.picture_trim_fraction"), 3)} trimmed · OSD ink L ${num(g(r, "scope.osd_ink_left_pct"), 1)}% · B ${num(g(r, "scope.osd_ink_bottom_pct"), 1)}%` },
  { name: "White balance in picture (RGB)", render: (r) => {
      const c = g(r, "scope.white_balance_in_picture") as { r: number; g: number; b: number } | null;
      return c ? `${c.r},${c.g},${c.b}` : "—";
    } },
  { name: "Margin level (should be near 0)", render: (r) => {
      const c = g(r, "scope.margin_level_left") as { r: number; g: number; b: number } | null;
      return c ? `${c.r},${c.g},${c.b}` : "—";
    },
    warn: (r) => {
      const c = g(r, "scope.margin_level_left") as { r: number; g: number; b: number } | null;
      return !!c && (c.r + c.g + c.b) / 3 > 20;
    } },
  { name: "Negotiated mode", render: (r) => String(g(r, "mode_scan.description") || "—") },
  { name: "Pad fraction", render: (r) => num(g(r, "mode_scan.pad_fraction"), 3),
    warn: (r) => (g(r, "mode_scan.padded") as boolean) === true },
  { name: "Modes tried", render: (r) => String((g(r, "mode_scan.tried") as unknown[] | undefined)?.length ?? "—") },
  { name: "Proc-amp exposed (B/C/S/Sh)", render: (r) => {
      const p = g(r, "mode_scan.proc_amp") as Record<string, boolean> | undefined;
      if (!p) return "—";
      return (["brightness", "contrast", "saturation", "sharpness"] as const)
        .map((k) => (p[k] ? "✓" : "·")).join(" ");
    } },
  { name: "Comb ratio median / max", render: (r) => `${num(g(r, "signal.comb.median"))} / ${num(g(r, "signal.comb.max"))}`,
    warn: (r) => (g(r, "signal.comb.median") as number) > 1.0 },
  { name: "Sharpness (gradmean)", render: (r) => num(g(r, "signal.quality.gradmean")) },
  { name: "Luma mean / std", render: (r) => `${num(g(r, "signal.quality.mean"), 1)} / ${num(g(r, "signal.quality.std"), 1)}` },
  { name: "Crushed % (0–5) / clipped % (250–255)", render: (r) => `${num(g(r, "signal.histogram.pct_0_5"), 1)} / ${num(g(r, "signal.histogram.pct_250_255"), 1)}`,
    warn: (r) => (g(r, "signal.histogram.pct_250_255") as number) > 2 },
  { name: "Temporal noise (mean abs diff)", render: (r) => num(g(r, "signal.temporal_noise.mean_abs_diff")) },
  { name: "Paint rate fps (vs 29.97)", render: (r) => stat(g(r, "timings.rvfc_fps")),
    warn: (r) => ((g(r, "timings.rvfc_fps") as StatSummary | null)?.median ?? 99) < 25 },
  { name: "Deinterlace ms", render: (r) => stat(g(r, "timings.deinterlace_ms")) },
  { name: "Downscale ms", render: (r) => stat(g(r, "timings.downscale_ms")) },
  { name: "JPEG encode ms", render: (r) => stat(g(r, "timings.jpeg_encode_ms")) },
  { name: "Recording (effective kbps @ 1.2/4/8 Mbps)", render: (r) => {
      const rec = r.recording as Array<Record<string, unknown>> | undefined;
      if (!rec?.length) return "—";
      return rec.map((x) => (x.error ? "err" : String(x.effective_kbps))).join(" / ");
    } },
  { name: "Paint fps while recording (worst preset)", render: (r) => {
      const rec = r.recording as Array<Record<string, unknown>> | undefined;
      const meds = rec?.map((x) => (x.paint_fps as StatSummary | null)?.median)
        .filter((x): x is number => typeof x === "number");
      return meds?.length ? String(Math.min(...meds)) : "—";
    } },
  { name: "RTT median ms / upload Mbps", render: (r) => `${num(g(r, "network.rtt_median_ms"), 1)} / ${num(g(r, "network.upload.mbps"))}` },
  { name: "CPU cores / memory (GB class)", render: (r) => `${g(r, "environment.hardware_concurrency") ?? "—"} / ${g(r, "environment.device_memory") ?? "—"}` },
  { name: "GPU", render: (r) => String(g(r, "environment.gpu_renderer") || "—") },
  { name: "Screen", render: (r) => {
      const s = g(r, "environment.screen") as { w: number; h: number; dpr: number } | undefined;
      return s ? `${s.w}×${s.h} @${s.dpr}x` : "—";
    } },
  { name: "Live inference during test", render: (r) => (r.live_inference_active ? "YES — network numbers pessimistic" : "no") },
  { name: "Step errors", render: (r) => {
      const e = r.errors as Record<string, string> | undefined;
      const keys = e ? Object.keys(e) : [];
      return keys.length ? keys.join(", ") : "none";
    },
    warn: (r) => Object.keys((r.errors as Record<string, string>) ?? {}).length > 0 },
];

// ------------------------------------------------------------- component ----

export default function ClinicTest() {
  const [phase, setPhase] = useState<Phase>("form");
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceErr, setDeviceErr] = useState("");
  const [form, setForm] = useState({ label: "", machineType: "clinic-computer",
                                     connection: "composite", deviceId: "", hardwareId: "",
                                     processorModel: "", scopeModel: "",
                                     sampleSeconds: 15 });
  const [progress, setProgress] = useState<DiagnosticProgress | null>(null);
  const [reportId, setReportId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const resultRef = useRef<DiagnosticResult | null>(null);

  const [reports, setReports] = useState<ReportSummary[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [full, setFull] = useState<Record<string, ClinicReport>>({});
  const [listErr, setListErr] = useState("");

  const refreshList = useCallback(() => {
    fetchReportList().then(setReports).catch((e) => setListErr(String(e)));
  }, []);
  useEffect(() => { refreshList(); }, [refreshList]);

  // Labels are blank until the user has granted camera permission once, so
  // open (and immediately close) a throwaway stream before enumerating.
  async function loadDevices() {
    setDeviceErr("");
    try {
      const warm = await navigator.mediaDevices.getUserMedia({ video: true });
      warm.getTracks().forEach((t) => t.stop());
      const all = (await navigator.mediaDevices.enumerateDevices())
        .filter((d) => d.kind === "videoinput");
      setDevices(all);
      if (all.length && !form.deviceId) setForm((f) => ({ ...f, deviceId: all[0].deviceId }));
    } catch (e) {
      setDeviceErr(`Camera access failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  async function run() {
    setPhase("running");
    setError("");
    try {
      const result = await runDiagnostic(
        { deviceId: form.deviceId, label: form.label.trim(),
          machineType: form.machineType, connection: form.connection,
          hardwareId: form.hardwareId.trim(),
          processorModel: form.processorModel.trim(), scopeModel: form.scopeModel.trim(),
          sampleSeconds: form.sampleSeconds },
        setProgress,
      );
      resultRef.current = result;
      setPhase("uploading");
      const id = await uploadDiagnostic(result);
      setReportId(id);
      setPhase("done");
      refreshList();
    } catch (e) {
      if (resultRef.current) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("upload-failed");
      } else {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("failed");
      }
    }
  }

  async function retryUpload() {
    if (!resultRef.current) return;
    setPhase("uploading");
    try {
      const id = await uploadDiagnostic(resultRef.current);
      setReportId(id);
      setPhase("done");
      refreshList();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("upload-failed");
    }
  }

  function toggleSelect(id: string) {
    setSelected((cur) => {
      const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id].slice(-3);
      next.filter((x) => !full[x]).forEach((x) => {
        fetchReport(x).then((r) => setFull((f) => ({ ...f, [x]: r }))).catch(() => { /* row shows — */ });
      });
      return next;
    });
  }

  const chosen = selected.map((id) => full[id]).filter(Boolean) as ClinicReport[];

  return (
    <div className="space-y-8">
      {/* ------------------------------------------------ run a new test */}
      <section className="bg-gray-900/50 border border-gray-800 rounded-xl p-4 space-y-4">
        <h2 className="text-base font-semibold text-white">Run a new test (~2 minutes)</h2>

        {phase === "form" || phase === "failed" ? (
          <div className="space-y-3 max-w-xl">
            <div>
              <span className={label}>Test label (required)</span>
              <input className={input} value={form.label} placeholder='e.g. "clinic — their PC, their card"'
                     onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <span className={label}>Machine</span>
                <select className={input} value={form.machineType}
                        onChange={(e) => setForm((f) => ({ ...f, machineType: e.target.value }))}>
                  {MACHINE_TYPES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
              </div>
              <div>
                <span className={label}>Video input connection</span>
                <select className={input} value={form.connection}
                        onChange={(e) => setForm((f) => ({ ...f, connection: e.target.value }))}>
                  {CONNECTIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
                <p className="text-[11px] text-gray-600 mt-1">
                  Look at the physical cable into the capture card — the digitized signal cannot reveal this.
                </p>
              </div>
            </div>
            <div>
              <span className={label}>Capture device</span>
              {devices.length === 0 ? (
                <button onClick={loadDevices}
                        className="px-3 py-2 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-sm">
                  Allow camera access &amp; list devices
                </button>
              ) : (
                <select className={input} value={form.deviceId}
                        onChange={(e) => setForm((f) => ({ ...f, deviceId: e.target.value }))}>
                  {devices.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>{d.label || d.deviceId.slice(0, 12)}</option>
                  ))}
                </select>
              )}
              {deviceErr && <p className="text-xs text-red-400 mt-1">{deviceErr}</p>}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <span className={label}>Endoscope processor (optional)</span>
                <input className={input} value={form.processorModel}
                       placeholder="e.g. Olympus CV-170"
                       onChange={(e) => setForm((f) => ({ ...f, processorModel: e.target.value }))} />
              </div>
              <div>
                <span className={label}>Scope (optional)</span>
                <input className={input} value={form.scopeModel}
                       placeholder="e.g. CF-H190L"
                       onChange={(e) => setForm((f) => ({ ...f, scopeModel: e.target.value }))} />
              </div>
            </div>
            <p className="text-[11px] text-gray-600 -mt-1">
              From the label on the tower and the scope handle. The test also reads the processor&apos;s
              own on-screen overlay out of the signal — run it with the scope out of the patient and
              the picture live, so the overlay and the light are both present.
            </p>
            <div>
              <span className={label}>Hardware ID (optional, from Device Manager)</span>
              <input className={`${input} font-mono`} value={form.hardwareId}
                     placeholder="USB\VID_1C88&PID_1001&…"
                     onChange={(e) => setForm((f) => ({ ...f, hardwareId: e.target.value }))} />
              <details className="mt-1 text-[11px] text-gray-600">
                <summary className="cursor-pointer text-gray-500">How to find it</summary>
                <p className="mt-1">
                  Device Manager → your capture device → Properties → Details tab → “Hardware Ids”.
                  Paste the top line. Decoder: VID_1C88 = Somagic clone · VID_05E1 = Syntek STK1160
                  (genuine ezcap) · VID_1B71 = UTV007.
                </p>
              </details>
            </div>
            <div>
              <span className={label}>Keep a sample of the signal</span>
              <select className={input} value={form.sampleSeconds}
                      onChange={(e) => setForm((f) => ({ ...f, sampleSeconds: Number(e.target.value) }))}>
                <option value={15}>15 seconds (recommended)</option>
                <option value={60}>60 seconds</option>
                <option value={180}>3 minutes</option>
                <option value={0}>Don&apos;t keep a sample</option>
              </select>
              <p className="text-[11px] text-gray-600 mt-1">
                Recorded at 25 Mbps, plus 24 consecutive frames kept losslessly — the raw material
                for any analysis we think of later. 15 s is about 50 MB; 3 minutes about 560 MB.
                Patient video: run it with the scope out of the patient unless you mean to keep it.
              </p>
            </div>
            {phase === "failed" && <p className="text-sm text-red-400">Run failed: {error}</p>}
            <button
              onClick={run}
              disabled={!form.label.trim() || !form.deviceId}
              className="px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium
                         disabled:opacity-40 disabled:cursor-not-allowed">
              ▶ Run diagnostic
            </button>
          </div>
        ) : phase === "running" || phase === "uploading" ? (
          <div className="space-y-2">
            <p className="text-sm text-gray-200">
              {phase === "uploading" ? "Uploading report + frames…"
                : progress ? `Step ${progress.step}/${progress.totalSteps} — ${progress.label}` : "Starting…"}
            </p>
            {phase === "running" && progress?.detail && (
              <p className="text-xs text-gray-500 font-mono">{progress.detail}</p>
            )}
            <div className="h-1.5 rounded-full bg-gray-800 overflow-hidden max-w-md">
              <div className="h-full bg-blue-500 transition-all"
                   style={{ width: `${phase === "uploading" ? 95 : ((progress?.step ?? 0) / 7) * 90}%` }} />
            </div>
            <p className="text-[11px] text-gray-600">Keep this tab open and the camera connected.</p>
          </div>
        ) : phase === "done" ? (
          <div className="space-y-3">
            <p className="text-sm text-green-400">✓ Uploaded as <span className="font-mono">{reportId}</span></p>
            {resultRef.current && (
              <div className="rounded-lg border border-gray-800 bg-gray-950/60 p-3">
                <table className="text-xs font-mono">
                  <tbody>
                    {RESULT_HIGHLIGHTS.map((h) => (
                      <tr key={h.name}>
                        <td className="pe-4 py-0.5 text-gray-500 whitespace-nowrap align-top">{h.name}</td>
                        <td className="py-0.5 text-gray-300">{h.render(resultRef.current!.report)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {Object.keys(resultRef.current.report.errors ?? {}).length > 0 && (
                  <p className="mt-2 text-xs text-amber-400">
                    Steps that failed: {Object.entries(resultRef.current.report.errors)
                      .map(([k, v]) => `${k} (${v})`).join(" · ")}
                  </p>
                )}
              </div>
            )}
            <button onClick={() => { setPhase("form"); setProgress(null); }}
                    className="px-3 py-1.5 rounded-lg border border-gray-700 text-gray-300 text-sm hover:border-gray-500">
              Run another test
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-amber-400">
              Measurements finished but the upload failed: {error}
            </p>
            <div className="flex gap-2">
              <button onClick={retryUpload}
                      className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm">
                Retry upload
              </button>
              <button onClick={() => resultRef.current && downloadDiagnostic(resultRef.current)}
                      className="px-3 py-1.5 rounded-lg border border-gray-700 text-gray-300 text-sm hover:border-gray-500">
                ⬇ Save report + frames to this computer
              </button>
            </div>
          </div>
        )}
      </section>

      {/* ------------------------------------------------ past tests */}
      <section className="space-y-3">
        <h2 className="text-base font-semibold text-white">Past tests — pick up to 3 to compare</h2>
        {listErr && <p className="text-xs text-red-400">{listErr}</p>}
        {reports.length === 0 ? (
          <p className="text-sm text-gray-600">No reports yet.</p>
        ) : (
          <div className="space-y-1">
            {reports.map((r) => (
              <label key={r.id}
                     className="flex items-center gap-3 text-sm text-gray-300 bg-gray-900/40 border border-gray-800
                                rounded-lg px-3 py-2 cursor-pointer hover:border-gray-600">
                <input type="checkbox" className="accent-blue-500"
                       checked={selected.includes(r.id)} onChange={() => toggleSelect(r.id)} />
                <span className="font-medium">{r.label}</span>
                <span className="text-gray-500">{r.machine_type}</span>
                <span className="text-gray-500">{r.connection}</span>
                <span className="text-gray-600 text-xs">{new Date(r.created_at * 1000).toLocaleString()}</span>
                <span className="text-gray-600 text-xs truncate">{r.device_label}</span>
                <span className="text-gray-700 text-xs ms-auto font-mono">{r.id} · {r.frames}fr</span>
              </label>
            ))}
          </div>
        )}

        {chosen.length > 0 && (
          <div className="overflow-x-auto">
            <table className="text-xs font-mono border-collapse min-w-full">
              <thead>
                <tr>
                  <th className="text-left text-gray-500 font-normal p-2 border-b border-gray-800">Spec</th>
                  {chosen.map((r, i) => (
                    <th key={i} className="text-left text-gray-200 p-2 border-b border-gray-800">
                      {String(r.label)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ROWS.map((row) => (
                  <tr key={row.name} className="border-b border-gray-900">
                    <td className="p-2 text-gray-500 whitespace-nowrap">{row.name}</td>
                    {chosen.map((r, i) => (
                      <td key={i}
                          className={`p-2 ${row.warn?.(r) ? "text-amber-400" : "text-gray-300"}`}>
                        {row.render(r)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
