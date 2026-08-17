# Manual "Run price check" Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a manual "Run price check" button on `/tbr` that triggers the full price-tracking pipeline (match → scrape → digest) on demand, mirroring the existing `RecomputeOwnershipButton` pattern.

**Architecture:** One POST API route calling the already-shipped `findRetailerMatches`/`scrapePrices`/`getPriceDrops`/`sendPriceDropDigest` in sequence, plus one client button component copying `RecomputeOwnershipButton`'s state machine, wired into `/tbr` next to the existing button.

**Tech Stack:** Next.js route handlers, existing React client-component pattern — no new dependencies.

---

### Task 1: API route

**Files:**
- Create: `src/app/api/tbr/run-price-tracking/route.ts`
- Test: `src/app/api/tbr/run-price-tracking/route.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/app/api/tbr/run-price-tracking/route.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { POST } from "./route";
import { findRetailerMatches, scrapePrices, getPriceDrops } from "@/lib/priceTracking";
import { sendPriceDropDigest } from "@/lib/emailDigest";

vi.mock("@/lib/priceTracking", () => ({
  findRetailerMatches: vi.fn(),
  scrapePrices: vi.fn(),
  getPriceDrops: vi.fn(),
}));
vi.mock("@/lib/emailDigest", () => ({
  sendPriceDropDigest: vi.fn(),
}));

afterEach(() => {
  vi.resetAllMocks();
});

describe("POST /api/tbr/run-price-tracking", () => {
  it("runs the full pipeline and returns the drop count on success", async () => {
    vi.mocked(findRetailerMatches).mockResolvedValue(undefined);
    vi.mocked(scrapePrices).mockResolvedValue(undefined);
    vi.mocked(getPriceDrops).mockResolvedValue([
      { tbrItemId: "1", tbrItemTitle: "X", retailer: "librofm", previousPrice: 10, newPrice: 5 },
    ]);
    vi.mocked(sendPriceDropDigest).mockResolvedValue(undefined);

    const response = await POST();
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ success: true, dropCount: 1 });
    expect(findRetailerMatches).toHaveBeenCalled();
    expect(scrapePrices).toHaveBeenCalled();
    expect(sendPriceDropDigest).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ tbrItemId: "1" })]),
    );
  });

  it("returns dropCount 0 when there are no drops", async () => {
    vi.mocked(findRetailerMatches).mockResolvedValue(undefined);
    vi.mocked(scrapePrices).mockResolvedValue(undefined);
    vi.mocked(getPriceDrops).mockResolvedValue([]);
    vi.mocked(sendPriceDropDigest).mockResolvedValue(undefined);

    const response = await POST();
    const data = await response.json();

    expect(data).toEqual({ success: true, dropCount: 0 });
  });

  it("returns 500 with the error message when a step throws", async () => {
    vi.mocked(findRetailerMatches).mockRejectedValue(new Error("libro.fm unreachable"));

    const response = await POST();
    const data = await response.json();

    expect(response.status).toBe(500);
    expect(data).toEqual({ success: false, error: "libro.fm unreachable" });
    expect(scrapePrices).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/tbr/run-price-tracking/route.test.ts`
Expected: FAIL — `Cannot find module './route'`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/app/api/tbr/run-price-tracking/route.ts
import { NextResponse } from "next/server";
import { findRetailerMatches, scrapePrices, getPriceDrops } from "@/lib/priceTracking";
import { sendPriceDropDigest } from "@/lib/emailDigest";

// Manual "Run price check" trigger for /tbr -- runs the exact same three
// steps as the daily cron job in src/instrumentation.ts (and
// scripts/run-price-tracking.ts), on demand. Deliberately slow (a network
// call per unconfirmed TBR item across two retailers) and deliberately
// user-triggered, same tradeoff as the existing recompute-ownership route.
export async function POST() {
  try {
    await findRetailerMatches();
    await scrapePrices();
    const drops = await getPriceDrops();
    await sendPriceDropDigest(drops);
    return NextResponse.json({ success: true, dropCount: drops.length });
  } catch (error) {
    console.error("Manual price-tracking run failed:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Price tracking run failed",
      },
      { status: 500 },
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/api/tbr/run-price-tracking/route.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/app/api/tbr/run-price-tracking/route.ts src/app/api/tbr/run-price-tracking/route.test.ts
git commit -m "feat: add API route to manually run the price-tracking pipeline"
```

---

### Task 2: Button component

**Files:**
- Create: `src/components/RunPriceTrackingButton.tsx`
- Test: `src/components/RunPriceTrackingButton.test.tsx`

- [ ] **Step 1: Write the failing test**

```typescript
// src/components/RunPriceTrackingButton.test.tsx
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RunPriceTrackingButton } from "@/components/RunPriceTrackingButton";

describe("RunPriceTrackingButton", () => {
  it("renders a button labeled to run the price check", () => {
    const html = renderToStaticMarkup(<RunPriceTrackingButton />);
    expect(html).toContain("Run price check");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/RunPriceTrackingButton.test.tsx`
Expected: FAIL — `Cannot find module '@/components/RunPriceTrackingButton'`.

- [ ] **Step 3: Write the implementation**

Copies `src/components/RecomputeOwnershipButton.tsx`'s state machine (including the `response.redirected` expired-session guard) verbatim, pointed at the new route:

```typescript
// src/components/RunPriceTrackingButton.tsx
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/RunPriceTrackingButton.test.tsx`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/components/RunPriceTrackingButton.tsx src/components/RunPriceTrackingButton.test.tsx
git commit -m "feat: add RunPriceTrackingButton component"
```

---

### Task 3: Wire the button into `/tbr`

**Files:**
- Modify: `src/app/tbr/page.tsx`

- [ ] **Step 1: Add the import and render it next to `RecomputeOwnershipButton`**

In `src/app/tbr/page.tsx`:

```typescript
import { RunPriceTrackingButton } from "@/components/RunPriceTrackingButton";
```

```tsx
          <RecomputeOwnershipButton />
          <RunPriceTrackingButton />
```

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/app/tbr/page.tsx
git commit -m "feat: render RunPriceTrackingButton on /tbr"
```

---

### Task 4: Final verification

- [ ] **Step 1: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: no new errors (two pre-existing, unrelated issues in `CoverPicker.tsx`/`copies.ts` are expected).

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: build succeeds.
