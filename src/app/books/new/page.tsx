"use client";

import { useActionState } from "react";
import { createBookWithCopy } from "@/lib/actions/books";
import type { BookFormState } from "@/lib/books";
import { CopyFormFields } from "@/components/CopyFormFields";

const initialState: BookFormState = {};

export default function NewBookPage() {
  const [state, formAction, isPending] = useActionState(createBookWithCopy, initialState);

  return (
    <main className="mx-auto max-w-lg p-4">
      <h1 className="mb-4 text-2xl font-semibold">Add a Book</h1>
      <form action={formAction} className="space-y-4">
        <div>
          <label htmlFor="title" className="block text-sm font-medium">
            Title
          </label>
          <input id="title" name="title" required className="mt-1 w-full rounded border p-2" />
        </div>
        <div>
          <label htmlFor="author" className="block text-sm font-medium">
            Author
          </label>
          <input id="author" name="author" className="mt-1 w-full rounded border p-2" />
        </div>
        <div>
          <label htmlFor="isbn" className="block text-sm font-medium">
            ISBN
          </label>
          <input id="isbn" name="isbn" className="mt-1 w-full rounded border p-2" />
        </div>

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
