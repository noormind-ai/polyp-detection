"use client";

import { useRef, useState } from "react";
import DemoVideoPicker from "./DemoVideoPicker";
import { DEMO_VIDEOS } from "./demos";
import { useLanguage } from "@/lib/i18n";

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

interface Props {
  onUpload: (file: File, gtUrl?: string) => void;
}

export default function UploadPanel({ onUpload }: Props) {
  const { t } = useLanguage();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [tab, setTab] = useState<"upload" | "demo">("demo");
  const [loadingDemo, setLoadingDemo] = useState<string | null>(null);

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) onUpload(file);
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) onUpload(file);
  }

  async function handleDemoSelect(filename: string) {
    setLoadingDemo(filename);
    try {
      const demo = DEMO_VIDEOS.find((v) => v.file === filename);
      const res = await fetch(`${BASE_PATH}/demos/${filename}`);
      const blob = await res.blob();
      const file = new File([blob], filename, { type: blob.type || "video/mp4" });
      const gtUrl = demo?.gtFile ? `${BASE_PATH}/demos/gt/${demo.gtFile}` : undefined;
      onUpload(file, gtUrl);
    } finally {
      setLoadingDemo(null);
    }
  }

  return (
    <div className="space-y-4">
      {/* Tab switcher */}
      <div className="flex gap-1 border-b border-gray-800">
        {(["upload", "demo"] as const).map((tabKey) => (
          <button
            key={tabKey}
            onClick={() => setTab(tabKey)}
            className={`px-4 py-2 text-sm font-medium transition-colors capitalize border-b-2 -mb-px ${
              tab === tabKey
                ? "border-blue-500 text-white"
                : "border-transparent text-gray-500 hover:text-gray-300"
            }`}
          >
            {tabKey === "upload" ? t("Upload video") : t("Try a demo")}
          </button>
        ))}
      </div>

      {tab === "upload" && (
        <div
          onDrop={handleDrop}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onClick={() => inputRef.current?.click()}
          className={`border-2 border-dashed rounded-xl p-20 text-center cursor-pointer transition-colors ${
            dragging ? "border-blue-400 bg-blue-950/20" : "border-gray-700 hover:border-gray-500"
          }`}
        >
          <input ref={inputRef} type="file" accept="video/*" className="hidden" onChange={handleChange} />
          <p className="text-gray-200 text-lg">{t("Drop a colonoscopy video here")}</p>
          <p className="text-gray-500 text-sm mt-2">{t("MP4 · MOV · max 500 MB")}</p>
        </div>
      )}

      {tab === "demo" && (
        <DemoVideoPicker onSelect={handleDemoSelect} loading={loadingDemo} />
      )}
    </div>
  );
}
