# Persist Rejected Retailer Matches — Design Spec

## Goal

A rejected retailer match must never be re-suggested for that TBR item/retailer pair again.

## Background

`rejectRetailerMatch` currently `DELETE`s the `RetailerMatch` row outright. `findRetailerMatches` skips a (TBR item, retailer) pair only if a `RetailerMatch` row already exists for it — so deleting on reject makes the pair look "never matched," and the next run re-searches and re-suggests the exact match the user just rejected. This was the original, deliberate design (`docs/superpowers/plans/2026-08-16-tbr-price-tracking.md`): "a genuinely wrong match could resolve correctly later." That reasoning stops holding once matching can be triggered on demand (`RunPriceTrackingButton`) rather than only once a day — a user re-running the check immediately sees the same rejected match again, which reads as broken, not as "waiting for the listing to improve."

## Design

- `RetailerMatch` gains `rejected Boolean @default(false)`.
- `rejectRetailerMatch` sets `rejected: true` instead of deleting the row. `confirmRetailerMatch` is unchanged (still just sets `confirmed: true`; a confirm can only ever apply to a row that hasn't been rejected, since a rejected row is filtered out of the UI entirely — see below).
- `findRetailerMatches`'s existing "skip if this item already has a `RetailerMatch` row for this retailer" check needs no change — a rejected row still counts as "already has one," so it's never re-created. This is the entire fix; everything downstream follows from it.
- `getTbrGap`'s `retailerMatches` select gains `where: { rejected: false }` on the relation, so a rejected match is invisible to the UI — no confirm/reject prompt (it's already been decided), no price badge (it was never confirmed, so it was never scraped either).
- `scrapePrices`/`getPriceDrops` need no change: both already filter `confirmed: true`, and a rejected row is never confirmed.

## Non-goals

- No cooldown/expiry on a rejection (explicitly decided: reject is permanent, matching this project's stated preference for persisted computed state over TTL/staleness machinery).
- No UI to view or un-reject a previously-rejected match — out of scope for this fix; can be added later if it turns out to be needed.

## Testing

- `retailerMatch.test.ts`: `rejectRetailerMatch` now sets `rejected: true` and the row still exists (was: row deleted).
- `priceTracking.test.ts`: `findRetailerMatches` does not re-create a match for a (item, retailer) pair whose existing row has `rejected: true`.
- `tbrGap.test.ts`: `getTbrGap` excludes a rejected match from `retailerMatches` entirely.
