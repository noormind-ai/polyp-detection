"use client";

import { DEMO_VIDEOS } from "./demos";
import { useLanguage } from "@/lib/i18n";

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

interface Props {
  onSelect: (file: string) => void;
  loading?: string | null; // file currently loading
}

export default function DemoVideoPicker({ onSelect, loading }: Props) {
  const { t } = useLanguage();
  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-400">{t("Choose a demo clip to run inference on:")}</p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {DEMO_VIDEOS.map((v) => {
          const isLoading = loading === v.file;
          return (
            <button
              key={v.file}
              onClick={() => onSelect(v.file)}
              disabled={!!loading}
              className="group flex flex-col rounded-xl border border-gray-700 hover:border-blue-500 bg-gray-900 hover:bg-blue-950/10 transition-colors overflow-hidden text-left disabled:opacity-60 disabled:cursor-wait"
            >
              {/* Thumbnail */}
              <div className="aspect-video w-full bg-gray-800 flex items-center justify-center overflow-hidden">
                {v.thumbnail ? (
                  <img
                    src={`${BASE_PATH}/demos/${v.thumbnail}`}
                    alt={t(v.label)}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <svg className="w-8 h-8 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                      d="M15 10l4.553-2.369A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M3 8a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z" />
                  </svg>
                )}
              </div>

              {/* Label */}
              <div className="px-3 py-2">
                <p className="text-sm text-white font-medium group-hover:text-blue-300 transition-colors">
                  {isLoading ? t("Loading…") : t(v.label)}
                </p>
                <p className="text-xs text-gray-500 mt-0.5">{t(v.description)}</p>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
