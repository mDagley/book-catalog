"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/Button";
import { runSync } from "@/lib/syncResponse";

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
      //
      // runSync() never throws and reads non-JSON replies (proxy timeout
      // pages, crash pages) as specific errors -- see syncResponse.ts.
      const abs = await runSync("/api/sync/abs");

      // Checked after the first request so an expired session
      // short-circuits before firing the second one -- it would just
      // redirect too.
      if (abs.kind === "sessionExpired") {
        setError("Your session has expired — please log in again.");
        return;
      }

      const goodreads = await runSync("/api/sync/goodreads");
      if (goodreads.kind === "sessionExpired") {
        setError("Your session has expired — please log in again.");
        return;
      }

      const errors: string[] = [];
      if (abs.kind === "failed") errors.push(`ABS: ${abs.message}`);
      if (goodreads.kind === "failed") errors.push(`Goodreads: ${goodreads.message}`);

      if (errors.length > 0) {
        setError(errors.join("; "));
      }
      if (abs.kind === "ok" || goodreads.kind === "ok") {
        router.refresh();
      }
    } finally {
      setIsRefreshing(false);
    }
  }

  return (
    <div>
      <Button type="button" variant="secondary" onClick={handleRefresh} disabled={isRefreshing}>
        {isRefreshing ? "Refreshing..." : "Refresh now"}
      </Button>
      {error && <p className="mt-1 text-sm text-red-600">{error}</p>}
    </div>
  );
}
