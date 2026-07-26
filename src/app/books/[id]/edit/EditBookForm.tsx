"use client";

import { useActionState } from "react";
import { updateBook, updateSeries } from "@/lib/actions/books";
import type { BookFormState } from "@/lib/books";
import { BookFormFields } from "@/components/BookFormFields";
import { Button } from "@/components/ui/Button";

const initialState: BookFormState = {};

// Mirrors the identical constant inside BookFormFields -- not exported from
// there (that component is shared with /books/new and shouldn't be
// restructured just to expose this string) so it's duplicated here for the
// series inputs to match the same look.
const fieldClass =
  "mt-1 w-full rounded-lg border border-perforation bg-background px-3 py-2 text-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent";

interface EditBookFormProps {
  bookId: string;
  defaultTitle: string;
  defaultAuthor: string;
  defaultIsbn: string;
  defaultSeriesName: string;
  defaultSeriesPosition: string;
}

export function EditBookForm({
  bookId,
  defaultTitle,
  defaultAuthor,
  defaultIsbn,
  defaultSeriesName,
  defaultSeriesPosition,
}: EditBookFormProps) {
  const updateBookWithId = updateBook.bind(null, bookId);
  const [state, formAction, isPending] = useActionState(updateBookWithId, initialState);

  const updateSeriesWithId = updateSeries.bind(null, bookId);
  const [seriesState, seriesAction, isSeriesPending] = useActionState(
    updateSeriesWithId,
    initialState,
  );

  return (
    <>
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

      <form action={seriesAction} className="mt-6 space-y-4">
        <h2 className="font-display text-lg font-medium text-foreground-strong">Series</h2>
        <div>
          <label htmlFor="seriesName" className="block text-sm font-medium text-foreground">
            Series name
          </label>
          <input
            id="seriesName"
            name="seriesName"
            defaultValue={defaultSeriesName}
            className={fieldClass}
          />
        </div>
        <div>
          <label htmlFor="seriesPosition" className="block text-sm font-medium text-foreground">
            Position in series
          </label>
          <input
            id="seriesPosition"
            name="seriesPosition"
            type="number"
            step="0.5"
            defaultValue={defaultSeriesPosition}
            className={fieldClass}
          />
        </div>
        {seriesState.error && <p className="text-sm text-red-600">{seriesState.error}</p>}
        <Button type="submit" disabled={isSeriesPending} className="w-full">
          {isSeriesPending ? "Saving..." : "Save series"}
        </Button>
      </form>
    </>
  );
}
