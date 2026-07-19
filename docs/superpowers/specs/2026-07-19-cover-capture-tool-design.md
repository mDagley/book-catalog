# Better Cover-Capture Tool — Design

## Overview

`CoverCamera` (`src/components/CoverCamera.tsx`) is the shared camera-capture component used both when adding a new book (`ScanAddForm.tsx`) and when editing an existing physical copy's cover (`CoverEditor.tsx`, camera option). Today it's a single "tap to take one photo" flow with no cropping and no flash control, so a bad angle, glare, or dim lighting means retaking the whole shot with no way to fix it after capture.

This phase reworks the capture flow into three steps — live preview (with an optional flash/torch toggle), a burst-of-stills picker, and a 4-corner perspective-corrected crop — while keeping `CoverCamera`'s external contract (`onCapture(dataUrl)` / `onSkip()`) identical, so neither of its two call sites needs any changes.

## Section 1: Overall flow

`CoverCamera` becomes a 3-step state machine:

1. **Live preview** — camera feed (unchanged from today), plus a flash/torch toggle button shown only when the device/browser supports it. Tapping "Take Photo" triggers a burst capture (there is no separate single-shot mode — burst replaces it entirely).
2. **Frame picker** (`BurstFramePicker.tsx`) — a horizontal strip of thumbnails from the burst; tapping one selects it and advances to crop. A "Retake" action discards the burst and returns to step 1.
3. **Crop** (`QuadCropEditor.tsx`) — the selected still shown full-size with 4 independently draggable corner handles, initialized at the image's actual corners (no correction applied until a handle is dragged). "Use this photo" computes a perspective-corrected rectangle from the traced quadrilateral and calls `onCapture(dataUrl)`. "Retake" discards everything and returns to step 1.

## Section 2: Flash/torch toggle

- After the camera stream starts, feature-detect torch support on the active video track: `track.getCapabilities?.().torch`. Torch support is inconsistent across browsers/devices (works on most Android Chrome, not supported on iOS Safari as of today) — the toggle button simply doesn't render when unsupported, rather than showing a button that would silently fail.
- When supported, a toggle button near the preview calls `track.applyConstraints({ advanced: [{ torch: true/false }] })` and reflects on/off state visually.
- No special cleanup beyond what already happens when the stream is torn down on unmount (torch state doesn't need to be explicitly reset — stopping the track handles it).

## Section 3: Burst capture

- Tapping "Take Photo" captures 5 stills at ~150ms apart (~0.75s total), drawing the current video frame to a canvas on each tick — same downscaling (`MAX_CAPTURE_DIMENSION = 800`) and JPEG encoding (`toDataURL("image/jpeg", 0.85)`) already used today, just repeated 5 times.
- The "Take Photo" button shows a brief disabled/busy state during the burst so a second tap can't overlap it.
- No automatic frame-quality scoring (blur/glare detection) — the user picks visually from the thumbnail strip. Automated quality scoring would be a much bigger, less reliable feature than what was actually asked for.

## Section 4: Quadrilateral crop + perspective correction

- The selected frame is shown with 4 independently draggable corner handles (one finger/pointer at a time — no simultaneous multi-corner dragging), initialized to the image's actual corners.
- Dragging a handle updates the quadrilateral outline live; the area outside it is dimmed.
- "Use this photo":
  1. Computes the output rectangle's dimensions from the quadrilateral — width/height each derived from the average of the two opposite-edge lengths (standard approach that avoids arbitrarily stretching or squashing the result), capped by the existing `MAX_CAPTURE_DIMENSION` logic.
  2. Computes a homography mapping the 4 traced corners to that output rectangle's 4 corners, via the `perspective-transform` npm package (`PerspT(srcCorners, dstCorners)`).
  3. Warps the source image into the output rectangle with a hand-written canvas pixel-sampling loop: for each output pixel, inverse-map through the homography to find its source coordinate, bilinear-sample the source `ImageData` there, write the result. Runs once per capture (not real-time), so performance is not a concern even without WebGL.
  4. Encodes the result as a JPEG data URL and calls `onCapture(dataUrl)`.
- "Retake" discards everything, returns to step 1.

**Dependency note:** `perspective-transform` (npm) hasn't been updated in ~10 years, but is small, has no transitive dependencies, and does one narrow, well-defined math operation (homography from 4 point-pairs) with no open issues — "unmaintained" here means "stable, nothing left to fix," not "abandoned and broken." Accepted as a reasonable dependency for this scope.

## Section 5: File structure

- `src/lib/perspectiveCrop.ts` (new) — pure functions, no DOM/camera dependency:
  - Computing the output rectangle's width/height from 4 corner points.
  - Warping a source `ImageData` into an output `ImageData` given the 4 source corners and the computed output dimensions (homography + bilinear-sampling pixel loop described above).
- `src/components/CoverCamera.tsx` (rewritten) — owns the camera stream, torch toggle, and the 3-step state machine; renders the live preview step directly and delegates to the two new components for the other steps.
- `src/components/BurstFramePicker.tsx` (new) — thumbnail strip + retake action.
- `src/components/QuadCropEditor.tsx` (new) — 4-corner drag UI; calls into `perspectiveCrop.ts` on confirm; retake action.

`ScanAddForm.tsx` and `CoverEditor.tsx` require no changes — both consume `CoverCamera` only via its existing `onCapture`/`onSkip` props.

## Non-goals

- No automatic blur/glare detection or "best frame" auto-selection — the user picks visually.
- No fixed aspect ratio on the crop — fully free-form quadrilateral, per the user's explicit choice.
- No simultaneous multi-corner dragging.
- No changes to `ScanAddForm.tsx` or `CoverEditor.tsx`.
- No true video recording/frame-scrubbing (considered and explicitly rejected in favor of burst-of-stills, which avoids browser video-seeking quirks, especially on mobile Safari).

## Testing

- `src/lib/perspectiveCrop.test.ts` (new): real Vitest unit tests against the pure math/pixel-warping functions — an identity case (4 corners already forming a perfect rectangle should reproduce the input unchanged), a known simple skew (specific input corners should land specific pixels at predictable output coordinates, checked directly against `ImageData` values), and output-dimension calculation from various quadrilateral shapes.
- `CoverCamera.tsx` / `BurstFramePicker.tsx` / `QuadCropEditor.tsx`: no automated rendered-behavior tests, consistent with every other interactive component in this codebase (`CoverPicker`, `CoverEditor`, `BarcodeScanner`, the original `CoverCamera`) — verified via manual browser QA instead, on both the new-book scan flow and the existing-copy edit flow, on a real device with a real camera (not just Playwright/desktop, since torch support and touch-drag interaction can't be meaningfully verified without real mobile hardware).
