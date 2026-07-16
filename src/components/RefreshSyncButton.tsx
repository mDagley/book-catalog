"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function RefreshSyncButton() {
  const router = useRouter();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRefresh() {
    setIsRefreshing(true);
    setError(null);

    try {
      // Sequential, not Promise.all -- running both syncs concurrently
      // starves the production VPS's small connection pool badly enough to
      // fail one sync's transaction outright (Prisma P2028), since both
      // syncs make many sequential DB round-trips. See instrumentation.ts's
      // matching cron-stagger fix for the same underlying contention.
      const absResponse = await fetch("/api/sync/abs", { method: "POST" });
      const goodreadsResponse = await fetch("/api/sync/goodreads", { method: "POST" });

      // An expired session makes middleware redirect these requests to
      // /login, which returns the login page's HTML with a 200 status.
      // fetch() follows that redirect transparently, but response.redirected
      // tells us it happened — check this BEFORE calling .json(), since
      // parsing the HTML body as JSON would throw a SyntaxError that the
      // generic catch block below would misreport as a connectivity issue.
      if (absResponse.redirected || goodreadsResponse.redirected) {
        setError("Your session has expired — please log in again.");
        return;
      }

      const absData = await absResponse.json();
      const goodreadsData = await goodreadsResponse.json();

      const errors: string[] = [];
      if (!absData.success) errors.push(`ABS: ${absData.error}`);
      if (!goodreadsData.success) errors.push(`Goodreads: ${goodreadsData.error}`);

      if (errors.length > 0) {
        setError(errors.join("; "));
      }
      if (absData.success || goodreadsData.success) {
        router.refresh();
      }
    } catch {
      setError("Refresh failed — check your connection and try again.");
    } finally {
      setIsRefreshing(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={handleRefresh}
        disabled={isRefreshing}
        className="rounded border border-black px-3 py-2 text-sm disabled:opacity-50"
      >
        {isRefreshing ? "Refreshing..." : "Refresh now"}
      </button>
      {error && <p className="mt-1 text-sm text-red-600">{error}</p>}
    </div>
  );
}
