// src/components/QuadCropEditor.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import {
  capDimensions,
  computeOutputDimensions,
  warpQuadrilateral,
  type Point,
} from "@/lib/perspectiveCrop";

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
  // Mirrors displaySize so the ResizeObserver callback below (registered
  // once on mount) can read the latest value without needing to
  // tear down and recreate the observer every time displaySize changes.
  const displaySizeRef = useRef<{ width: number; height: number } | null>(null);
  useEffect(() => {
    displaySizeRef.current = displaySize;
  }, [displaySize]);

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
    function handlePointerEnd() {
      draggingCorner.current = null;
    }
    // Listen on window (not just the handle) so a fast drag that outruns
    // the small circular hit-target doesn't drop the drag -- the pointer
    // stays "captured" to this corner until pointerup fires anywhere.
    // pointercancel is also handled -- on mobile a drag can be interrupted
    // by an OS-level gesture (e.g. a browser-chrome swipe) without ever
    // firing pointerup, which would otherwise leave draggingCorner stuck
    // and make the next unrelated pointermove keep dragging that corner.
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerEnd);
    window.addEventListener("pointercancel", handlePointerEnd);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerEnd);
      window.removeEventListener("pointercancel", handlePointerEnd);
    };
  }, [displaySize]);

  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;
    // Recomputes displaySize on any layout change to the image (viewport
    // resize, device rotation, etc.) and rescales the traced corners
    // proportionally so the crop selection stays visually aligned with
    // the image instead of drifting out of sync with what's on screen.
    const observer = new ResizeObserver(() => {
      const newDisplay = { width: img.clientWidth, height: img.clientHeight };
      const prevDisplay = displaySizeRef.current;
      if (!prevDisplay || newDisplay.width === 0 || newDisplay.height === 0) return;
      if (newDisplay.width === prevDisplay.width && newDisplay.height === prevDisplay.height) return;
      const scaleX = newDisplay.width / prevDisplay.width;
      const scaleY = newDisplay.height / prevDisplay.height;
      setCorners((prev) =>
        prev
          ? (Object.fromEntries(
              CORNER_ORDER.map((name) => [
                name,
                { x: prev[name].x * scaleX, y: prev[name].y * scaleY },
              ]),
            ) as Record<CornerName, Point>)
          : prev,
      );
      setDisplaySize(newDisplay);
    });
    observer.observe(img);
    return () => observer.disconnect();
  }, []);

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

      // computeOutputDimensions derives its result from the traced
      // quadrilateral's edge lengths, which can exceed the source image's
      // own MAX_CAPTURE_DIMENSION cap (e.g. dragging a corner toward the
      // diagonally-opposite one traces an edge approaching the image's
      // diagonal) -- cap again here so the perspective-corrected output
      // never balloons past the size the rest of the app (coverStorage.ts)
      // assumes captured covers are capped to.
      const { width: rawOutputWidth, height: rawOutputHeight } =
        computeOutputDimensions(naturalCorners);
      const { width: outputWidth, height: outputHeight } = capDimensions(
        rawOutputWidth,
        rawOutputHeight,
      );
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
              <g key={name}>
                {/* Larger invisible hit area -- the visible handle below is small
                    enough not to clutter the traced outline, but real fingertip
                    contact is roughly 40-50px, so the actual tappable area needs
                    to be bigger than what's drawn (r=22 gives a ~44px diameter,
                    matching Apple HIG / Material Design touch-target guidance). */}
                <circle
                  cx={corners[name].x}
                  cy={corners[name].y}
                  r={22}
                  fill="transparent"
                  style={{ pointerEvents: "auto", touchAction: "none", cursor: "move" }}
                  onPointerDown={() => {
                    draggingCorner.current = name;
                  }}
                />
                <circle
                  cx={corners[name].x}
                  cy={corners[name].y}
                  r={12}
                  fill="white"
                  stroke="black"
                  strokeWidth={2}
                  style={{ pointerEvents: "none" }}
                />
              </g>
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
