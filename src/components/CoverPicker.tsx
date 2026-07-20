// src/components/CoverPicker.tsx
"use client";

import { useEffect, useState } from "react";

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

  // CoverPicker now stays mounted while the cover-camera overlay is open
  // (see ScanAddForm), so capturedImageDataUrl can go from null to a real
  // photo well after this component's initial mount — the useState
  // initializer above only runs once and won't pick that up on its own.
  // Without this, a freshly (re)taken photo would silently not be selected
  // until the user manually clicked its thumbnail.
  useEffect(() => {
    if (capturedImageDataUrl) {
      setSelected("captured");
    }
  }, [capturedImageDataUrl]);

  const selectedDataUrl =
    selected === "captured"
      ? capturedImageDataUrl
      : selected === "openLibrary"
        ? openLibraryCoverUrl
        : null;

  if (!capturedImageDataUrl && !openLibraryCoverUrl && !onRetake) {
    return null;
  }

  return (
    <div>
      <p className="mb-2 text-sm font-medium text-foreground">Cover Image</p>
      {!capturedImageDataUrl && !openLibraryCoverUrl && (
        <p className="text-sm text-foreground/70">No cover selected yet.</p>
      )}
      <div className="flex gap-3">
        {capturedImageDataUrl && (
          <button
            type="button"
            onClick={() => setSelected("captured")}
            aria-pressed={selected === "captured"}
            className={`rounded-lg border-2 p-1 ${selected === "captured" ? "border-accent" : "border-transparent"}`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={capturedImageDataUrl} alt="Your photo" className="h-32 w-24 object-cover" />
            <p className="text-center text-xs text-foreground/70">Your photo</p>
          </button>
        )}
        {openLibraryCoverUrl && (
          <button
            type="button"
            onClick={() => setSelected("openLibrary")}
            aria-pressed={selected === "openLibrary"}
            className={`rounded-lg border-2 p-1 ${selected === "openLibrary" ? "border-accent" : "border-transparent"}`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={openLibraryCoverUrl} alt="Open Library cover" className="h-32 w-24 object-cover" />
            <p className="text-center text-xs text-foreground/70">Open Library</p>
          </button>
        )}
      </div>
      {onRetake && (
        <button type="button" onClick={onRetake} className="mt-2 text-sm text-accent underline">
          {capturedImageDataUrl ? "Retake photo" : "Add a photo"}
        </button>
      )}
      <input type="hidden" name="selectedCoverDataUrl" value={selectedDataUrl ?? ""} />
      <input
        type="hidden"
        name="selectedCoverSource"
        value={selected === "openLibrary" ? "url" : "dataUrl"}
      />
    </div>
  );
}
