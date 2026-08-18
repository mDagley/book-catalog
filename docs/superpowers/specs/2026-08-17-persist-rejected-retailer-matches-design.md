# Persist Rejected Retailer Matches — Design Spec

## Goal

A rejected retailer match must never be re-suggested for that TBR item/retailer pair again.

## Background

`rejectRetailerMatch` currently `DELETE`s the `RetailerMatch` row outright. `findRetailerMatches` skips a (TBR item, retailer) pair only if a `RetailerMatch` row already exists for it — so deleting on reject makes the pair look "never matched," and the next run re-searches and re-suggests the exact match the user just rejected. This was the original, deliberate design (`docs/superpowers/plans/2026-08-16-tbr-price-tracking.md`): "a genuinely wrong match could resolve correctly later." That reasoning stops holding once matching can be triggered on demand (`RunPriceTrackingButton`) rather than only once a day — a user re-running the check immediately sees the same rejected match again, which reads as broken, not as "waiting for the listing to improve."

## Design

- `RetailerMatch` gains `rejected Boolean @default(false)`.
- `rejectRetailerMatch` sets `rejected: true` AND `confirmed: false` (not just `rejected: true`) instead of deleting the row. The `confirmed: false` half matters because Reject is reachable on a match that a user had previously confirmed (and which may already have price observations, from before it was rejected) — without clearing `confirmed`, the row would end up both `confirmed: true` and `rejected: true`, and `scrapePrices`/`getPriceDrops` filter on `confirmed` alone, so it would keep being scraped and could still trigger a drop alert despite being "rejected."
- `confirmRetailerMatch` is guarded symmetrically: it only updates a row where `rejected: false` (via `updateMany`, a silent no-op when the row doesn't match rather than throwing), so a stale UI or tampered request can't resurrect an already-rejected match back into `confirmed: true && rejected: true`.
- `findRetailerMatches`'s existing "skip if this item already has a `RetailerMatch` row for this retailer" check needs no change — a rejected row still counts as "already has one," so it's never re-created. This is the core of the fix; everything else follows from it.
- `getTbrGap`'s `retailerMatches` select gains `where: { rejected: false }` on the relation, so a rejected match is invisible to the UI — no confirm/reject prompt (it's already been decided), no price badge, regardless of whether it happens to have historical price observations from before it was rejected.
- `scrapePrices`/`getPriceDrops` need no code change: both already filter `confirmed: true`, and the two guards above now make "rejected implies not confirmed" hold unconditionally at the data layer, not just as an artifact of which UI states expose Reject.

## Non-goals

- No cooldown/expiry on a rejection (explicitly decided: reject is permanent, matching this project's stated preference for persisted computed state over TTL/staleness machinery).
- No UI to view or un-reject a previously-rejected match — out of scope for this fix; can be added later if it turns out to be needed.

## Testing

- `retailerMatch.test.ts`: `rejectRetailerMatch` now sets `rejected: true` and the row still exists (was: row deleted).
- `priceTracking.test.ts`: `findRetailerMatches` does not re-create a match for a (item, retailer) pair whose existing row has `rejected: true`.
- `tbrGap.test.ts`: `getTbrGap` excludes a rejected match from `retailerMatches` entirely.
