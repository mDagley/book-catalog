// src/components/BarcodeScanner.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { BrowserMultiFormatReader, NotFoundException, DecodeHintType, BarcodeFormat } from "@zxing/library";

interface BarcodeScannerProps {
  onDecode: (isbn: string) => void;
}

// Book ISBN barcodes are EAN-13 ("Bookland" barcodes, prefix 978/979).
// Restricted to just this format -- not also UPC-A/EAN-8 -- because
// everything downstream (/api/isbn-lookup, createBookWithCopyData's isbn
// normalization) only understands ISBN-10/13. A UPC-A or EAN-8 decode can
// never produce a valid ISBN, so allowing them here would only let a
// non-ISBN barcode masquerade as a scan result with no corresponding
// validation/conversion path to make it useful downstream. Without any
// restriction, BrowserMultiFormatReader tries every symbology it knows (QR,
// Code128, Aztec, PDF417, ...) on every frame -- in good light this rarely
// matters since a real ISBN barcode decodes cleanly well before anything
// else gets a look-in, but in poor lighting a degraded/noisy bar pattern is
// more likely to be misread as *some* unrelated format's valid checksum
// than to fail decoding outright, silently handing back garbage text.
// TRY_HARDER trades scan speed for accuracy (multiple binarization/rotation
// attempts), which is the right tradeoff here since a book is scanned once,
// not continuously.
const HINTS = new Map<DecodeHintType, unknown>([
  [DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.EAN_13]],
  [DecodeHintType.TRY_HARDER, true],
]);

export function BarcodeScanner({ onDecode }: BarcodeScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const hasDecodedRef = useRef(false);

  useEffect(() => {
    const reader = new BrowserMultiFormatReader(HINTS);
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
