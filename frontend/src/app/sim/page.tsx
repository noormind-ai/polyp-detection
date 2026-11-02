"use client";

/**
 * /sim — capture-card simulator.
 *
 * Internal: plays a local video file as if it came from the capture card, so
 * the bitrate and the display-enhancement chain can be judged by eye and by
 * measurement without a card, a clinic, or a patient. Deliberately a separate
 * route from the live page — nothing experimental belongs next to a procedure.
 */

import { useEffect } from "react";
import CaptureSimulator from "@/components/CaptureSimulator";
import { useAuth } from "@/lib/auth";

export default function SimPage() {
  const { user, loading } = useAuth();

  useEffect(() => {
    if (!loading && !user) window.location.replace("/login?next=/sim");
  }, [loading, user]);

  return (
    <main dir="ltr" className="min-h-screen bg-gray-950 text-white">
      <div className="max-w-[1900px] mx-auto p-4 sm:p-6">
        <div className="flex items-start justify-between gap-4 mb-6">
          <div>
            <h1 className="text-xl sm:text-2xl font-semibold">Capture-card simulator</h1>
            <p className="text-gray-500 text-sm mt-1">
              A local file played through the live pipeline: raw, through the recording encoder at a
              bitrate you choose, through the display-enhancement chain, and through the model —
              side by side, with the cost of every stage measured.
            </p>
          </div>
          <a href="/"
             className="text-sm px-3 py-1.5 rounded-lg border border-gray-800 text-gray-400
                        hover:text-white hover:border-gray-600 transition-colors whitespace-nowrap">
            ← Back
          </a>
        </div>
        {!user
          ? <p className="text-center text-gray-600 py-10">Checking sign-in…</p>
          : <CaptureSimulator />}
      </div>
    </main>
  );
}
