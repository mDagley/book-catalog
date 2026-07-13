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
      const [absResponse, goodreadsResponse] = await Promise.all([
        fetch("/api/sync/abs", { method: "POST" }),
        fetch("/api/sync/goodreads", { method: "POST" }),
      ]);
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
