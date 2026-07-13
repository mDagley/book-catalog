// src/components/BarcodeScanner.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { BrowserMultiFormatReader, NotFoundException } from "@zxing/library";

interface BarcodeScannerProps {
  onDecode: (isbn: string) => void;
}

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
            hasDecodedRef.current = true;
            reader.reset();
            onDecode(isbn);
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
