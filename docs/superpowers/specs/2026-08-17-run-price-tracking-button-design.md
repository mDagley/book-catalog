# Manual "Run price check" Button — Design Spec

## Goal

A manual trigger on `/tbr` for the TBR price-tracking pipeline (matching, scraping, drop-digest email), so a user doesn't have to wait for the daily 06:00 cron job or run `scripts/run-price-tracking.ts` from a dev machine to see results after confirming new matches.

## Background

`docs/superpowers/plans/2026-08-16-tbr-price-tracking.md`'s Non-goals explicitly deferred this: "No manual 'search for matches now' or 'rescrape now' button in this pass... The existing `RecomputeOwnershipButton` precedent shows this project is comfortable adding manual triggers later if the daily cadence proves too slow in practice." That's exactly this request.

`RecomputeOwnershipButton` (`src/components/RecomputeOwnershipButton.tsx`) + `POST /api/tbr/recompute-ownership` (`src/app/api/tbr/recompute-ownership/route.ts`) is the established pattern for a slow, user-triggered `/tbr` action: a client component with `isRunning`/`error`/`summary` state, a `fetch` to a POST route, a check for `response.redirected` (expired session redirects to `/login`, which would otherwise get misparsed as JSON), and `router.refresh()` on success.

## Design

**API route:** `POST /api/tbr/run-price-tracking` (`src/app/api/tbr/run-price-tracking/route.ts`), mirroring the ownership route's shape exactly:

```typescript
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
      { success: false, error: error instanceof Error ? error.message : "Price tracking run failed" },
      { status: 500 },
    );
  }
}
```

No changes to `findRetailerMatches`/`scrapePrices`/`getPriceDrops`/`sendPriceDropDigest` themselves — they're already shipped, tested, and used identically by the cron job and the CLI script. This route is a fourth caller of the same functions, not a new code path.

**Component:** `RunPriceTrackingButton.tsx` (`src/components/RunPriceTrackingButton.tsx`), copying `RecomputeOwnershipButton`'s state machine and redirect-guard verbatim, with its own copy text and summary line: `"Checked prices — N drop(s) found."` (or `"Checked prices — no drops found."` when `dropCount === 0`).

**Placement:** `/tbr`, in the same button row as `RecomputeOwnershipButton`, immediately after it.

## Non-goals

- No progress indicator beyond the existing "Running..."-style disabled-button state (same as `RecomputeOwnershipButton`) — this can take a while (network calls per unconfirmed TBR item across two retailers), but a spinner-only "it's working" signal is enough, matching the existing button's own UX bar.
- No separate "match only" / "scrape only" buttons — one button runs the full pipeline, per the earlier design decision.
- No rate limiting or double-submit guard beyond the button's own `disabled={isRunning}` — same as the existing button, and low-risk for a single-user personal app.

## Testing

- API route: `src/app/api/tbr/recompute-ownership/route.ts` has no existing test file to mirror, so this route gets its own, following the pattern used elsewhere for API route tests in this repo (e.g. `src/app/api/autocomplete/route.test.ts`) — mock `@/lib/priceTracking` and `@/lib/emailDigest`, then confirm a successful run returns `{ success: true, dropCount }` with the right count, and a thrown error from any step returns `{ success: false, error }` with a 500.
- Component: a `renderToStaticMarkup` test confirming the button renders with the expected label.
