"use client";

import { useActionState } from "react";
import { createBookWithCopy } from "@/lib/actions/books";
import type { BookFormState } from "@/lib/books";
import { CopyFormFields } from "@/components/CopyFormFields";
import { BookFormFields } from "@/components/BookFormFields";

const initialState: BookFormState = {};

export default function NewBookPage() {
  const [state, formAction, isPending] = useActionState(createBookWithCopy, initialState);

  return (
    <main className="mx-auto max-w-lg p-4">
      <h1 className="mb-4 text-2xl font-semibold">Add a Book</h1>
      <form action={formAction} className="space-y-4">
        <BookFormFields />

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
    </main>
  );
}
