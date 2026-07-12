"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { createBookFromScan } from "@/lib/actions/books";
import type { BookFormState } from "@/lib/books";
import { BarcodeScanner } from "@/components/BarcodeScanner";
import { CoverPicker } from "@/components/CoverPicker";
import { CopyFormFields } from "@/components/CopyFormFields";

const initialState: BookFormState = {};

interface LookupData {
  title: string;
  author: string;
  publisher: string;
  publishYear: string;
  coverUrl: string | null;
}

export function ScanAddForm() {
  const [state, formAction, isPending] = useActionState(createBookFromScan, initialState);
  const [isbn, setIsbn] = useState<string | null>(null);
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const [lookup, setLookup] = useState<LookupData | null>(null);
  const [isLookingUp, setIsLookingUp] = useState(false);

  async function handleDecode(decodedIsbn: string, coverImageDataUrl: string) {
    setIsbn(decodedIsbn);
    setCapturedImage(coverImageDataUrl);
    setIsLookingUp(true);

    try {
      const response = await fetch(`/api/isbn-lookup?isbn=${encodeURIComponent(decodedIsbn)}`);
      const data = await response.json();
      setLookup({
        title: data.title ?? "",
        author: data.author ?? "",
        publisher: data.publisher ?? "",
        publishYear: data.publishYear?.toString() ?? "",
        coverUrl: data.coverUrl,
      });
    } catch {
      setLookup({ title: "", author: "", publisher: "", publishYear: "", coverUrl: null });
    } finally {
      setIsLookingUp(false);
    }
  }

  if (!isbn) {
    return (
      <div>
        <BarcodeScanner onDecode={handleDecode} />
        <Link href="/books/new" className="mt-4 inline-block text-sm underline">
          Enter manually instead
        </Link>
      </div>
    );
  }

  if (isLookingUp) {
    return <p>Looking up ISBN {isbn}...</p>;
  }

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="isbn" value={isbn} />
      <div>
        <label htmlFor="title" className="block text-sm font-medium">
          Title
        </label>
        <input
          id="title"
          name="title"
          required
          defaultValue={lookup?.title}
          className="mt-1 w-full rounded border p-2"
        />
      </div>
      <div>
        <label htmlFor="author" className="block text-sm font-medium">
          Author
        </label>
        <input
          id="author"
          name="author"
          defaultValue={lookup?.author}
          className="mt-1 w-full rounded border p-2"
        />
      </div>
      <CoverPicker
        capturedImageDataUrl={capturedImage}
        openLibraryCoverUrl={lookup?.coverUrl ?? null}
        onRetake={() => {
          setIsbn(null);
          setCapturedImage(null);
          setLookup(null);
        }}
      />
      <CopyFormFields defaultPublisher={lookup?.publisher} defaultPublishYear={lookup?.publishYear} />
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={isPending}
          className="flex-1 rounded bg-black p-2 text-white disabled:opacity-50"
        >
          {isPending ? "Saving..." : "Save"}
        </button>
        <button
          type="submit"
          name="scanAnother"
          value="true"
          disabled={isPending}
          className="flex-1 rounded border border-black p-2 disabled:opacity-50"
        >
          Save &amp; Scan Another
        </button>
      </div>
    </form>
  );
}
