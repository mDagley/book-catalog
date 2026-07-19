"use client";

import { useFormStatus } from "react-dom";

// Split out of page.tsx (a Server Component) so this one button can read
// pending state from its enclosing <form> via useFormStatus -- each group's
// form is independent, so only the clicked button shows "Merging...",
// not every button on the page. Without this, a merge click had zero
// visual feedback until the whole page re-rendered on success, which read
// as "the button doesn't do anything" even though the merge succeeded.
export function MergeButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="mt-1 rounded border px-2 py-1 text-xs hover:bg-gray-100 disabled:opacity-50"
    >
      {pending ? "Merging..." : "Keep this one, merge the others into it"}
    </button>
  );
}
