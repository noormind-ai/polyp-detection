"use client";

/**
 * /clinic-test — internal capture-card diagnostic.
 *
 * A route (rather than a mode on the home page) so it can be opened on a
 * clinic machine in seconds and never mixes with the real procedure UI.
 * English-only and LTR: it's an engineering tool, and its output is tables
 * of numbers. Sign-in required — the raw frames it uploads carry whatever
 * is on the endoscope screen, same sensitivity as a feedback capture.
 */

import { useEffect } from "react";
import ClinicTest from "@/components/ClinicTest";
import { useAuth } from "@/lib/auth";

export default function ClinicTestPage() {
  const { user, loading } = useAuth();

  useEffect(() => {
    if (!loading && !user) window.location.replace("/login?next=/clinic-test");
  }, [loading, user]);

  return (
    <main dir="ltr" className="min-h-screen bg-gray-950 text-white">
      <div className="max-w-6xl mx-auto p-4 sm:p-8">
        <div className="flex items-start justify-between gap-4 mb-6">
          <div>
            <h1 className="text-xl sm:text-2xl font-semibold">Capture-card diagnostic</h1>
            <p className="text-gray-500 text-sm mt-1">
              Measures what the capture card delivers on THIS machine — modes, signal,
              per-stage CPU cost, encoder behaviour, and the link to the server — and files
              it for side-by-side comparison with runs from other machines.
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
          : <ClinicTest />}
      </div>
    </main>
  );
}
