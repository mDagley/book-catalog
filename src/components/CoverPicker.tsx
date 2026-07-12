// src/components/CoverPicker.tsx
"use client";

import { useState } from "react";

interface CoverPickerProps {
  capturedImageDataUrl: string | null;
  openLibraryCoverUrl: string | null;
  onRetake?: () => void;
}

export function CoverPicker({
  capturedImageDataUrl,
  openLibraryCoverUrl,
  onRetake,
}: CoverPickerProps) {
  const [selected, setSelected] = useState<"captured" | "openLibrary" | "none">(
    capturedImageDataUrl ? "captured" : openLibraryCoverUrl ? "openLibrary" : "none",
  );

  const selectedDataUrl =
    selected === "captured"
      ? capturedImageDataUrl
      : selected === "openLibrary"
        ? openLibraryCoverUrl
        : null;

  if (!capturedImageDataUrl && !openLibraryCoverUrl) {
    return null;
  }

  return (
    <div>
      <p className="mb-2 text-sm font-medium">Cover Image</p>
      <div className="flex gap-3">
        {capturedImageDataUrl && (
          <button
            type="button"
            onClick={() => setSelected("captured")}
            className={`rounded border-2 p-1 ${selected === "captured" ? "border-black" : "border-transparent"}`}
          >
            <img src={capturedImageDataUrl} alt="Your photo" className="h-32 w-24 object-cover" />
            <p className="text-center text-xs">Your photo</p>
          </button>
        )}
        {openLibraryCoverUrl && (
          <button
            type="button"
            onClick={() => setSelected("openLibrary")}
            className={`rounded border-2 p-1 ${selected === "openLibrary" ? "border-black" : "border-transparent"}`}
          >
            <img src={openLibraryCoverUrl} alt="Open Library cover" className="h-32 w-24 object-cover" />
            <p className="text-center text-xs">Open Library</p>
          </button>
        )}
      </div>
      {onRetake && capturedImageDataUrl && (
        <button type="button" onClick={onRetake} className="mt-2 text-sm underline">
          Retake photo
        </button>
      )}
      <input
        type="hidden"
        name="selectedCoverDataUrl"
        value={selectedDataUrl ?? ""}
      />
      <input
        type="hidden"
        name="selectedCoverSource"
        value={selected === "openLibrary" ? "url" : "dataUrl"}
      />
    </div>
  );
}
