# Pending-Match Filter — Design Spec

## Goal

A way to filter `/tbr` down to only items that have at least one unconfirmed retailer match waiting for a decision, so a user can quickly find and process the confirm/reject queue without scanning the whole (potentially large) TBR list.

## Design

- New URL query param on `/tbr`: `pending=1`. Bookmarkable/shareable, consistent with the existing `q` search param.
- A toggle link next to "Switch to grid/list view" and "Recompute ownership": `"Show pending matches only"` / `"Show all items"`, following the exact `<Link>` pattern already used for the letter jump-nav and "Back to search" (a plain navigational link, not a form -- this is a read-only view filter, not a mutation, so it doesn't need a server action).
- Filtering happens in the page component after `getTbrGap(query)` returns, before `groupByInitial`: keep an item only if `item.retailerMatches.some((m) => !m.confirmed)` -- `retailerMatches` already excludes rejected matches (per the earlier "persist rejected matches" fix), so any remaining `confirmed: false` entry is a genuine pending decision.
- Combines with the existing `q` search filter (both apply; an item must match the search query AND have a pending match, if both are active).

## Non-goals

- No change to `getTbrGap`/`tbrGap.ts` -- this is presentation-level filtering on data already being fetched, not a new query shape.
- No persisted preference (e.g. a cookie) -- URL param only, matching how `q` already works.

## Testing

- A route/page-level check isn't practical without a request harness for this page (no existing test file for `/tbr`'s page component), so this is verified manually in a browser: an item with a pending match shows when the filter is on; an item with only confirmed/no matches doesn't; both filters (`q` + `pending`) combine correctly.
