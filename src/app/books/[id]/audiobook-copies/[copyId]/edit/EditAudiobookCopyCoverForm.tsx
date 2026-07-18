"use client";

import { useActionState, useState } from "react";
import { updateAudiobookCopyCover } from "@/lib/actions/audiobookCopies";
import type { CopyFormState } from "@/lib/copies";
import { CoverEditor } from "@/components/CoverEditor";

const initialState: CopyFormState = {};

interface EditAudiobookCopyCoverFormProps {
  copyId: string;
  bookId: string;
  currentCoverPath: string | null;
  bookIsbn: string | null;
}

export function EditAudiobookCopyCoverForm({
  copyId,
  bookId,
  currentCoverPath,
  bookIsbn,
}: EditAudiobookCopyCoverFormProps) {
  const updateThisCopy = updateAudiobookCopyCover.bind(null, copyId, bookId);
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
