// src/components/QuadCropEditor.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { computeOutputDimensions, warpQuadrilateral, type Point } from "@/lib/perspectiveCrop";

interface QuadCropEditorProps {
  imageDataUrl: string;
  onConfirm: (croppedDataUrl: string) => void;
  onRetake: () => void;
}

type CornerName = "topLeft" | "topRight" | "bottomRight" | "bottomLeft";
const CORNER_ORDER: CornerName[] = ["topLeft", "topRight", "bottomRight", "bottomLeft"];

export function QuadCropEditor({ imageDataUrl, onConfirm, onRetake }: QuadCropEditorProps) {
  const imgRef = useRef<HTMLImageElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const [displaySize, setDisplaySize] = useState<{ width: number; height: number } | null>(null);
  // Corner positions in DISPLAYED (on-screen, CSS pixel) coordinates --
  // converted to natural image pixel coordinates only at confirm time,
  // since the user drags against what they actually see, which may be
  // scaled down from the underlying (possibly much larger) captured image.
  const [corners, setCorners] = useState<Record<CornerName, Point> | null>(null);
  const draggingCorner = useRef<CornerName | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  function handleImageLoad() {
    const img = imgRef.current;
    if (!img) return;
    const natural = { width: img.naturalWidth, height: img.naturalHeight };
    const display = { width: img.clientWidth, height: img.clientHeight };
    setNaturalSize(natural);
    setDisplaySize(display);
    setCorners({
      topLeft: { x: 0, y: 0 },
      topRight: { x: display.width, y: 0 },
      bottomRight: { x: display.width, y: display.height },
      bottomLeft: { x: 0, y: display.height },
    });
  }

  useEffect(() => {
    function handlePointerMove(event: PointerEvent) {
      const corner = draggingCorner.current;
      const container = containerRef.current;
      if (!corner || !container || !displaySize) return;
      const rect = container.getBoundingClientRect();
      const x = Math.min(Math.max(event.clientX - rect.left, 0), displaySize.width);
      const y = Math.min(Math.max(event.clientY - rect.top, 0), displaySize.height);
      setCorners((prev) => (prev ? { ...prev, [corner]: { x, y } } : prev));
    }
    function handlePointerUp() {
      draggingCorner.current = null;
    }
    // Listen on window (not just the handle) so a fast drag that outruns
    // the small circular hit-target doesn't drop the drag -- the pointer
    // stays "captured" to this corner until pointerup fires anywhere.
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [displaySize]);

  async function handleConfirm() {
    if (!corners || !naturalSize || !displaySize || !imgRef.current) return;
    setIsProcessing(true);
    try {
      const scaleX = naturalSize.width / displaySize.width;
      const scaleY = naturalSize.height / displaySize.height;
      const naturalCorners = CORNER_ORDER.map((name) => ({
        x: corners[name].x * scaleX,
        y: corners[name].y * scaleY,
      })) as [Point, Point, Point, Point];

      const sourceCanvas = document.createElement("canvas");
      sourceCanvas.width = naturalSize.width;
      sourceCanvas.height = naturalSize.height;
      const sourceCtx = sourceCanvas.getContext("2d");
      if (!sourceCtx) return;
      sourceCtx.drawImage(imgRef.current, 0, 0);
      const sourceImageData = sourceCtx.getImageData(0, 0, naturalSize.width, naturalSize.height);

      const { width: outputWidth, height: outputHeight } = computeOutputDimensions(naturalCorners);
      const outputPixels = warpQuadrilateral(
        { width: sourceImageData.width, height: sourceImageData.height, data: sourceImageData.data },
        naturalCorners,
        outputWidth,
        outputHeight,
      );

      const outputCanvas = document.createElement("canvas");
      outputCanvas.width = outputWidth;
      outputCanvas.height = outputHeight;
      const outputCtx = outputCanvas.getContext("2d");
      if (!outputCtx) return;
      // Re-wrap in a fresh Uint8ClampedArray: PixelBuffer.data (from
      // perspectiveCrop.ts, a DOM-free module) is typed as the widened
      // Uint8ClampedArray<ArrayBufferLike>, but the ImageData constructor's
      // DOM typings require the narrower Uint8ClampedArray<ArrayBuffer> --
      // constructing a new one here satisfies that without loosening
      // perspectiveCrop.ts's intentionally DOM-independent types.
      outputCtx.putImageData(
        new ImageData(new Uint8ClampedArray(outputPixels.data), outputWidth, outputHeight),
        0,
        0,
      );
      onConfirm(outputCanvas.toDataURL("image/jpeg", 0.9));
    } finally {
      setIsProcessing(false);
    }
  }

  return (
    <div>
      <p className="mb-2 text-sm font-medium">Drag the corners to match the cover&apos;s edges</p>
      <div ref={containerRef} className="relative inline-block max-w-full touch-none">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={imgRef}
          src={imageDataUrl}
          alt="Captured cover"
          className="block max-w-full rounded"
          onLoad={handleImageLoad}
        />
        {corners && displaySize && (
          <svg
            className="absolute inset-0"
            width={displaySize.width}
            height={displaySize.height}
            viewBox={`0 0 ${displaySize.width} ${displaySize.height}`}
          >
            {/* evenodd between the full-canvas rect and the inner polygon
                dims everything OUTSIDE the traced quadrilateral, leaving
                the interior (what will actually be kept) undimmed. */}
            <path
              d={
                `M0,0 H${displaySize.width} V${displaySize.height} H0 Z ` +
                `M${corners.topLeft.x},${corners.topLeft.y} ` +
                `L${corners.topRight.x},${corners.topRight.y} ` +
                `L${corners.bottomRight.x},${corners.bottomRight.y} ` +
                `L${corners.bottomLeft.x},${corners.bottomLeft.y} Z`
              }
              fillRule="evenodd"
              fill="rgba(0,0,0,0.5)"
            />
            <polygon
              points={CORNER_ORDER.map((name) => `${corners[name].x},${corners[name].y}`).join(" ")}
              fill="none"
              stroke="white"
              strokeWidth={2}
            />
            {CORNER_ORDER.map((name) => (
              <circle
                key={name}
                cx={corners[name].x}
                cy={corners[name].y}
                r={12}
                fill="white"
                stroke="black"
                strokeWidth={2}
                style={{ pointerEvents: "auto", touchAction: "none", cursor: "move" }}
                onPointerDown={() => {
                  draggingCorner.current = name;
                }}
              />
            ))}
          </svg>
        )}
      </div>
      <div className="mt-2 flex gap-3">
        <button
          type="button"
          onClick={handleConfirm}
          disabled={isProcessing || !corners}
          className="flex-1 rounded bg-black p-2 text-white disabled:opacity-50"
        >
          {isProcessing ? "Processing..." : "Use this photo"}
        </button>
        <button type="button" onClick={onRetake} className="flex-1 rounded border border-black p-2">
          Retake
        </button>
      </div>
    </div>
  );
}
