"use client";

import { useEffect, useRef, useState } from "react";

interface CoverCameraProps {
  onCapture: (dataUrl: string) => void;
  onSkip?: () => void;
}

// Cap the captured cover image's longest side to keep the payload small — the
// app only ever displays covers at h-32 w-24 (roughly 128x96 CSS pixels), so
// this leaves generous headroom for retina displays without shipping a
// multi-MB full-resolution camera frame through the form.
const MAX_CAPTURE_DIMENSION = 800;

// A live camera preview with an explicit "Take Photo" step, used once a
// barcode has already been decoded so the user can reposition their phone
// at the book's front cover — separate from BarcodeScanner, which only ever
// sees whatever's in view at the moment of decode (usually the barcode
// itself, not the cover).
export function CoverCamera({ onCapture, onSkip }: CoverCameraProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Tracks whether the video actually has a frame to capture yet — a tap on
  // "Take Photo" before this (e.g. an eager tap right as the stream starts)
  // would otherwise read videoWidth/videoHeight as 0 and produce a blank or
  // invalid captured image.
  const [isReady, setIsReady] = useState(false);

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

  function handleCapture() {
    const video = videoRef.current;
    if (!video || !isReady) return;

    const { videoWidth, videoHeight } = video;
    if (videoWidth === 0 || videoHeight === 0) return;

    const scale = Math.min(1, MAX_CAPTURE_DIMENSION / Math.max(videoWidth, videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = videoWidth * scale;
    canvas.height = videoHeight * scale;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    onCapture(canvas.toDataURL("image/jpeg", 0.85));
  }

  return (
    <div>
      <p className="mb-2 text-sm font-medium">Take a photo of the cover</p>
      {error && (
        <p className="text-sm text-red-600">
          Camera error: {error}.{onSkip && " You can still skip this step."}
        </p>
      )}
      <video
        ref={videoRef}
        className="w-full rounded"
        muted
        playsInline
        autoPlay
        onLoadedMetadata={() => setIsReady(true)}
      />
      <div className="mt-2 flex gap-3">
        <button
          type="button"
          onClick={handleCapture}
          disabled={!!error || !isReady}
          className="flex-1 rounded bg-black p-2 text-white disabled:opacity-50"
        >
          Take Photo
        </button>
        {onSkip && (
          <button
            type="button"
            onClick={onSkip}
            className="flex-1 rounded border border-black p-2"
          >
            Skip
          </button>
        )}
      </div>
    </div>
  );
}
