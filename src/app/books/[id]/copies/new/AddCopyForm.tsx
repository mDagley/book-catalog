"use client";

import { useActionState } from "react";
import { addCopy } from "@/lib/actions/copies";
import type { CopyFormState } from "@/lib/copies";
import { CopyFormFields } from "@/components/CopyFormFields";
import { Button } from "@/components/ui/Button";

const initialState: CopyFormState = {};

export function AddCopyForm({ bookId }: { bookId: string }) {
  const addCopyForBook = addCopy.bind(null, bookId);
  const [state, formAction, isPending] = useActionState(addCopyForBook, initialState);

  return (
    <form action={formAction} className="space-y-4">
      <CopyFormFields />
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      <Button type="submit" disabled={isPending} className="w-full">
        {isPending ? "Saving..." : "Save"}
      </Button>
    </form>
  );
}
