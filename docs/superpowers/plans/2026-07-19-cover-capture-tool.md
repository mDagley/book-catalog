# Better Cover-Capture Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework `CoverCamera` into a 3-step flow — live preview with an optional flash/torch toggle, a burst-of-5-stills picker, and a free-form 4-corner perspective-corrected crop — with zero changes required to its two existing consumers (`ScanAddForm.tsx`, `CoverEditor.tsx`).

**Architecture:** One new pure math module (`src/lib/perspectiveCrop.ts`, unit-tested) computes the output rectangle's size from 4 traced corners and warps the source image into it via a homography (`perspective-transform` npm package) + a hand-written bilinear-sampling pixel loop. Two new presentational components (`BurstFramePicker.tsx`, `QuadCropEditor.tsx`) handle the picker and crop UI. `CoverCamera.tsx` is rewritten to own the camera stream, torch toggle, and burst capture, and to orchestrate the 3-step flow via a small discriminated-union state type — its external `onCapture`/`onSkip` props are unchanged.

**Tech Stack:** React 19 client components, Canvas 2D API, `perspective-transform` (new dependency, MIT, zero transitive deps), Vitest for the pure math module.

**Spec:** `docs/superpowers/specs/2026-07-19-cover-capture-tool-design.md` — approved 2026-07-19. Read it before starting; this plan implements it exactly.

---

### Task 1: `perspectiveCrop.ts` — pure homography/warp math

**Files:**
- Create: `src/lib/perspectiveCrop.ts`
- Create: `src/lib/perspectiveCrop.test.ts`
- Create: `src/types/perspective-transform.d.ts` (ambient module declaration — the package ships no TypeScript types)

- [ ] **Step 1: Install the dependency**

```bash
npm install perspective-transform
```

- [ ] **Step 2: Add the ambient type declaration**

```typescript
// src/types/perspective-transform.d.ts
declare module "perspective-transform" {
  interface PerspectiveTransform {
    transform(x: number, y: number): [number, number];
    transformInverse(x: number, y: number): [number, number];
    srcPts: number[];
    dstPts: number[];
    coeffs: number[];
    coeffsInv: number[];
  }

  function PerspT(srcCorners: number[], dstCorners: number[]): PerspectiveTransform;

  export = PerspT;
}
```

- [ ] **Step 3: Write the failing test file**

```typescript
// src/lib/perspectiveCrop.test.ts
import { describe, it, expect } from "vitest";
import { computeOutputDimensions, warpQuadrilateral, type Point, type PixelBuffer } from "./perspectiveCrop";

describe("computeOutputDimensions", () => {
  it("matches a perfect axis-aligned rectangle's width/height exactly", () => {
    const corners: [Point, Point, Point, Point] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 50 },
      { x: 0, y: 50 },
    ];
    expect(computeOutputDimensions(corners)).toEqual({ width: 100, height: 50 });
  });

  it("averages opposite edge lengths for a non-rectangular quadrilateral", () => {
    // Top edge 80 wide (horizontal), bottom edge 100 wide (horizontal) --
    // width should average to 90. Left edge is vertical (length exactly
    // 50); right edge is slanted (hypot(20, 50)) -- expected height below
    // is the average of those two, computed with the same Math.hypot the
    // implementation uses, then rounded, so this test doesn't depend on
    // hand-computing an irrational square root.
    const corners: [Point, Point, Point, Point] = [
      { x: 0, y: 0 },
      { x: 80, y: 0 },
      { x: 100, y: 50 },
      { x: 0, y: 50 },
    ];
    const expectedHeight = Math.round((50 + Math.hypot(20, 50)) / 2);
    expect(computeOutputDimensions(corners)).toEqual({ width: 90, height: expectedHeight });
  });
});

describe("warpQuadrilateral", () => {
  function makePixelBuffer(
    width: number,
    height: number,
    colorAt: (x: number, y: number) => [number, number, number, number],
  ): PixelBuffer {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const [r, g, b, a] = colorAt(x, y);
        const i = (y * width + x) * 4;
        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
        data[i + 3] = a;
      }
    }
    return { width, height, data };
  }

  function readPixel(buffer: PixelBuffer, x: number, y: number): [number, number, number, number] {
    const i = (y * buffer.width + x) * 4;
    return [buffer.data[i], buffer.data[i + 1], buffer.data[i + 2], buffer.data[i + 3]];
  }

  it("reproduces the source image when the traced quadrilateral is the whole image (identity transform)", () => {
    const width = 8;
    const height = 8;
    const source = makePixelBuffer(width, height, (x, y) => {
      const isRight = x >= width / 2;
      const isBottom = y >= height / 2;
      if (!isRight && !isBottom) return [255, 0, 0, 255];
      if (isRight && !isBottom) return [0, 255, 0, 255];
      if (!isRight && isBottom) return [0, 0, 255, 255];
      return [255, 255, 0, 255];
    });
    const corners: [Point, Point, Point, Point] = [
      { x: 0, y: 0 },
      { x: width, y: 0 },
      { x: width, y: height },
      { x: 0, y: height },
    ];

    const result = warpQuadrilateral(source, corners, width, height);

    // Sample well inside each quadrant (2+ pixels from any edge or the
    // quadrant boundary) so floating-point rounding in the homography's
    // inverse mapping can't blend across a color boundary, and use loose
    // thresholds rather than exact equality for the same reason.
    const [r1, g1, b1] = readPixel(result, 1, 1);
    expect(r1).toBeGreaterThan(200);
    expect(g1).toBeLessThan(30);
    expect(b1).toBeLessThan(30);

    const [r2, g2, b2] = readPixel(result, 6, 1);
    expect(g2).toBeGreaterThan(200);
    expect(r2).toBeLessThan(30);
    expect(b2).toBeLessThan(30);

    const [r3, g3, b3] = readPixel(result, 1, 6);
    expect(b3).toBeGreaterThan(200);
    expect(r3).toBeLessThan(30);
    expect(g3).toBeLessThan(30);

    const [r4, g4, b4] = readPixel(result, 6, 6);
    expect(r4).toBeGreaterThan(200);
    expect(g4).toBeGreaterThan(200);
    expect(b4).toBeLessThan(30);
  });

  it("crops a sub-rectangle of the source without distortion when the traced corners are axis-aligned", () => {
    // 4x4 source: left half red, right half green. Tracing just the
    // left-half sub-rectangle (columns 0-1) at 1:1 output size should
    // reproduce exactly that region, cropping out the green half entirely.
    const width = 4;
    const height = 4;
    const source = makePixelBuffer(width, height, (x) => (x < 2 ? [255, 0, 0, 255] : [0, 255, 0, 255]));
    const corners: [Point, Point, Point, Point] = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 4 },
      { x: 0, y: 4 },
    ];

    const result = warpQuadrilateral(source, corners, 2, 4);

    expect(result.width).toBe(2);
    expect(result.height).toBe(4);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 2; x++) {
        const [r, g] = readPixel(result, x, y);
        expect(r).toBeGreaterThan(200);
        expect(g).toBeLessThan(30);
      }
    }
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npm test -- src/lib/perspectiveCrop.test.ts`
Expected: FAIL — `perspectiveCrop.ts` doesn't exist yet (module not found).

- [ ] **Step 5: Write the implementation**

```typescript
// src/lib/perspectiveCrop.ts
import PerspT from "perspective-transform";

export interface Point {
  x: number;
  y: number;
}

// A structural stand-in for the browser's ImageData -- deliberately not
// using the real ImageData type/constructor here so this module has zero
// DOM dependency and can be unit-tested directly in Vitest's Node
// environment (which has no ImageData global). Callers convert to/from a
// real ImageData at the DOM boundary (see QuadCropEditor.tsx).
export interface PixelBuffer {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

// Given the 4 corners of a traced quadrilateral, in order [topLeft,
// topRight, bottomRight, bottomLeft], computes the output rectangle's
// dimensions as the average of each pair of opposite edges -- avoids
// arbitrarily stretching/squashing the result to match just one edge (a
// quad photographed at a slight angle has, e.g., a shorter top edge than
// bottom; averaging keeps the output an unbiased size rather than picking
// one side arbitrarily).
export function computeOutputDimensions(
  corners: [Point, Point, Point, Point],
): { width: number; height: number } {
  const [topLeft, topRight, bottomRight, bottomLeft] = corners;
  const dist = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);
  const topWidth = dist(topLeft, topRight);
  const bottomWidth = dist(bottomLeft, bottomRight);
  const leftHeight = dist(topLeft, bottomLeft);
  const rightHeight = dist(topRight, bottomRight);
  return {
    width: Math.max(1, Math.round((topWidth + bottomWidth) / 2)),
    height: Math.max(1, Math.round((leftHeight + rightHeight) / 2)),
  };
}

function cornersToFlatArray(corners: [Point, Point, Point, Point]): number[] {
  return corners.flatMap((p) => [p.x, p.y]);
}

// Bilinear-samples `source` at a (possibly fractional) coordinate.
// Coordinates outside the source bounds are CLAMPED to the nearest edge
// pixel rather than rejected -- this is standard edge-clamp sampling, and
// it also absorbs tiny floating-point overshoot from the homography's
// inverse mapping right at the image boundary (e.g. -1e-15 instead of an
// exact 0), which would otherwise be misread as genuinely out-of-bounds
// for a point that's mathematically ON the boundary.
function sampleBilinear(source: PixelBuffer, x: number, y: number): [number, number, number, number] {
  const { width, height, data } = source;
  const clampedX = Math.min(Math.max(x, 0), width - 1);
  const clampedY = Math.min(Math.max(y, 0), height - 1);
  const x0 = Math.floor(clampedX);
  const y0 = Math.floor(clampedY);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const fx = clampedX - x0;
  const fy = clampedY - y0;

  const at = (px: number, py: number, channel: number) => data[(py * width + px) * 4 + channel];

  const result: [number, number, number, number] = [0, 0, 0, 0];
  for (let channel = 0; channel < 4; channel++) {
    const top = at(x0, y0, channel) * (1 - fx) + at(x1, y0, channel) * fx;
    const bottom = at(x0, y1, channel) * (1 - fx) + at(x1, y1, channel) * fx;
    result[channel] = top * (1 - fy) + bottom * fy;
  }
  return result;
}

// Warps `source` so the quadrilateral traced by `corners` (in source pixel
// coordinates, order [topLeft, topRight, bottomRight, bottomLeft]) becomes
// a clean axis-aligned rectangle of the given output dimensions.
//
// Iterates OUTPUT pixels and inverse-maps each one back into source space
// (rather than iterating source pixels and forward-mapping them into the
// output) specifically to avoid holes: a forward mapping can leave some
// output pixels unwritten wherever the source-to-destination mapping is
// less than 1:1 dense. Inverse mapping guarantees every output pixel gets
// exactly one sampled value. Runs once per capture (not real-time), so an
// O(outputWidth * outputHeight) per-pixel loop in plain JS is fine.
export function warpQuadrilateral(
  source: PixelBuffer,
  corners: [Point, Point, Point, Point],
  outputWidth: number,
  outputHeight: number,
): PixelBuffer {
  const srcFlat = cornersToFlatArray(corners);
  const dstFlat = [0, 0, outputWidth, 0, outputWidth, outputHeight, 0, outputHeight];
  const perspT = PerspT(srcFlat, dstFlat);

  const data = new Uint8ClampedArray(outputWidth * outputHeight * 4);
  for (let y = 0; y < outputHeight; y++) {
    for (let x = 0; x < outputWidth; x++) {
      const [srcX, srcY] = perspT.transformInverse(x, y);
      const [r, g, b, a] = sampleBilinear(source, srcX, srcY);
      const i = (y * outputWidth + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return { width: outputWidth, height: outputHeight, data };
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm test -- src/lib/perspectiveCrop.test.ts`
Expected: PASS, all 4 tests green. If any numeric assertion is off by a small amount due to floating-point specifics not anticipated in this plan, adjust the threshold/expected value to match the actual (correct) computed result — don't weaken what the test is actually checking (e.g. don't loosen a color-channel threshold so much that it would also pass for the wrong color).

- [ ] **Step 7: Run the full suite and typecheck**

Run: `npm test && npx tsc --noEmit`
Expected: PASS, all existing tests plus the 4 new ones; no type errors.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json src/lib/perspectiveCrop.ts src/lib/perspectiveCrop.test.ts src/types/perspective-transform.d.ts
git commit -m "feat: add perspective-transform pure crop/warp math"
```

---

### Task 2: `BurstFramePicker.tsx`

**Files:**
- Create: `src/components/BurstFramePicker.tsx`

No automated test for this task — matches this codebase's established convention that interactive components (`CoverPicker`, `CoverEditor`, `BarcodeScanner`, the original `CoverCamera`) are verified via manual browser QA, not rendered-behavior tests. Verified in Task 5.

- [ ] **Step 1: Write the component**

```typescript
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
      <p className="mb-2 text-sm font-medium">Pick the clearest shot</p>
      <div className="flex gap-2 overflow-x-auto">
        {shots.map((shot, index) => (
          <button
            key={index}
            type="button"
            onClick={() => onPick(shot)}
            className="shrink-0 rounded border-2 border-transparent p-0.5 hover:border-black"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={shot} alt={`Shot ${index + 1}`} className="h-32 w-24 rounded object-cover" />
          </button>
        ))}
      </div>
      <button type="button" onClick={onRetake} className="mt-2 text-sm underline">
        Retake
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/BurstFramePicker.tsx
git commit -m "feat: add BurstFramePicker component"
```

---

### Task 3: `QuadCropEditor.tsx`

**Files:**
- Create: `src/components/QuadCropEditor.tsx`

No automated test for this task — same reasoning as Task 2. Verified in Task 5.

- [ ] **Step 1: Write the component**

```typescript
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
      outputCtx.putImageData(new ImageData(outputPixels.data, outputWidth, outputHeight), 0, 0);
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
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/QuadCropEditor.tsx
git commit -m "feat: add QuadCropEditor component"
```

---

### Task 4: Rewrite `CoverCamera.tsx`

**Files:**
- Modify: `src/components/CoverCamera.tsx` (full rewrite)

No automated test for this task — same reasoning as Tasks 2/3. Verified in Task 5. `ScanAddForm.tsx` and `CoverEditor.tsx` are NOT modified — both already consume `CoverCamera` only via `onCapture`/`onSkip`, which are unchanged.

- [ ] **Step 1: Rewrite the component**

```typescript
// src/components/CoverCamera.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { BurstFramePicker } from "@/components/BurstFramePicker";
import { QuadCropEditor } from "@/components/QuadCropEditor";

interface CoverCameraProps {
  onCapture: (dataUrl: string) => void;
  onSkip?: () => void;
}

// Cap the captured cover image's longest side to keep the payload small --
// the app only ever displays covers at h-32 w-24 (roughly 128x96 CSS
// pixels), so this leaves generous headroom for retina displays without
// shipping a multi-MB full-resolution camera frame through the form.
const MAX_CAPTURE_DIMENSION = 800;
const BURST_SHOT_COUNT = 5;
const BURST_INTERVAL_MS = 150;

// `torch` is a real, widely-supported non-standard MediaTrack extension
// (Android Chrome, etc.) that TypeScript's bundled DOM types don't include
// since it's not part of the official W3C MediaCapture spec surface.
declare global {
  interface MediaTrackCapabilities {
    torch?: boolean;
  }
  interface MediaTrackConstraintSet {
    torch?: boolean;
  }
}

type CaptureStep =
  | { kind: "preview" }
  | { kind: "picking"; shots: string[] }
  | { kind: "cropping"; shot: string };

function captureFrameFromVideo(video: HTMLVideoElement): string | null {
  const { videoWidth, videoHeight } = video;
  if (videoWidth === 0 || videoHeight === 0) return null;
  const scale = Math.min(1, MAX_CAPTURE_DIMENSION / Math.max(videoWidth, videoHeight));
  const canvas = document.createElement("canvas");
  canvas.width = videoWidth * scale;
  canvas.height = videoHeight * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.85);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A live camera preview with an explicit "Take Photo" step, used once a
// barcode has already been decoded so the user can reposition their phone
// at the book's front cover -- separate from BarcodeScanner, which only
// ever sees whatever's in view at the moment of decode (usually the
// barcode itself, not the cover). Take Photo captures a burst of stills
// (glare/blur is common in one-shot photos) and hands off to
// BurstFramePicker, then QuadCropEditor, before finally calling onCapture.
export function CoverCamera({ onCapture, onSkip }: CoverCameraProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Tracks whether the video actually has a frame to capture yet -- a tap
  // on "Take Photo" before this (e.g. an eager tap right as the stream
  // starts) would otherwise read videoWidth/videoHeight as 0 and produce a
  // blank or invalid captured image.
  const [isReady, setIsReady] = useState(false);
  const [isCapturingBurst, setIsCapturingBurst] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [step, setStep] = useState<CaptureStep>({ kind: "preview" });

  useEffect(() => {
    let stopped = false;

    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "environment" } })
      .then((stream) => {
        if (stopped) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
        const track = stream.getVideoTracks()[0];
        const capabilities = track.getCapabilities?.();
        setTorchSupported(Boolean(capabilities?.torch));
      })
      .catch((err: Error) => {
        if (stopped) return;
        setError(err.message);
      });

    return () => {
      stopped = true;
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  function toggleTorch() {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const next = !torchOn;
    track
      .applyConstraints({ advanced: [{ torch: next }] })
      .then(() => setTorchOn(next))
      .catch(() => {
        // Some devices report torch support in getCapabilities() but still
        // reject applyConstraints() at runtime (seen on a handful of
        // Android Chrome versions) -- fail silently rather than surface an
        // error for a non-essential toggle; the button just stays in its
        // prior on/off state.
      });
  }

  async function handleTakePhoto() {
    const video = videoRef.current;
    if (!video || !isReady || isCapturingBurst) return;

    setIsCapturingBurst(true);
    const shots: string[] = [];
    for (let i = 0; i < BURST_SHOT_COUNT; i++) {
      const shot = captureFrameFromVideo(video);
      if (shot) shots.push(shot);
      if (i < BURST_SHOT_COUNT - 1) {
        await sleep(BURST_INTERVAL_MS);
      }
    }
    setIsCapturingBurst(false);

    if (shots.length === 0) return;
    setStep({ kind: "picking", shots });
  }

  function handleRetake() {
    setStep({ kind: "preview" });
  }

  if (step.kind === "picking") {
    return (
      <BurstFramePicker
        shots={step.shots}
        onPick={(shot) => setStep({ kind: "cropping", shot })}
        onRetake={handleRetake}
      />
    );
  }

  if (step.kind === "cropping") {
    return <QuadCropEditor imageDataUrl={step.shot} onConfirm={onCapture} onRetake={handleRetake} />;
  }

  return (
    <div>
      <p className="mb-2 text-sm font-medium">Take a photo of the cover</p>
      {error && (
        <p className="text-sm text-red-600">
          Camera error: {error}.{onSkip && " You can still skip this step."}
        </p>
      )}
      <div className="relative">
        <video
          ref={videoRef}
          className="w-full rounded"
          muted
          playsInline
          autoPlay
          onLoadedMetadata={() => setIsReady(true)}
        />
        {torchSupported && (
          <button
            type="button"
            onClick={toggleTorch}
            aria-pressed={torchOn}
            className={`absolute right-2 top-2 rounded px-2 py-1 text-xs ${
              torchOn ? "bg-yellow-400 text-black" : "bg-black/60 text-white"
            }`}
          >
            {torchOn ? "Flash on" : "Flash off"}
          </button>
        )}
      </div>
      <div className="mt-2 flex gap-3">
        <button
          type="button"
          onClick={handleTakePhoto}
          disabled={!!error || !isReady || isCapturingBurst}
          className="flex-1 rounded bg-black p-2 text-white disabled:opacity-50"
        >
          {isCapturingBurst ? "Capturing..." : "Take Photo"}
        </button>
        {onSkip && (
          <button type="button" onClick={onSkip} className="flex-1 rounded border border-black p-2">
            Skip
          </button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Run the full suite and typecheck**

Run: `npm test && npx tsc --noEmit`
Expected: PASS, no regressions, no type errors (including in `ScanAddForm.tsx`/`CoverEditor.tsx`, which should compile unchanged since `CoverCamera`'s exported prop types didn't change).

- [ ] **Step 3: Run eslint**

Run: `npx eslint src/components/CoverCamera.tsx`
Expected: clean (aside from the same `no-img-element` disables already present elsewhere in this codebase, which don't apply here since this file has no `<img>`).

- [ ] **Step 4: Commit**

```bash
git add src/components/CoverCamera.tsx
git commit -m "feat: rework CoverCamera into burst-capture + quad-crop flow"
```

---

### Task 5: Integration verification and QA

- [ ] **Step 1: Run the full suite, typecheck, and lint one more time**

Run: `npm test && npx tsc --noEmit && npx eslint .`
Expected: all green, same counts as after Task 4 (no new files besides what Tasks 1-4 added).

- [ ] **Step 2: Automated browser verification (what's actually verifiable without real camera hardware)**

Camera access in an automated browser context typically has no real video device to capture from, so `getUserMedia` will either fail outright or (if the environment happens to have a fake/virtual camera device configured) produce a blank/test pattern feed. Attempt this via Playwright against a real `npm run dev` server (same session-cookie-minting approach as prior QA — read `SESSION_SECRET` from `.env`, mint an `iron-session` cookie, inject via the browser context's cookie API):

- Navigate to `/books/scan`, get past the barcode-scan step (manual ISBN entry is fine if barcode scanning isn't practical to automate), and reach the `CoverCamera` step.
- Confirm the component renders without crashing and shows either the live-preview UI or a clear camera-error message (both are acceptable outcomes in an environment with no real camera — what matters is it fails gracefully, not silently).
- If a usable video feed IS available (fake device or otherwise): tap "Take Photo", confirm it transitions to the `BurstFramePicker` step showing multiple thumbnails, tap one, confirm it transitions to `QuadCropEditor` showing the 4 draggable corner handles, drag a corner handle a noticeable distance (mouse drag simulates pointer events, so this works the same as touch), confirm the quadrilateral outline updates, tap "Use this photo", confirm it calls back into the parent flow (e.g. `ScanAddForm` shows the captured cover in `CoverPicker`).
- Also verify the `CoverEditor`-based path: navigate to an existing physical copy's edit page, tap "Take a photo", confirm the same `CoverCamera` flow launches inside the modal overlay as before.

If no real or fake camera device is available in this environment (a very likely outcome), report exactly what could and couldn't be verified — this is expected and acceptable; do not attempt to fake around it (e.g. don't monkey-patch `getUserMedia` in a way that produces misleading "it works" results). Report status `DONE_WITH_CONCERNS` in that case, not `DONE`, with the specific gap called out.

- [ ] **Step 3: Flag remaining real-device QA for the user**

Regardless of what Step 2 could verify, torch/flash behavior and the actual felt quality of touch-dragging the crop corners can only be meaningfully confirmed on a real phone with a real camera. Call this out explicitly in the final report as a follow-up for the user to do themselves on their own device (scan a real book, try the flash toggle in a dim room, try dragging the crop corners with a finger) before treating this feature as fully proven in the field — this is expected and normal for a camera feature, not a gap in the implementation work itself.

- [ ] **Step 4: Final commit if any fixes were needed during verification**

If Step 2 surfaces any real bugs (not just "couldn't test due to no camera hardware"), fix them and commit separately, following the same TDD/review discipline as the earlier tasks.
