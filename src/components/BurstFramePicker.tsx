// src/components/BurstFramePicker.tsx
"use client";

interface BurstFramePickerProps {
  shots: string[];
  onPick: (shot: string) => void;
  onRetake: () => void;
}

export function BurstFramePicker({ shots, onPick, onRetake }: BurstFramePickerProps) {
  return (
    <div>
      <p className="mb-2 text-sm font-medium text-foreground">Pick the clearest shot</p>
      <div className="flex gap-2 overflow-x-auto">
        {shots.map((shot, index) => (
          <button
            key={index}
            type="button"
            onClick={() => onPick(shot)}
            className="shrink-0 rounded border-2 border-transparent p-0.5 hover:border-accent"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={shot} alt={`Shot ${index + 1}`} className="h-32 w-24 rounded object-cover" />
          </button>
        ))}
      </div>
      <button type="button" onClick={onRetake} className="mt-2 text-sm text-link underline">
        Retake
      </button>
    </div>
  );
}
