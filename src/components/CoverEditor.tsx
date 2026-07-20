// src/components/CoverEditor.tsx
"use client";

import { useState, type ChangeEvent } from "react";
import { CoverCamera } from "@/components/CoverCamera";

// Must match src/lib/coverStorage.ts's MIME_TO_EXT exactly -- the server
// only saves these three types, so accepting anything broader here just
// defers a guaranteed failure to after a full round-trip.
const ACCEPTED_COVER_TYPES = ["image/png", "image/jpeg", "image/webp"];

interface CoverEditorProps {
  currentCoverPath: string | null;
  bookIsbn: string | null;
  allowCamera?: boolean;
  // Both FileReader.readAsDataURL and the Open Library lookup fetch are
  // async -- without this, a submit click that lands in the window before
  // either resolves would submit the hidden fields' stale (empty) values,
  // silently no-op'ing the cover change with no error shown. The parent
  // form uses this to disable its own submit button until either settles.
  onBusyChange?: (busy: boolean) => void;
}

// Shared cover-picking UI reused across the physical/ebook/audiobook copy
// edit pages. Outputs the same two hidden fields CoverPicker already
// established (selectedCoverDataUrl / selectedCoverSource) so the
// surrounding <form>'s submit handling and resolveCoverUpdate (src/lib/copyCovers.ts)
// don't need to know which UI produced them.
export function CoverEditor({
  currentCoverPath,
  bookIsbn,
  allowCamera = false,
  onBusyChange,
}: CoverEditorProps) {
  const [selectedDataUrl, setSelectedDataUrl] = useState<string | null>(null);
  const [selectedSource, setSelectedSource] = useState<"dataUrl" | "url" | null>(null);
  const [isLookingUp, setIsLookingUp] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [showCamera, setShowCamera] = useState(false);

  async function handleLookup() {
    if (!bookIsbn) return;
    setIsLookingUp(true);
    setLookupError(null);
    onBusyChange?.(true);
    try {
      const response = await fetch(`/api/isbn-lookup?isbn=${encodeURIComponent(bookIsbn)}`);
      const data = await response.json();
      if (!response.ok || !data.coverUrl) {
        setLookupError("No Open Library cover found for this ISBN.");
        return;
      }
      setSelectedDataUrl(data.coverUrl);
      setSelectedSource("url");
    } catch {
      setLookupError("Couldn't reach the lookup service.");
    } finally {
      setIsLookingUp(false);
      onBusyChange?.(false);
    }
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!ACCEPTED_COVER_TYPES.includes(file.type)) {
      setLookupError("Please choose a PNG, JPEG, or WebP image.");
      event.target.value = "";
      return;
    }
    setLookupError(null);
    onBusyChange?.(true);
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        setSelectedDataUrl(reader.result);
        setSelectedSource("dataUrl");
      }
      onBusyChange?.(false);
    };
    reader.onerror = () => {
      setLookupError("Couldn't read the selected file.");
      onBusyChange?.(false);
    };
    reader.readAsDataURL(file);
    event.target.value = "";
  }

  const previewSrc =
    selectedDataUrl ??
    (currentCoverPath ? `/api/covers/${encodeURIComponent(currentCoverPath)}` : null);

  return (
    <div>
      <p className="mb-2 text-sm font-medium text-foreground">Cover Image</p>
      {previewSrc ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={previewSrc} alt="Cover" className="mb-2 h-32 w-24 rounded object-cover" />
      ) : (
        <p className="mb-2 text-sm text-foreground/70">No cover set.</p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <label className="cursor-pointer text-sm text-accent underline">
          Upload a file
          <input
            type="file"
            accept={ACCEPTED_COVER_TYPES.join(",")}
            onChange={handleFileChange}
            className="sr-only"
          />
        </label>
        {bookIsbn && (
          <button
            type="button"
            onClick={handleLookup}
            disabled={isLookingUp}
            className="text-sm text-accent underline disabled:opacity-50"
          >
            {isLookingUp ? "Looking up..." : "Use Open Library cover"}
          </button>
        )}
        {allowCamera && (
          <button type="button" onClick={() => setShowCamera(true)} className="text-sm text-accent underline">
            Take a photo
          </button>
        )}
      </div>
      {lookupError && <p className="mt-1 text-sm text-red-600">{lookupError}</p>}
      {allowCamera && showCamera && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Take a cover photo"
          className="fixed inset-0 z-10 overflow-y-auto bg-background p-4"
        >
          <CoverCamera
            onCapture={(dataUrl) => {
              setLookupError(null);
              setSelectedDataUrl(dataUrl);
              setSelectedSource("dataUrl");
              setShowCamera(false);
            }}
            onSkip={() => setShowCamera(false)}
          />
        </div>
      )}
      <input type="hidden" name="selectedCoverDataUrl" value={selectedDataUrl ?? ""} />
      <input type="hidden" name="selectedCoverSource" value={selectedSource ?? ""} />
    </div>
  );
}
