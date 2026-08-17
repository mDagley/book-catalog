"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/Button";

export function RunPriceTrackingButton() {
  const router = useRouter();
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);

  async function handleRun() {
    setIsRunning(true);
    setError(null);
    setSummary(null);

    try {
      const response = await fetch("/api/tbr/run-price-tracking", { method: "POST" });

      // An expired session makes middleware redirect this request to /login,
      // which returns the login page's HTML with a 200 status. fetch() follows
      // that redirect transparently, but response.redirected tells us it
      // happened -- check BEFORE calling .json(), since parsing HTML as JSON
      // would throw a SyntaxError the generic catch below would misreport as a
      // connectivity problem. Same guard as RecomputeOwnershipButton.
      if (response.redirected) {
        setError("Your session has expired — please log in again.");
        return;
      }

      const data = await response.json();

      if (!data.success) {
        setError(data.error ?? "Price check failed.");
        return;
      }

      setSummary(
        data.dropCount === 0
          ? "Checked prices — no drops found."
          : `Checked prices — ${data.dropCount} drop${data.dropCount === 1 ? "" : "s"} found.`,
      );
      router.refresh();
    } catch {
      setError("Price check failed — check your connection and try again.");
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <div>
      <Button type="button" variant="secondary" onClick={handleRun} disabled={isRunning}>
        {isRunning ? "Checking prices..." : "Run price check"}
      </Button>
      {error && <p className="mt-1 text-sm text-red-600">{error}</p>}
      {summary && <p className="mt-1 text-sm text-foreground/70">{summary}</p>}
    </div>
  );
}
