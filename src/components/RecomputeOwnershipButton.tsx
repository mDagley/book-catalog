"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/Button";

export function RecomputeOwnershipButton() {
  const router = useRouter();
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);

  async function handleRecompute() {
    setIsRunning(true);
    setError(null);
    setSummary(null);

    try {
      const response = await fetch("/api/tbr/recompute-ownership", { method: "POST" });

      // An expired session makes middleware redirect this request to /login,
      // which returns the login page's HTML with a 200 status. fetch() follows
      // that redirect transparently, but response.redirected tells us it
      // happened -- check BEFORE calling .json(), since parsing HTML as JSON
      // would throw a SyntaxError the generic catch below would misreport as a
      // connectivity problem. Same guard as RefreshSyncButton.
      if (response.redirected) {
        setError("Your session has expired — please log in again.");
        return;
      }

      const data = await response.json();

      if (!data.success) {
        setError(data.error ?? "Ownership recompute failed.");
        return;
      }

      const changed = data.markedOwned + data.markedUnowned;
      setSummary(
        changed === 0
          ? `Checked ${data.total} items — everything was already correct.`
          : `Checked ${data.total} items — ${data.markedOwned} now owned, ${data.markedUnowned} no longer owned.`,
      );
      router.refresh();
    } catch {
      setError("Recompute failed — check your connection and try again.");
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <div>
      <Button type="button" variant="secondary" onClick={handleRecompute} disabled={isRunning}>
        {isRunning ? "Recomputing..." : "Recompute ownership"}
      </Button>
      {error && <p className="mt-1 text-sm text-red-600">{error}</p>}
      {summary && <p className="mt-1 text-sm text-foreground/70">{summary}</p>}
    </div>
  );
}
