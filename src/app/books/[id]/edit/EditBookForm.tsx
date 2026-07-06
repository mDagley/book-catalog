"use client";

import { useActionState } from "react";
import { updateBook } from "@/lib/actions/books";
import type { BookFormState } from "@/lib/books";

const initialState: BookFormState = {};

interface EditBookFormProps {
  bookId: string;
  defaultTitle: string;
  defaultAuthor: string;
  defaultIsbn: string;
}

export function EditBookForm({
  bookId,
  defaultTitle,
  defaultAuthor,
  defaultIsbn,
}: EditBookFormProps) {
  const updateBookWithId = updateBook.bind(null, bookId);
  const [state, formAction, isPending] = useActionState(updateBookWithId, initialState);

  return (
    <form action={formAction} className="space-y-4">
      <div>
        <label htmlFor="title" className="block text-sm font-medium">
          Title
        </label>
        <input
          id="title"
          name="title"
          required
          defaultValue={defaultTitle}
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
          defaultValue={defaultAuthor}
          className="mt-1 w-full rounded border p-2"
        />
      </div>
      <div>
        <label htmlFor="isbn" className="block text-sm font-medium">
          ISBN
        </label>
        <input
          id="isbn"
          name="isbn"
          defaultValue={defaultIsbn}
          className="mt-1 w-full rounded border p-2"
        />
      </div>
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
