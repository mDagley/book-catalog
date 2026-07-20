"use client";

import { useActionState, useState } from "react";
import { updateEbookCopyCover } from "@/lib/actions/ebookCopies";
import type { CopyFormState } from "@/lib/copies";
import { CoverEditor } from "@/components/CoverEditor";

const initialState: CopyFormState = {};

interface EditEbookCopyCoverFormProps {
  copyId: string;
  bookId: string;
  currentCoverPath: string | null;
  bookIsbn: string | null;
}

export function EditEbookCopyCoverForm({
  copyId,
  bookId,
  currentCoverPath,
  bookIsbn,
}: EditEbookCopyCoverFormProps) {
  const updateThisCopy = updateEbookCopyCover.bind(null, copyId, bookId);
  const [state, formAction, isPending] = useActionState(updateThisCopy, initialState);
  const [isPreparingCover, setIsPreparingCover] = useState(false);

  return (
    <form action={formAction} className="space-y-4">
      <CoverEditor
        currentCoverPath={currentCoverPath}
        bookIsbn={bookIsbn}
        onBusyChange={setIsPreparingCover}
      />
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      <button
        type="submit"
        disabled={isPending || isPreparingCover}
        className="w-full rounded bg-black p-2 text-white disabled:opacity-50"
      >
        {isPending ? "Saving..." : isPreparingCover ? "Preparing cover..." : "Save"}
      </button>
    </form>
  );
}
