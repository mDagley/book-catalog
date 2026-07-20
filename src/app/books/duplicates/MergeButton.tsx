"use client";

import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/Button";

// Split out of page.tsx (a Server Component) so this one button can read
// pending state from its enclosing <form> via useFormStatus -- each group's
// form is independent, so only the clicked button shows "Merging...",
// not every button on the page. Without this, a merge click had zero
// visual feedback until the whole page re-rendered on success, which read
// as "the button doesn't do anything" even though the merge succeeded.
export function MergeButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="secondary" disabled={pending} className="mt-1">
      {pending ? "Merging..." : "Keep this one, merge the others into it"}
    </Button>
  );
}
