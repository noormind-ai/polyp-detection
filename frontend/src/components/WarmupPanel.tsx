"use client";

import { useEffect, useState } from "react";
import { useLanguage } from "@/lib/i18n";

// Paced against a measured cold start (~13s on the T4, weights already in the
// Modal Volume), not the ~60s this described when it named an A100 and assumed
// a first-ever run that downloads the weights. Steps that scroll past long
// after the GPU is ready read as a stalled system.
const STEPS = [
  { at: 0,     text: "Requesting T4 GPU on Modal..." },
  { at: 2000,  text: "Container provisioning..." },
  { at: 5000,  text: "Loading runtime environment..." },
  { at: 8000,  text: "Loading YOLOv5 into GPU memory..." },
  { at: 11000, text: "Warming up inference pipeline..." },
];

export default function WarmupPanel() {
  const { t } = useLanguage();
  const [logs, setLogs] = useState<string[]>([]);
  const cliCommand = "modal app stop polyp-detection";
  const [footerBefore, footerAfter] = t(
    "Cold start ~15s · Warm starts are instant · Stop with modal app stop polyp-detection"
  ).split(cliCommand);

  useEffect(() => {
    const timers = STEPS.map(({ at, text }) =>
      setTimeout(() => setLogs((prev) => [...prev, text]), at)
    );
    return () => timers.forEach(clearTimeout);
  }, []);

  const progress = Math.min(90, Math.round((logs.length / STEPS.length) * 100));

  return (
    <div className="space-y-5 py-4">
      <div>
        <div className="flex justify-between text-sm text-gray-400 mb-2">
          <span>{t("Starting GPU session")}</span>
          <span>{progress}%</span>
        </div>
        <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
          <div
            className="h-full bg-blue-500 rounded-full transition-all duration-1000 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 font-mono text-xs text-green-400 h-44 overflow-y-auto">
        {logs.map((line, i) => (
          <div key={i} className="leading-6">
            <span className="text-gray-600 select-none mr-2">
              {String(i + 1).padStart(2, "0")}
            </span>
            {t(line)}
          </div>
        ))}
        {logs.length > 0 && (
          <span className="animate-pulse text-blue-400">▋</span>
        )}
      </div>

      <p className="text-xs text-gray-600 text-center">
        {footerBefore}
        <code className="text-gray-500">{cliCommand}</code>
        {footerAfter}
      </p>
    </div>
  );
}
