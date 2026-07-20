"use client";

import { useActionState } from "react";
import { updateBook } from "@/lib/actions/books";
import type { BookFormState } from "@/lib/books";
import { BookFormFields } from "@/components/BookFormFields";
import { Button } from "@/components/ui/Button";

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
      <BookFormFields
        defaultTitle={defaultTitle}
        defaultAuthor={defaultAuthor}
        defaultIsbn={defaultIsbn}
      />
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      <Button type="submit" disabled={isPending} className="w-full">
        {isPending ? "Saving..." : "Save"}
      </Button>
    </form>
  );
}
