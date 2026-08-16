# TBR Price Tracking — Design Spec

## Goal

Surface price drops on TBR gap items (`/tbr`) for libro.fm and Google Play Books — the user's preferred, DRM-free purchase sources — without recompute-on-read: prices are fetched on a daily schedule and persisted, matching this project's data-freshness model.

## Background

libro.fm publishes no deals/sales API, so its price comes from scraping the book's own product page — with the reliability trade-offs that implies (page structure can change, requests can be blocked, a "sale" is inferred from price history rather than an explicit flag the retailer provides). Google Play Books' search results page is not reliably scrapable (prices are embedded only in obfuscated JS array literals, not stable HTML/CSS), so that retailer is matched and priced via the Google Books API instead. Both paths land in the same `RetailerMatch`/`PriceObservation` model below.

`GoodreadsTbrItem` (`prisma/schema.prisma`) is the existing source for `/tbr`, surfaced via `getTbrGap`/`groupByInitial` (`src/lib/tbrGap.ts`). This feature adds retailer matching and price history on top of that model without changing it.

## Data model

Two new tables:

```prisma
model RetailerMatch {
  id            String   @id @default(cuid())
  tbrItemId     String
  tbrItem       GoodreadsTbrItem @relation(fields: [tbrItemId], references: [id])
  retailer      String   // "librofm" | "googleplay"
  productUrl    String
  matchedTitle  String   // title/author found at match time, shown in the confirm prompt
  matchedAuthor String?
  confirmed     Boolean  @default(false)
  createdAt     DateTime @default(now())
  observations  PriceObservation[]

  @@unique([tbrItemId, retailer])
}

model PriceObservation {
  id              String   @id @default(cuid())
  retailerMatchId String
  retailerMatch   RetailerMatch @relation(fields: [retailerMatchId], references: [id])
  price           Float
  observedAt      DateTime @default(now())
}
```

`price` is `Float`, not `Decimal` — matching this schema's existing precedent for non-integer numeric fields (`Book.seriesPosition`). This feature only ever compares two prices for "did it go down"; `Decimal`'s exact-cents precision isn't worth the added `Prisma.Decimal` handling it would impose on every read site.

- `@@unique([tbrItemId, retailer])` — at most one match per (item, retailer) pair; re-running the matcher against an item that already has a match (confirmed or not) is a no-op, not a duplicate row.
- `PriceObservation` is append-only. Price history and "did it drop" both fall out of querying the newest two rows per match — no separate "last known price" field to keep in sync, and no schema change needed if the alerting logic ever needs more than a two-point comparison later.
- `retailer` is a plain string, not an enum — matches this schema's existing convention of stringly-typed source fields (nothing in the current schema uses a Prisma enum).

## Retailer matching + confirmation

New module `src/lib/priceTracking.ts`, structured like `absSync.ts`/`goodreadsSync.ts`, delegating to a per-retailer adapter (`src/lib/retailers/librofm.ts`, `src/lib/retailers/googleplay.ts`) behind a shared `RetailerAdapter` interface.

`findRetailerMatches()`:
- For every `GoodreadsTbrItem` with `owned: false` that does not yet have a `RetailerMatch` row for a given retailer, search that retailer by title + author.
  - **libro.fm:** fetch the search results page with `fetch()` and parse it with `cheerio`.
  - **Google Play Books:** query the Google Books API (optionally authenticated via `GOOGLE_BOOKS_API_KEY` for a higher quota) rather than scraping the search page — that page's results are embedded only in obfuscated JS, not stable HTML/CSS.
- Take the top result and write an unconfirmed `RetailerMatch` (`confirmed: false`), storing the matched title/author so the confirm prompt can show what was actually found.
- No automatic promotion to `confirmed` — every match needs one manual confirm, regardless of how exact the title match looks. This is a deliberate floor: a wrong silent match would fetch and alert on the wrong book's price indefinitely.

Confirmation UI lives on `/tbr` itself (see UI section) via two new server actions, `confirmRetailerMatch(matchId)` and `rejectRetailerMatch(matchId)` (mirroring `setViewMode`'s existing bind-and-submit shape). Reject deletes the `RetailerMatch` row outright — `findRetailerMatches()` will attempt that (item, retailer) pair again on its next run, since the unique constraint no longer blocks it.

## Price scraping

`scrapePrices()`:
- For every `RetailerMatch` where `confirmed: true`, fetch the current price via that retailer's adapter — `productUrl` + fetch/cheerio for libro.fm, the Google Books API for Google Play Books.
- Insert one `PriceObservation` row per successful fetch. A failure (network error, price not found — page structure or API response likely changed) is caught, logged with the retailer and `productUrl`, and skipped; it does not insert a row and does not stop the rest of the batch.
- Only confirmed matches are priced — this bounds daily request volume to books the user has actually vetted, not the full TBR list, and means an unconfirmed match sitting unreviewed costs nothing beyond the one-time matching request.

`getPriceDrops(): Promise<PriceDrop[]>`:
- For each confirmed `RetailerMatch` with at least two `PriceObservation` rows, compares the newest against the previous one.
- Returns items where the newest price is strictly lower, with enough detail to render both the `/tbr` badge and the alert email (TBR item id/title, retailer, previous price, new price).
- An item with zero or one observation is never a drop — the first scrape only establishes a baseline, it cannot flag on day one.

## Scheduling

A new `cron.schedule` job in `src/instrumentation.ts`, separate from the existing 30-minute ABS/Goodreads/owned-physical job, running once daily (`0 6 * * *`) with `{ noOverlap: true }`:

```
findRetailerMatches() → scrapePrices() → getPriceDrops() → email digest if non-empty
```

Kept separate from the existing job (rather than added to it) so a slow or failing scrape run can't delay or block the ABS/Goodreads syncs, and vice versa — same reasoning that already justifies `{ noOverlap: true }` on the existing job, applied across jobs instead of within one.

Each step is individually try/caught and logged, matching the existing job's per-source error handling — a Google Play Books scrape failure doesn't prevent libro.fm scraping or the email step from running.

## Alerting

New env vars: `RESEND_API_KEY`, `PRICE_ALERT_EMAIL`. Missing either skips the email step with a logged warning — same pattern as `ABS_URL`/`ABS_TOKEN` being unset today — never a crash.

If `getPriceDrops()` returns any items, one digest email is sent via the Resend API (not one email per drop), listing each dropped item's title, retailer, previous price, and new price. No retry on send failure — it's caught and logged, and the next day's run will naturally re-include the drop if the price is still down (see below).

**Dedup is implicit, not tracked separately.** A drop is only "new" on the run where it's detected (newest observation < previous observation). If the price stays at the new, lower value, the next day's comparison is `same < same` — false — so it does not re-appear in the next digest. It only reappears if the price moves again. No `alertedAt` field or send-log table is needed for this.

## UI — `/tbr`

Both grid (`CoverGridCard`) and list (`TicketCard`) rendering on `/tbr` gain a per-retailer line for each `RetailerMatch` on that item:

- **Unconfirmed match:** `Confirm match: "{matchedTitle}" on {retailer}? [Confirm] [Reject]` — two small forms bound to `confirmRetailerMatch`/`rejectRetailerMatch`, following the existing `form action={...bind(...)}` pattern used by `setViewMode` and `RecomputeOwnershipButton`.
- **Confirmed match, no drop:** a small price badge, e.g. `libro.fm: $14.99`.
- **Confirmed match, drop detected:** the badge is styled distinctly (e.g. a red/accent "↓" prefix) — `↓ libro.fm: $9.99 (was $14.99)`.
- **No match yet for a retailer:** nothing is shown for that retailer; `findRetailerMatches()` will pick it up on its next daily run. No manual "search now" trigger — see Non-goals.

## Non-goals

- **No headless browser / JS rendering.** libro.fm uses plain `fetch()` + `cheerio` HTML parsing; Google Play Books uses the Google Books API rather than scraping. If libro.fm's pages turn out to need JS rendering for price, that adapter simply fails every run (caught, logged, no observation inserted) until addressed as a follow-up — not a silent wrong price.
- **No retry/backoff beyond "try again tomorrow."** A failed scrape or match just waits for the next daily cron run.
- **No automatic match confirmation**, however exact the title match looks — every `RetailerMatch` requires one manual confirm before it's ever scraped.
- **No manual "search for matches now" or "rescrape now" button** in this pass — matching and scraping are cron-only. (The existing `RecomputeOwnershipButton` precedent shows this project is comfortable adding manual triggers later if the daily cadence proves too slow in practice.)
- **No per-drop alert history / "mark as seen"** — the email digest is the only record of a drop; `PriceObservation` rows are the durable history if needed later.
- **No price tracking for `owned: true` TBR items** — matching only runs against `owned: false` items, consistent with `/tbr` itself only listing the gap.
- **No retailers beyond libro.fm and Google Play Books** in this pass.

## Testing

- `findRetailerMatches`: given TBR items with no existing match, creates one unconfirmed `RetailerMatch` per (item, retailer); given an item that already has a match for a retailer, does not create a second one (unique constraint respected); a scrape/parse failure for one item doesn't stop matching for the rest of the batch.
- `scrapePrices`: only scrapes `confirmed: true` matches; inserts one `PriceObservation` per successful scrape; a parse failure is caught, logged, and inserts no row, without stopping the rest of the batch.
- `getPriceDrops`: returns nothing for a match with 0 or 1 observations; returns the item when newest < previous; returns nothing when newest >= previous; correctly handles multiple confirmed matches on the same TBR item (e.g. a drop on libro.fm but not Google Play Books for the same book).
- `confirmRetailerMatch` / `rejectRetailerMatch`: confirm sets `confirmed: true`; reject deletes the row and a subsequent `findRetailerMatches()` run re-matches that (item, retailer) pair.
- Email digest: sent when `getPriceDrops()` is non-empty, skipped (logged) when empty or when `RESEND_API_KEY`/`PRICE_ALERT_EMAIL` is unset; send failure is caught and doesn't throw.
- `/tbr` rendering: unconfirmed match shows the confirm/reject prompt with the matched title; confirmed match with no drop shows a plain price badge; confirmed match with a drop shows the distinct drop styling with both prices; an item with no match for a retailer shows nothing for that retailer.
