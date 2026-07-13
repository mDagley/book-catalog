"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { createBookFromScan, type ScanFormState } from "@/lib/actions/books";
import { BarcodeScanner } from "@/components/BarcodeScanner";
import { CoverCamera } from "@/components/CoverCamera";
import { CoverPicker } from "@/components/CoverPicker";
import { CopyFormFields } from "@/components/CopyFormFields";

const initialState: ScanFormState = {};

interface LookupData {
  title: string;
  author: string;
  publisher: string;
  publishYear: string;
  coverUrl: string | null;
}

interface ScanBookFormProps {
  isbn: string;
  capturedImage: string | null;
  lookup: LookupData | null;
  onRetake: () => void;
}

// Rendered with `key={isbn}` by ScanAddForm so that a fresh scan fully
// remounts this component, resetting its useActionState state — otherwise a
// stale error from a previous failed submission would persist across
// rescans. A failed submission on the SAME isbn does not remount this
// component; `state.values` (returned by the action on error) covers that
// case by re-supplying whatever was last submitted as each field's
// defaultValue.
function ScanBookForm({ isbn, capturedImage, lookup, onRetake }: ScanBookFormProps) {
  const [state, formAction, isPending] = useActionState(createBookFromScan, initialState);

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
          defaultValue={state.values?.title ?? lookup?.title}
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
          defaultValue={state.values?.author ?? lookup?.author}
          className="mt-1 w-full rounded border p-2"
        />
      </div>
      <CoverPicker
        capturedImageDataUrl={capturedImage}
        openLibraryCoverUrl={lookup?.coverUrl ?? null}
        onRetake={onRetake}
      />
      {/*
        Keyed by the resolved values so a failed submission remounts these
        fields with the just-submitted values as their fresh defaults.
        This isn't just belt-and-suspenders: React's <select> caches its
        *first-ever* mount-time default and silently re-applies that cached
        value on every later render, ignoring a subsequently-updated
        defaultFormat prop — plain <input>/<textarea> don't have this
        quirk, but without remounting, the format dropdown would reset to
        blank after every failed save regardless of what defaultFormat says.
      */}
      <CopyFormFields
        key={JSON.stringify(state.values)}
        defaultFormat={state.values?.format}
        defaultPublisher={state.values?.publisher ?? lookup?.publisher}
        defaultPublishYear={state.values?.publishYear ?? lookup?.publishYear}
        defaultSpecialNotes={state.values?.specialNotes}
      />
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

export function ScanAddForm() {
  const [isbn, setIsbn] = useState<string | null>(null);
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const [showCamera, setShowCamera] = useState(true);
  const [lookup, setLookup] = useState<LookupData | null>(null);
  const [isLookingUp, setIsLookingUp] = useState(false);

  async function handleDecode(decodedIsbn: string) {
    setIsbn(decodedIsbn);
    setCapturedImage(null);
    setShowCamera(true);
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
    <div className="relative">
      <ScanBookForm
        key={isbn}
        isbn={isbn}
        capturedImage={capturedImage}
        lookup={lookup}
        onRetake={() => setShowCamera(true)}
      />
      {/*
        Rendered as an overlay (not swapped in for the form) so that
        "Retake photo"/"Add a photo" — reopening this — never unmounts
        ScanBookForm. If it did, any in-progress edits to title/format/etc.
        the user had already typed (uncontrolled inputs, not yet submitted)
        would be lost when the form remounted with only the original lookup
        defaults.

        onRetake deliberately does NOT clear capturedImage up front: it's
        only replaced if CoverCamera's onCapture actually fires with a new
        photo below. Clearing it eagerly would lose an already-good photo
        if the user opens this overlay and then hits Skip instead of taking
        a new one.
      */}
      {showCamera && (
        <div className="fixed inset-0 z-10 overflow-y-auto bg-white p-4">
          <CoverCamera
            onCapture={(dataUrl) => {
              setCapturedImage(dataUrl);
              setShowCamera(false);
            }}
            onSkip={() => setShowCamera(false)}
          />
        </div>
      )}
    </div>
  );
}
