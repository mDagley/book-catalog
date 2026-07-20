"use client";

import { useActionState, useState } from "react";
import { updateCopy } from "@/lib/actions/copies";
import type { CopyFormState } from "@/lib/copies";
import { CopyFormFields } from "@/components/CopyFormFields";
import { CoverEditor } from "@/components/CoverEditor";

const initialState: CopyFormState = {};

interface EditCopyFormProps {
  copyId: string;
  bookId: string;
  defaultFormat: string;
  defaultPublisher: string;
  defaultPublishYear: string;
  defaultSpecialNotes: string;
  currentCoverPath: string | null;
  bookIsbn: string | null;
}

export function EditCopyForm({
  copyId,
  bookId,
  defaultFormat,
  defaultPublisher,
  defaultPublishYear,
  defaultSpecialNotes,
  currentCoverPath,
  bookIsbn,
}: EditCopyFormProps) {
  const updateThisCopy = updateCopy.bind(null, copyId, bookId);
  const [state, formAction, isPending] = useActionState(updateThisCopy, initialState);
  const [isPreparingCover, setIsPreparingCover] = useState(false);

  return (
    <form action={formAction} className="space-y-4">
      <CopyFormFields
        idPrefix={copyId}
        defaultFormat={defaultFormat}
        defaultPublisher={defaultPublisher}
        defaultPublishYear={defaultPublishYear}
        defaultSpecialNotes={defaultSpecialNotes}
      />
      <CoverEditor
        currentCoverPath={currentCoverPath}
        bookIsbn={bookIsbn}
        allowCamera
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
