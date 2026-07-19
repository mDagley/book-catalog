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
  // Guards the burst-capture loop (handleTakePhoto), which awaits a sleep()
  // between shots -- a ~600ms window in which the component could unmount
  // (e.g. the user navigates away mid-burst). Without this, the loop would
  // keep running and eventually call setState on an unmounted component.
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Tied to `step.kind` (not mount) so the stream's lifecycle matches the
  // preview screen's: leaving preview for picking/cropping stops the
  // camera (no point keeping it live -- and it stops battery/torch drain
  // during that window), and returning to preview via Retake re-acquires
  // a fresh stream and attaches it to the freshly-mounted <video> element
  // (the old one was unmounted, nulling videoRef.current, when we left
  // preview -- a one-time mount effect would never re-attach to it).
  useEffect(() => {
    if (step.kind !== "preview") return;

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
        setTorchOn(false);
      })
      .catch((err: Error) => {
        if (stopped) return;
        setError(err.message);
      });

    return () => {
      stopped = true;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
  }, [step.kind]);

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
      if (!isMountedRef.current) return;
    }
    if (!isMountedRef.current) return;
    setIsCapturingBurst(false);

    if (shots.length === 0) return;
    setStep({ kind: "picking", shots });
  }

  function handleRetake() {
    // Reset here (not in the stream-acquisition effect below) so the reset
    // is tied to the user action that re-enters preview, not to the effect
    // body -- calling setState synchronously in an effect body causes
    // cascading renders and is flagged by react-hooks/set-state-in-effect.
    // On initial mount isReady/error already hold these same default
    // values, so no reset is needed there.
    setIsReady(false);
    setError(null);
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
