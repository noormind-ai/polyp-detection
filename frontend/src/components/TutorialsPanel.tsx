"use client";

import { useEffect, useState } from "react";
import { useLanguage } from "@/lib/i18n";

// The list comes from the backend, not from here. The offline guide walks
// through the clinical review panel, which an ordinary account cannot reach, so
// which guides exist is a question about the signed-in user and is answered
// server-side -- see /api/tutorials. Keeping the array in this file meant the
// CDN URL shipped inside the page bundle even when the card was filtered out.
//
// The files are ~250 MB together and are hosted on the CDN rather than this
// box, which runs inference on 4 GB of RAM. preload="none" keeps the page free
// too: nothing is fetched until a card is opened and played.
interface Tutorial {
  url: string;
  title: string;
  blurb: string;
}

export default function TutorialsPanel() {
  const { t } = useLanguage();
  const [tutorials, setTutorials] = useState<Tutorial[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let live = true;
    fetch("/api/tutorials", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : { tutorials: [] }))
      .then((d) => { if (live) { setTutorials(d.tutorials || []); setLoaded(true); } })
      .catch(() => { if (live) setLoaded(true); });
    return () => { live = false; };
  }, []);
  // Which card is expanded. Only one at a time: two 720p players side by side
  // on a phone are two thumbnails, and both would be downloading at once.
  const [open, setOpen] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-400">
        {/* How many there are depends on the account, so the sentence cannot
            say "two" any more. */}
        {tutorials.length > 1
          ? t("Two short guides to the feedback workflow. Nothing downloads until you press play.")
          : t("A short guide to the feedback workflow. Nothing downloads until you press play.")}
      </p>

      {/* Side by side while closed; the one you open takes the full width and
          the other keeps its place below it. */}
      <div
        className={`grid grid-cols-1 gap-4 items-start ${
          tutorials.length > 1 ? "md:grid-cols-2" : ""
        }`}
      >
        {tutorials.map((v) => {
          const isOpen = open === v.url;
          return (
            <div
              key={v.url}
              className={`rounded-xl border p-3 space-y-2 transition-colors ${
                isOpen
                  ? "md:col-span-2 border-purple-700 bg-purple-950/10"
                  : "border-gray-800 hover:border-gray-600"
              }`}
            >
              <button
                onClick={() => setOpen(isOpen ? null : v.url)}
                className="w-full text-start"
              >
                <span className="flex items-baseline gap-2">
                  <span className="text-gray-500 flex-shrink-0">{isOpen ? "▾" : "▸"}</span>
                  <span className="text-white font-medium">{t(v.title)}</span>
                </span>
                <span className="block text-sm text-gray-500 mt-1">{t(v.blurb)}</span>
              </button>

              {isOpen ? (
                <>
                  <video
                    src={v.url}
                    controls
                    autoPlay
                    preload="none"
                    playsInline
                    className="w-full rounded-lg border border-gray-800 bg-black"
                  />
                  <div className="flex items-center justify-between gap-3">
                    <button
                      onClick={() => setOpen(null)}
                      className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
                    >
                      {t("Close")}
                    </button>
                    <a
                      href={v.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
                    >
                      {t("Open in a new tab")}
                    </a>
                  </div>
                </>
              ) : (
                // Closed: a click target the size of the player it becomes, so
                // the card doesn't jump under the cursor when it opens.
                <button
                  onClick={() => setOpen(v.url)}
                  className="w-full aspect-video rounded-lg border border-gray-800 bg-black flex items-center justify-center text-3xl text-gray-600 hover:text-purple-300 hover:border-purple-700 transition-colors"
                  aria-label={t(v.title)}
                >
                  ▶
                </button>
              )}
            </div>
          );
        })}
      </div>

      {loaded && tutorials.length === 0 ? (
        <p className="text-sm text-gray-600 py-6 text-center">
          {t("No guides are available for this account.")}
        </p>
      ) : null}
    </div>
  );
}
