// src/components/BarcodeScanner.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { BrowserMultiFormatReader, NotFoundException } from "@zxing/library";

interface BarcodeScannerProps {
  onDecode: (isbn: string, coverImageDataUrl: string) => void;
}

// Cap the captured cover image's longest side to keep the payload small — the
// app only ever displays covers at h-32 w-24 (roughly 128x96 CSS pixels), so
// this leaves generous headroom for retina displays without shipping a
// multi-MB full-resolution camera frame through the form.
const MAX_CAPTURE_DIMENSION = 800;

export function BarcodeScanner({ onDecode }: BarcodeScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const hasDecodedRef = useRef(false);

  useEffect(() => {
    const reader = new BrowserMultiFormatReader();
    let stopped = false;

    reader
      .decodeFromConstraints(
        { video: { facingMode: "environment" } },
        videoRef.current!,
        (result, err) => {
          if (stopped || hasDecodedRef.current) return;
          if (result) {
            const isbn = result.getText();
            const video = videoRef.current;
            if (!video) return;

            const { videoWidth, videoHeight } = video;
            const scale = Math.min(1, MAX_CAPTURE_DIMENSION / Math.max(videoWidth, videoHeight));
            const canvas = document.createElement("canvas");
            canvas.width = videoWidth * scale;
            canvas.height = videoHeight * scale;
            const ctx = canvas.getContext("2d");
            if (!ctx) return;
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const dataUrl = canvas.toDataURL("image/jpeg", 0.85);

            hasDecodedRef.current = true;
            reader.reset();
            onDecode(isbn, dataUrl);
          } else if (err && !(err instanceof NotFoundException)) {
            setError(err.message);
          }
        },
      )
      .catch((err: Error) => {
        setError(err.message);
      });

    return () => {
      stopped = true;
      reader.reset();
    };
  }, [onDecode]);

  return (
    <div>
      {error && (
        <p className="text-sm text-red-600">
          Camera error: {error}. Try &quot;enter manually&quot; below instead.
        </p>
      )}
      <video ref={videoRef} className="w-full rounded" muted playsInline />
    </div>
  );
}
