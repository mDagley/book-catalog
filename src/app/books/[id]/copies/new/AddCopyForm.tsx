"use client";

import { useActionState } from "react";
import { addCopy } from "@/lib/actions/copies";
import type { CopyFormState } from "@/lib/copies";
import { CopyFormFields } from "@/components/CopyFormFields";

const initialState: CopyFormState = {};

export function AddCopyForm({ bookId }: { bookId: string }) {
  const addCopyForBook = addCopy.bind(null, bookId);
  const [state, formAction, isPending] = useActionState(addCopyForBook, initialState);

  return (
    <form action={formAction} className="space-y-4">
      <CopyFormFields />
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      <button
        type="submit"
        disabled={isPending}
        className="w-full rounded bg-black p-2 text-white disabled:opacity-50"
      >
        {isPending ? "Saving..." : "Save"}
      </button>
    </form>
  );
}
