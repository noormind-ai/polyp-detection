"use client";

/**
 * /status — system health at a glance: which component is broken, and the
 * log lines that say why. English-only and LTR like /clinic-test: it's an
 * engineering tool. Sign-in required — log lines carry usernames and case ids.
 */

import { useEffect } from "react";
import StatusDashboard from "@/components/StatusDashboard";
import { useAuth } from "@/lib/auth";

export default function StatusPage() {
  const { user, loading } = useAuth();

  useEffect(() => {
    if (!loading && !user) window.location.replace("/login?next=/status");
  }, [loading, user]);

  return (
    <main dir="ltr" className="min-h-screen bg-gray-950 text-white">
      <div className="max-w-6xl mx-auto p-4 sm:p-8">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h1 className="text-xl sm:text-2xl font-semibold">System status</h1>
            <p className="text-gray-500 text-sm mt-1">
              Which part is broken, and the log lines that say why.
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
          : <StatusDashboard />}
      </div>
    </main>
  );
}
