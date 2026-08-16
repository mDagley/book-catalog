# TBR Price Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Match TBR gap items to their libro.fm and Google Play Books listings, scrape/fetch price daily, flag price drops on `/tbr`, and email a digest when a drop is detected.

**Architecture:** Two retailer adapters behind one interface (`search`/`fetchPrice`) — libro.fm via `fetch()` + `cheerio` HTML parsing (it has no API), Google Play Books via the official free Google Books API (JSON, no scraping, no gated developer approval — a strictly better fit than scraping `play.google.com` directly, which is a JS-hydrated SPA with no stable server-rendered markup on its search page). A new daily cron job runs matching → scraping → drop detection → email digest, wired alongside the existing 30-minute sync job in `instrumentation.ts`. `/tbr` gains a per-retailer confirm/reject prompt or price badge on each item.

**Tech Stack:** Next.js/Prisma/Postgres (existing), `cheerio` (new dependency, libro.fm HTML parsing only), Resend's REST API via plain `fetch()` (no SDK dependency added).

---

## Research notes (verified live during planning, 2026-08-16)

- **libro.fm search** (`https://libro.fm/search?q=<query>`): server-rendered. Each result is `.book-grid-item` containing `a.book[href="/audiobooks/{isbn}-{slug}"]`, with `.book-info .title` and `.book-info .author` holding the text. Confirmed against a real search for "the way of kings".
- **libro.fm product page** (`https://libro.fm{href}`): contains a `<script type="application/ld+json">` block with `offers.highPrice` — the plain (non-membership) purchase price in USD, e.g. `"52.49"`. Confirmed against `/audiobooks/9781427209764-the-way-of-kings`. (`offers.lowPrice` is the membership-credit price — out of scope, this feature only tracks the plain purchase price.)
- **Google Play Books search page** is NOT reliably scrapable: titles/prices are present only inside large obfuscated `AF_initDataKeys`/batchexecute JS array literals, not stable HTML/CSS. Confirmed by fetching a real search results page.
- **Google Books API** (`https://www.googleapis.com/books/v1/volumes`) is the correct source instead: a free, public, unauthenticated-capable JSON API (an API key raises the daily quota but isn't required to function). A `volumes.list` query returns `saleInfo.saleability`, `saleInfo.retailPrice.amount`, and `saleInfo.buyLink` (a `https://play.google.com/store/books/details?id=...` URL) directly — no separate scrape needed for price. The `id` query param on `buyLink` is the same ID usable with `GET /books/v1/volumes/{id}` to re-fetch a specific book later without re-searching.

## File structure

- `prisma/schema.prisma` — add `RetailerMatch`, `PriceObservation` models + relation on `GoodreadsTbrItem`.
- `src/lib/retailers/types.ts` — shared `RetailerAdapter`/`RetailerMatchResult` interface.
- `src/lib/retailers/librofm.ts` — libro.fm adapter (search via cheerio, price via JSON-LD).
- `src/lib/retailers/googleplay.ts` — Google Play Books adapter (search + price via Google Books API).
- `src/lib/priceTracking.ts` — `findRetailerMatches`, `scrapePrices`, `getPriceDrops`, orchestration.
- `src/lib/emailDigest.ts` — `sendPriceDropDigest` via Resend REST API.
- `src/lib/actions/retailerMatch.ts` — `confirmRetailerMatch`/`rejectRetailerMatch` server actions.
- `src/components/RetailerPriceBadge.tsx` — confirm/reject prompt or price badge, used by both grid and list views on `/tbr`.
- `src/instrumentation.ts` — modify: add the daily cron job.
- `src/lib/tbrGap.ts` — modify: `TbrGapItem` gains `retailerMatches`.
- `src/app/tbr/page.tsx` — modify: render `RetailerPriceBadge` per item.
- `.env.example` — modify: document new env vars.

---

### Task 1: Add dependencies and env vars

**Files:**
- Modify: `package.json`
- Modify: `.env.example`

- [ ] **Step 1: Install cheerio**

Run: `npm install cheerio`

Expected: `package.json` gains `"cheerio": "^..."` under `dependencies`.

- [ ] **Step 2: Document new env vars**

Add to `.env.example`, after the existing `GOODREADS_USER_ID` line:

```
# Google Books API key (optional -- raises the free daily quota; the API
# works unauthenticated at a lower quota without it). Used to match/price
# TBR items against Google Play Books.
GOOGLE_BOOKS_API_KEY=""

# Resend API key and destination address for the daily TBR price-drop digest
# email. Leave either unset to skip sending (a warning is logged instead).
RESEND_API_KEY=""
PRICE_ALERT_EMAIL=""
```

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json .env.example
git commit -m "chore: add cheerio dependency and price-tracking env vars"
```

---

### Task 2: Prisma schema — RetailerMatch and PriceObservation

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Add the models**

In `prisma/schema.prisma`, add `retailerMatches RetailerMatch[]` to `GoodreadsTbrItem`:

```prisma
model GoodreadsTbrItem {
  id                      String    @id @default(cuid())
  title                   String
  author                  String?
  isbn                    String?
  coverImagePath          String?
  coverCheckedAt          DateTime?
  coverFetchFailureReason String?
  lastSyncedAt            DateTime  @default(now())
  owned                   Boolean   @default(false)
  retailerMatches         RetailerMatch[]
}
```

Then add two new models at the end of the file:

```prisma
model RetailerMatch {
  id            String   @id @default(cuid())
  tbrItemId     String
  tbrItem       GoodreadsTbrItem   @relation(fields: [tbrItemId], references: [id])
  retailer      String // "librofm" | "googleplay"
  productUrl    String
  matchedTitle  String
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
  // Float, not Decimal, matching this schema's existing precedent for
  // non-integer numeric fields (Book.seriesPosition) -- this feature only
  // ever compares two prices for "did it go down", so Decimal's exact-cents
  // precision isn't worth the added Prisma.Decimal handling it would impose
  // on every read site.
  price      Float
  observedAt DateTime @default(now())
}
```

- [ ] **Step 2: Generate and run the migration**

Run: `npx prisma migrate dev --name add_retailer_price_tracking`

Expected: a new folder under `prisma/migrations/` named `<timestamp>_add_retailer_price_tracking`, containing `migration.sql` with `CREATE TABLE "RetailerMatch"`, `CREATE TABLE "PriceObservation"`, and the relevant foreign keys/unique index. Command exits 0.

- [ ] **Step 3: Apply the same migration to the test database**

Matches this repo's own documented pattern (`README.md`, test-DB setup section) for applying a migration to `bookcatalog_test` without touching `.env`'s dev `DATABASE_URL`:

Run: `DATABASE_URL="postgresql://bookcatalog:bookcatalog_dev@localhost:5432/bookcatalog_test" npx prisma migrate deploy`

(Substitute the actual test-DB URL from `.env.test` if it differs from the default shown here.)

Expected: `1 migration found ... applied`.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat: add RetailerMatch and PriceObservation models"
```

---

### Task 3: Retailer adapter interface

**Files:**
- Create: `src/lib/retailers/types.ts`

- [ ] **Step 1: Write the shared types (no test needed — pure type declarations)**

```typescript
// src/lib/retailers/types.ts
export type RetailerId = "librofm" | "googleplay";

export interface RetailerMatchResult {
  matchedTitle: string;
  matchedAuthor: string | null;
  productUrl: string;
}

export interface RetailerAdapter {
  id: RetailerId;
  // Returns the best-guess product match for a title/author, or null if
  // nothing was found. Never throws for "no results" -- only for a genuine
  // network/parse failure, which callers catch per-item (see priceTracking.ts).
  search(title: string, author: string | null): Promise<RetailerMatchResult | null>;
  // Re-fetches the current price for an already-matched product. Returns
  // null if the price couldn't be determined (page changed, item delisted).
  fetchPrice(productUrl: string): Promise<number | null>;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/retailers/types.ts
git commit -m "feat: add RetailerAdapter interface"
```

---

### Task 4: libro.fm adapter

**Files:**
- Create: `src/lib/retailers/librofm.ts`
- Test: `src/lib/retailers/librofm.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/retailers/librofm.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { librofmAdapter } from "@/lib/retailers/librofm";

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

const SEARCH_RESULTS_HTML = `
<div class="book-grid-item">
  <a class="book" href="/audiobooks/9781427209764-the-way-of-kings">
    <div class="book-info">
      <div class="title">The Way of Kings</div>
      <div class="author">Brandon Sanderson</div>
    </div>
  </a>
</div>
<div class="book-grid-item">
  <a class="book" href="/audiobooks/9781545920435-the-way-of-kings-devotional">
    <div class="book-info">
      <div class="title">The Way of Kings (Devotional)</div>
      <div class="author">Someone Else</div>
    </div>
  </a>
</div>
`;

const PRODUCT_PAGE_HTML = `
<script type="application/ld+json">
{"@type":"Product","offers":{"@type":"AggregateOffer","lowPrice":"14.99","highPrice":"52.49","priceCurrency":"USD"}}
</script>
`;

describe("librofmAdapter.search", () => {
  it("returns the first search result as the match", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, text: async () => SEARCH_RESULTS_HTML } as Response);

    const result = await librofmAdapter.search("The Way of Kings", "Brandon Sanderson");

    expect(result).toEqual({
      matchedTitle: "The Way of Kings",
      matchedAuthor: "Brandon Sanderson",
      productUrl: "https://libro.fm/audiobooks/9781427209764-the-way-of-kings",
    });
  });

  it("returns null when the search page has no results", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, text: async () => "<div>no results</div>" } as Response);

    const result = await librofmAdapter.search("Some Nonexistent Book", null);

    expect(result).toBeNull();
  });

  it("throws on a non-OK response", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 } as Response);

    await expect(librofmAdapter.search("The Way of Kings", null)).rejects.toThrow();
  });
});

describe("librofmAdapter.fetchPrice", () => {
  it("parses offers.highPrice out of the JSON-LD block", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, text: async () => PRODUCT_PAGE_HTML } as Response);

    const price = await librofmAdapter.fetchPrice("https://libro.fm/audiobooks/9781427209764-the-way-of-kings");

    expect(price).toBe(52.49);
  });

  it("returns null when no JSON-LD block is present", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, text: async () => "<div>gone</div>" } as Response);

    const price = await librofmAdapter.fetchPrice("https://libro.fm/audiobooks/whatever");

    expect(price).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/retailers/librofm.test.ts`
Expected: FAIL — `Cannot find module '@/lib/retailers/librofm'`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/retailers/librofm.ts
import * as cheerio from "cheerio";
import type { RetailerAdapter, RetailerMatchResult } from "@/lib/retailers/types";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

async function search(title: string, author: string | null): Promise<RetailerMatchResult | null> {
  const query = author ? `${title} ${author}` : title;
  const url = `https://libro.fm/search?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!response.ok) {
    throw new Error(`libro.fm search failed: HTTP ${response.status}`);
  }

  const html = await response.text();
  const $ = cheerio.load(html);
  const first = $(".book-grid-item").first();
  const link = first.find("a.book").first();
  const href = link.attr("href");
  if (!href) return null;

  const matchedTitle = first.find(".book-info .title").first().text().trim();
  const matchedAuthorText = first.find(".book-info .author").first().text().trim();

  return {
    matchedTitle,
    matchedAuthor: matchedAuthorText || null,
    productUrl: new URL(href, "https://libro.fm").toString(),
  };
}

interface LibroFmJsonLd {
  offers?: { highPrice?: string };
}

async function fetchPrice(productUrl: string): Promise<number | null> {
  const response = await fetch(productUrl, { headers: { "User-Agent": USER_AGENT } });
  if (!response.ok) {
    throw new Error(`libro.fm product fetch failed: HTTP ${response.status}`);
  }

  const html = await response.text();
  const $ = cheerio.load(html);
  const scriptText = $('script[type="application/ld+json"]').first().html();
  if (!scriptText) return null;

  let data: LibroFmJsonLd;
  try {
    data = JSON.parse(scriptText);
  } catch {
    return null;
  }

  const highPrice = data.offers?.highPrice;
  if (!highPrice) return null;
  const price = Number(highPrice);
  return Number.isFinite(price) ? price : null;
}

export const librofmAdapter: RetailerAdapter = {
  id: "librofm",
  search,
  fetchPrice,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/retailers/librofm.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/retailers/librofm.ts src/lib/retailers/librofm.test.ts
git commit -m "feat: add libro.fm retailer adapter"
```

---

### Task 5: Google Play Books adapter

**Files:**
- Create: `src/lib/retailers/googleplay.ts`
- Test: `src/lib/retailers/googleplay.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/retailers/googleplay.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { googleplayAdapter } from "@/lib/retailers/googleplay";

const originalFetch = global.fetch;
const originalEnv = process.env.GOOGLE_BOOKS_API_KEY;
afterEach(() => {
  global.fetch = originalFetch;
  process.env.GOOGLE_BOOKS_API_KEY = originalEnv;
  vi.restoreAllMocks();
});

function volumesResponse(items: unknown[]) {
  return { ok: true, json: async () => ({ items }) } as Response;
}

describe("googleplayAdapter.search", () => {
  it("returns the first FOR_SALE ebook result", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      volumesResponse([
        {
          volumeInfo: { title: "The Way of Kings", authors: ["Brandon Sanderson"] },
          saleInfo: {
            saleability: "FOR_SALE",
            isEbook: true,
            retailPrice: { amount: 12.99 },
            buyLink: "https://play.google.com/store/books/details?id=abc123",
          },
        },
      ]),
    );

    const result = await googleplayAdapter.search("The Way of Kings", "Brandon Sanderson");

    expect(result).toEqual({
      matchedTitle: "The Way of Kings",
      matchedAuthor: "Brandon Sanderson",
      productUrl: "https://play.google.com/store/books/details?id=abc123",
    });
  });

  it("skips non-FOR_SALE results and returns the first sellable one", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      volumesResponse([
        { volumeInfo: { title: "Preview Only" }, saleInfo: { saleability: "NOT_FOR_SALE" } },
        {
          volumeInfo: { title: "The Way of Kings", authors: ["Brandon Sanderson"] },
          saleInfo: {
            saleability: "FOR_SALE",
            isEbook: true,
            retailPrice: { amount: 12.99 },
            buyLink: "https://play.google.com/store/books/details?id=abc123",
          },
        },
      ]),
    );

    const result = await googleplayAdapter.search("The Way of Kings", "Brandon Sanderson");

    expect(result?.matchedTitle).toBe("The Way of Kings");
  });

  it("returns null when there are no items", async () => {
    global.fetch = vi.fn().mockResolvedValue(volumesResponse([]));

    const result = await googleplayAdapter.search("Some Nonexistent Book", null);

    expect(result).toBeNull();
  });

  it("returns null when no result is FOR_SALE", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      volumesResponse([{ volumeInfo: { title: "X" }, saleInfo: { saleability: "NOT_FOR_SALE" } }]),
    );

    const result = await googleplayAdapter.search("X", null);

    expect(result).toBeNull();
  });
});

describe("googleplayAdapter.fetchPrice", () => {
  it("re-fetches the volume by ID extracted from the stored productUrl and returns retailPrice", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        saleInfo: { saleability: "FOR_SALE", retailPrice: { amount: 9.99 } },
      }),
    } as Response);

    const price = await googleplayAdapter.fetchPrice(
      "https://play.google.com/store/books/details?id=abc123",
    );

    expect(price).toBe(9.99);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/books/v1/volumes/abc123"),
    );
  });

  it("returns null when the volume is no longer for sale", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ saleInfo: { saleability: "NOT_FOR_SALE" } }),
    } as Response);

    const price = await googleplayAdapter.fetchPrice(
      "https://play.google.com/store/books/details?id=abc123",
    );

    expect(price).toBeNull();
  });

  it("returns null when the productUrl has no id param", async () => {
    const price = await googleplayAdapter.fetchPrice("https://play.google.com/store/books/details");

    expect(price).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/retailers/googleplay.test.ts`
Expected: FAIL — `Cannot find module '@/lib/retailers/googleplay'`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/retailers/googleplay.ts
import type { RetailerAdapter, RetailerMatchResult } from "@/lib/retailers/types";

const API_BASE = "https://www.googleapis.com/books/v1/volumes";

interface GoogleBooksSaleInfo {
  saleability?: string;
  isEbook?: boolean;
  retailPrice?: { amount?: number };
  buyLink?: string;
}

interface GoogleBooksVolume {
  volumeInfo?: { title?: string; authors?: string[] };
  saleInfo?: GoogleBooksSaleInfo;
}

function apiKeyParam(): string {
  const key = process.env.GOOGLE_BOOKS_API_KEY;
  return key ? `&key=${encodeURIComponent(key)}` : "";
}

async function search(title: string, author: string | null): Promise<RetailerMatchResult | null> {
  const q = author ? `intitle:${title} inauthor:${author}` : `intitle:${title}`;
  const url = `${API_BASE}?q=${encodeURIComponent(q)}&country=US${apiKeyParam()}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Google Books search failed: HTTP ${response.status}`);
  }

  const data = (await response.json()) as { items?: GoogleBooksVolume[] };
  const forSale = (data.items ?? []).find(
    (item) => item.saleInfo?.saleability === "FOR_SALE" && item.saleInfo?.buyLink,
  );
  if (!forSale) return null;

  return {
    matchedTitle: forSale.volumeInfo?.title ?? title,
    matchedAuthor: forSale.volumeInfo?.authors?.join(", ") ?? null,
    productUrl: forSale.saleInfo!.buyLink!,
  };
}

async function fetchPrice(productUrl: string): Promise<number | null> {
  const id = new URL(productUrl).searchParams.get("id");
  if (!id) return null;

  const url = `${API_BASE}/${encodeURIComponent(id)}?${apiKeyParam().replace(/^&/, "")}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Google Books volume fetch failed: HTTP ${response.status}`);
  }

  const data = (await response.json()) as GoogleBooksVolume;
  if (data.saleInfo?.saleability !== "FOR_SALE") return null;
  const amount = data.saleInfo?.retailPrice?.amount;
  return typeof amount === "number" ? amount : null;
}

export const googleplayAdapter: RetailerAdapter = {
  id: "googleplay",
  search,
  fetchPrice,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/retailers/googleplay.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/retailers/googleplay.ts src/lib/retailers/googleplay.test.ts
git commit -m "feat: add Google Play Books retailer adapter via Google Books API"
```

---

### Task 6: priceTracking.ts — matching, scraping, drop detection

**Files:**
- Create: `src/lib/priceTracking.ts`
- Test: `src/lib/priceTracking.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/priceTracking.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { librofmAdapter } from "@/lib/retailers/librofm";
import { googleplayAdapter } from "@/lib/retailers/googleplay";
import { findRetailerMatches, scrapePrices, getPriceDrops } from "@/lib/priceTracking";

vi.mock("@/lib/retailers/librofm", () => ({ librofmAdapter: { id: "librofm", search: vi.fn(), fetchPrice: vi.fn() } }));
vi.mock("@/lib/retailers/googleplay", () => ({
  googleplayAdapter: { id: "googleplay", search: vi.fn(), fetchPrice: vi.fn() },
}));

const TITLE_PREFIX = "Test Price Tracking";

async function cleanup() {
  await prisma.priceObservation.deleteMany({
    where: { retailerMatch: { tbrItem: { title: { startsWith: TITLE_PREFIX } } } },
  });
  await prisma.retailerMatch.deleteMany({
    where: { tbrItem: { title: { startsWith: TITLE_PREFIX } } },
  });
  await prisma.goodreadsTbrItem.deleteMany({ where: { title: { startsWith: TITLE_PREFIX } } });
}

beforeEach(cleanup);
afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

describe("findRetailerMatches", () => {
  it("creates one unconfirmed RetailerMatch per adapter for an unowned item with no existing match", async () => {
    const item = await prisma.goodreadsTbrItem.create({
      data: { title: `${TITLE_PREFIX} A`, author: "Author A", owned: false },
    });
    vi.mocked(librofmAdapter.search).mockResolvedValue({
      matchedTitle: `${TITLE_PREFIX} A`,
      matchedAuthor: "Author A",
      productUrl: "https://libro.fm/audiobooks/x",
    });
    vi.mocked(googleplayAdapter.search).mockResolvedValue({
      matchedTitle: `${TITLE_PREFIX} A`,
      matchedAuthor: "Author A",
      productUrl: "https://play.google.com/store/books/details?id=x",
    });

    await findRetailerMatches();

    const matches = await prisma.retailerMatch.findMany({ where: { tbrItemId: item.id } });
    expect(matches).toHaveLength(2);
    expect(matches.every((m) => m.confirmed === false)).toBe(true);
    expect(matches.map((m) => m.retailer).sort()).toEqual(["googleplay", "librofm"]);
  });

  it("does not create a second match for a retailer that already has one", async () => {
    const item = await prisma.goodreadsTbrItem.create({
      data: { title: `${TITLE_PREFIX} B`, owned: false },
    });
    await prisma.retailerMatch.create({
      data: {
        tbrItemId: item.id,
        retailer: "librofm",
        productUrl: "https://libro.fm/audiobooks/existing",
        matchedTitle: `${TITLE_PREFIX} B`,
        confirmed: true,
      },
    });
    vi.mocked(librofmAdapter.search).mockResolvedValue(null);
    vi.mocked(googleplayAdapter.search).mockResolvedValue(null);

    await findRetailerMatches();

    expect(librofmAdapter.search).not.toHaveBeenCalled();
    const matches = await prisma.retailerMatch.findMany({ where: { tbrItemId: item.id } });
    expect(matches).toHaveLength(1);
  });

  it("skips owned items entirely", async () => {
    await prisma.goodreadsTbrItem.create({ data: { title: `${TITLE_PREFIX} C`, owned: true } });
    vi.mocked(librofmAdapter.search).mockResolvedValue(null);
    vi.mocked(googleplayAdapter.search).mockResolvedValue(null);

    await findRetailerMatches();

    expect(librofmAdapter.search).not.toHaveBeenCalled();
  });

  it("continues past one item's search failure", async () => {
    await prisma.goodreadsTbrItem.create({ data: { title: `${TITLE_PREFIX} D`, owned: false } });
    const okItem = await prisma.goodreadsTbrItem.create({ data: { title: `${TITLE_PREFIX} E`, owned: false } });
    vi.mocked(librofmAdapter.search)
      .mockRejectedValueOnce(new Error("network error"))
      .mockResolvedValue({ matchedTitle: `${TITLE_PREFIX} E`, matchedAuthor: null, productUrl: "https://libro.fm/x" });
    vi.mocked(googleplayAdapter.search).mockResolvedValue(null);

    await findRetailerMatches();

    const matches = await prisma.retailerMatch.findMany({ where: { tbrItemId: okItem.id, retailer: "librofm" } });
    expect(matches).toHaveLength(1);
  });
});

describe("scrapePrices", () => {
  it("inserts a PriceObservation only for confirmed matches", async () => {
    const item = await prisma.goodreadsTbrItem.create({ data: { title: `${TITLE_PREFIX} F`, owned: false } });
    const confirmed = await prisma.retailerMatch.create({
      data: { tbrItemId: item.id, retailer: "librofm", productUrl: "https://libro.fm/x", matchedTitle: "x", confirmed: true },
    });
    await prisma.retailerMatch.create({
      data: { tbrItemId: item.id, retailer: "googleplay", productUrl: "https://play.google.com/x", matchedTitle: "x", confirmed: false },
    });
    vi.mocked(librofmAdapter.fetchPrice).mockResolvedValue(19.99);

    await scrapePrices();

    const observations = await prisma.priceObservation.findMany({ where: { retailerMatchId: confirmed.id } });
    expect(observations).toHaveLength(1);
    expect(observations[0].price).toBe(19.99);
    expect(googleplayAdapter.fetchPrice).not.toHaveBeenCalled();
  });

  it("skips a failed scrape without stopping the batch", async () => {
    const item1 = await prisma.goodreadsTbrItem.create({ data: { title: `${TITLE_PREFIX} G`, owned: false } });
    const item2 = await prisma.goodreadsTbrItem.create({ data: { title: `${TITLE_PREFIX} H`, owned: false } });
    const failing = await prisma.retailerMatch.create({
      data: { tbrItemId: item1.id, retailer: "librofm", productUrl: "https://libro.fm/fail", matchedTitle: "x", confirmed: true },
    });
    const ok = await prisma.retailerMatch.create({
      data: { tbrItemId: item2.id, retailer: "librofm", productUrl: "https://libro.fm/ok", matchedTitle: "x", confirmed: true },
    });
    vi.mocked(librofmAdapter.fetchPrice)
      .mockRejectedValueOnce(new Error("parse error"))
      .mockResolvedValueOnce(9.99);

    await scrapePrices();

    expect(await prisma.priceObservation.count({ where: { retailerMatchId: failing.id } })).toBe(0);
    expect(await prisma.priceObservation.count({ where: { retailerMatchId: ok.id } })).toBe(1);
  });
});

describe("getPriceDrops", () => {
  it("flags a match whose newest price is lower than the previous one", async () => {
    const item = await prisma.goodreadsTbrItem.create({ data: { title: `${TITLE_PREFIX} I`, owned: false } });
    const match = await prisma.retailerMatch.create({
      data: { tbrItemId: item.id, retailer: "librofm", productUrl: "https://libro.fm/x", matchedTitle: "x", confirmed: true },
    });
    await prisma.priceObservation.create({ data: { retailerMatchId: match.id, price: 20, observedAt: new Date("2026-08-14") } });
    await prisma.priceObservation.create({ data: { retailerMatchId: match.id, price: 15, observedAt: new Date("2026-08-15") } });

    const drops = await getPriceDrops();

    expect(drops).toEqual([
      expect.objectContaining({ tbrItemId: item.id, retailer: "librofm", previousPrice: 20, newPrice: 15 }),
    ]);
  });

  it("does not flag a match with only one observation", async () => {
    const item = await prisma.goodreadsTbrItem.create({ data: { title: `${TITLE_PREFIX} J`, owned: false } });
    const match = await prisma.retailerMatch.create({
      data: { tbrItemId: item.id, retailer: "librofm", productUrl: "https://libro.fm/x", matchedTitle: "x", confirmed: true },
    });
    await prisma.priceObservation.create({ data: { retailerMatchId: match.id, price: 20 } });

    expect(await getPriceDrops()).toEqual([]);
  });

  it("does not flag a match whose price rose or stayed the same", async () => {
    const item = await prisma.goodreadsTbrItem.create({ data: { title: `${TITLE_PREFIX} K`, owned: false } });
    const match = await prisma.retailerMatch.create({
      data: { tbrItemId: item.id, retailer: "librofm", productUrl: "https://libro.fm/x", matchedTitle: "x", confirmed: true },
    });
    await prisma.priceObservation.create({ data: { retailerMatchId: match.id, price: 10, observedAt: new Date("2026-08-14") } });
    await prisma.priceObservation.create({ data: { retailerMatchId: match.id, price: 10, observedAt: new Date("2026-08-15") } });

    expect(await getPriceDrops()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/priceTracking.test.ts`
Expected: FAIL — `Cannot find module '@/lib/priceTracking'`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/priceTracking.ts
import { prisma } from "@/lib/prisma";
import { librofmAdapter } from "@/lib/retailers/librofm";
import { googleplayAdapter } from "@/lib/retailers/googleplay";
import type { RetailerAdapter } from "@/lib/retailers/types";

const ADAPTERS: RetailerAdapter[] = [librofmAdapter, googleplayAdapter];

// For every unowned TBR item, and every adapter that doesn't already have a
// RetailerMatch row for it (confirmed or not -- the unique constraint means
// there's never more than one match per item/retailer pair), search for a
// product match and store it unconfirmed. Each item/adapter pair is
// independent: one search failure is caught and logged, never stops the rest
// of the batch.
export async function findRetailerMatches(): Promise<void> {
  const items = await prisma.goodreadsTbrItem.findMany({
    where: { owned: false },
    select: { id: true, title: true, author: true, retailerMatches: { select: { retailer: true } } },
  });

  for (const item of items) {
    const existingRetailers = new Set(item.retailerMatches.map((m) => m.retailer));
    for (const adapter of ADAPTERS) {
      if (existingRetailers.has(adapter.id)) continue;

      try {
        const result = await adapter.search(item.title, item.author);
        if (!result) continue;
        await prisma.retailerMatch.create({
          data: {
            tbrItemId: item.id,
            retailer: adapter.id,
            productUrl: result.productUrl,
            matchedTitle: result.matchedTitle,
            matchedAuthor: result.matchedAuthor,
          },
        });
      } catch (err) {
        console.error(`Retailer match failed for "${item.title}" on ${adapter.id}:`, err);
      }
    }
  }
}

// Scrapes a fresh price for every CONFIRMED match only -- unconfirmed
// matches cost nothing beyond the one-time search until a human confirms
// them. One failure is caught/logged per match and does not insert a row or
// stop the rest of the batch.
export async function scrapePrices(): Promise<void> {
  const matches = await prisma.retailerMatch.findMany({ where: { confirmed: true } });
  const adaptersById = new Map(ADAPTERS.map((a) => [a.id, a]));

  for (const match of matches) {
    const adapter = adaptersById.get(match.retailer);
    if (!adapter) continue;

    try {
      const price = await adapter.fetchPrice(match.productUrl);
      if (price === null) continue;
      await prisma.priceObservation.create({ data: { retailerMatchId: match.id, price } });
    } catch (err) {
      console.error(`Price scrape failed for match ${match.id} (${match.retailer}):`, err);
    }
  }
}

export interface PriceDrop {
  tbrItemId: string;
  tbrItemTitle: string;
  retailer: string;
  previousPrice: number;
  newPrice: number;
}

// A drop is only "new" the run it's detected: newest observation strictly
// less than the one before it. If the price stays at the lower value, the
// next day's comparison is equal, not a drop -- so this naturally never
// re-flags an already-reported drop unless the price moves again.
export async function getPriceDrops(): Promise<PriceDrop[]> {
  const matches = await prisma.retailerMatch.findMany({
    where: { confirmed: true },
    include: {
      tbrItem: { select: { id: true, title: true } },
      observations: { orderBy: { observedAt: "desc" }, take: 2 },
    },
  });

  const drops: PriceDrop[] = [];
  for (const match of matches) {
    if (match.observations.length < 2) continue;
    const [newest, previous] = match.observations;
    if (newest.price < previous.price) {
      drops.push({
        tbrItemId: match.tbrItem.id,
        tbrItemTitle: match.tbrItem.title,
        retailer: match.retailer,
        previousPrice: previous.price,
        newPrice: newest.price,
      });
    }
  }
  return drops;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/priceTracking.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/priceTracking.ts src/lib/priceTracking.test.ts
git commit -m "feat: add retailer matching, price scraping, and drop detection"
```

---

### Task 7: Email digest via Resend

**Files:**
- Create: `src/lib/emailDigest.ts`
- Test: `src/lib/emailDigest.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/emailDigest.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { sendPriceDropDigest } from "@/lib/emailDigest";
import type { PriceDrop } from "@/lib/priceTracking";

const originalFetch = global.fetch;
const originalKey = process.env.RESEND_API_KEY;
const originalTo = process.env.PRICE_ALERT_EMAIL;

afterEach(() => {
  global.fetch = originalFetch;
  process.env.RESEND_API_KEY = originalKey;
  process.env.PRICE_ALERT_EMAIL = originalTo;
  vi.restoreAllMocks();
});

const SAMPLE_DROPS: PriceDrop[] = [
  { tbrItemId: "1", tbrItemTitle: "The Way of Kings", retailer: "librofm", previousPrice: 52.49, newPrice: 39.99 },
];

describe("sendPriceDropDigest", () => {
  it("sends one email via the Resend API when there are drops", async () => {
    process.env.RESEND_API_KEY = "test-key";
    process.env.PRICE_ALERT_EMAIL = "me@example.com";
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "abc" }) } as Response);

    await sendPriceDropDigest(SAMPLE_DROPS);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(global.fetch).mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer test-key" });
    const body = JSON.parse(init!.body as string);
    expect(body.to).toEqual(["me@example.com"]);
    expect(body.html).toContain("The Way of Kings");
    expect(body.html).toContain("52.49");
    expect(body.html).toContain("39.99");
  });

  it("does nothing when there are no drops", async () => {
    process.env.RESEND_API_KEY = "test-key";
    process.env.PRICE_ALERT_EMAIL = "me@example.com";
    global.fetch = vi.fn();

    await sendPriceDropDigest([]);

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("logs and does not throw when RESEND_API_KEY is unset", async () => {
    delete process.env.RESEND_API_KEY;
    process.env.PRICE_ALERT_EMAIL = "me@example.com";
    global.fetch = vi.fn();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(sendPriceDropDigest(SAMPLE_DROPS)).resolves.toBeUndefined();

    expect(global.fetch).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("catches and logs a send failure instead of throwing", async () => {
    process.env.RESEND_API_KEY = "test-key";
    process.env.PRICE_ALERT_EMAIL = "me@example.com";
    global.fetch = vi.fn().mockRejectedValue(new Error("network error"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(sendPriceDropDigest(SAMPLE_DROPS)).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/emailDigest.test.ts`
Expected: FAIL — `Cannot find module '@/lib/emailDigest'`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/emailDigest.ts
import type { PriceDrop } from "@/lib/priceTracking";

function renderHtml(drops: PriceDrop[]): string {
  const rows = drops
    .map(
      (d) =>
        `<li><strong>${d.tbrItemTitle}</strong> (${d.retailer}): $${d.previousPrice.toFixed(2)} → $${d.newPrice.toFixed(2)}</li>`,
    )
    .join("");
  return `<p>${drops.length} TBR book${drops.length === 1 ? "" : "s"} dropped in price:</p><ul>${rows}</ul>`;
}

// Sends one digest email for all of today's drops via Resend's REST API
// directly (no SDK dependency -- this is a single POST). Missing config or a
// send failure is caught and logged, never thrown -- the caller (the daily
// cron job) must not have its other steps blocked by an email problem.
export async function sendPriceDropDigest(drops: PriceDrop[]): Promise<void> {
  if (drops.length === 0) return;

  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.PRICE_ALERT_EMAIL;
  if (!apiKey || !to) {
    console.error("Skipping price-drop digest email: RESEND_API_KEY/PRICE_ALERT_EMAIL not set");
    return;
  }

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "TBR Price Tracker <onboarding@resend.dev>",
        to: [to],
        subject: `${drops.length} TBR price drop${drops.length === 1 ? "" : "s"}`,
        html: renderHtml(drops),
      }),
    });
    if (!response.ok) {
      console.error(`Resend send failed: HTTP ${response.status}`);
    }
  } catch (err) {
    console.error("Resend send failed:", err);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/emailDigest.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/emailDigest.ts src/lib/emailDigest.test.ts
git commit -m "feat: add price-drop digest email via Resend"
```

---

### Task 8: Wire the daily cron job

**Files:**
- Modify: `src/instrumentation.ts`

- [ ] **Step 1: Add the daily job**

In `src/instrumentation.ts`, add imports alongside the existing ones and a second `cron.schedule` call, before the final `console.log`:

```typescript
  const { findRetailerMatches, scrapePrices, getPriceDrops } = await import("@/lib/priceTracking");
  const { sendPriceDropDigest } = await import("@/lib/emailDigest");
```

```typescript
  // Separate daily job (not folded into the 30-minute job above) so a slow
  // or failing retailer scrape can never delay or block the ABS/Goodreads
  // syncs, and vice versa -- same reasoning that already justifies
  // { noOverlap: true } on the job above, applied across jobs instead of
  // within one.
  cron.schedule(
    "0 6 * * *",
    async () => {
      try {
        await findRetailerMatches();
      } catch (error) {
        console.error("Retailer matching failed:", error);
      }
      try {
        await scrapePrices();
      } catch (error) {
        console.error("Price scraping failed:", error);
      }
      try {
        const drops = await getPriceDrops();
        await sendPriceDropDigest(drops);
        if (drops.length > 0) {
          console.log(`Price-drop digest sent: ${drops.length} drop(s)`);
        }
      } catch (error) {
        console.error("Price-drop digest failed:", error);
      }
    },
    { noOverlap: true },
  );

  console.log("Registered daily TBR price-tracking cron job (06:00)");
```

- [ ] **Step 2: Verify the file still type-checks**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/instrumentation.ts
git commit -m "feat: schedule daily TBR price-tracking cron job"
```

---

### Task 9: Confirm/reject server actions

**Files:**
- Create: `src/lib/actions/retailerMatch.ts`
- Test: `src/lib/actions/retailerMatch.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/actions/retailerMatch.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { confirmRetailerMatch, rejectRetailerMatch } from "@/lib/actions/retailerMatch";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const TITLE_PREFIX = "Test Retailer Match Action";

async function cleanup() {
  await prisma.retailerMatch.deleteMany({ where: { tbrItem: { title: { startsWith: TITLE_PREFIX } } } });
  await prisma.goodreadsTbrItem.deleteMany({ where: { title: { startsWith: TITLE_PREFIX } } });
}

beforeEach(cleanup);
afterEach(cleanup);

describe("confirmRetailerMatch", () => {
  it("sets confirmed to true", async () => {
    const item = await prisma.goodreadsTbrItem.create({ data: { title: `${TITLE_PREFIX} A`, owned: false } });
    const match = await prisma.retailerMatch.create({
      data: { tbrItemId: item.id, retailer: "librofm", productUrl: "https://libro.fm/x", matchedTitle: "x", confirmed: false },
    });

    await confirmRetailerMatch(match.id);

    const updated = await prisma.retailerMatch.findUniqueOrThrow({ where: { id: match.id } });
    expect(updated.confirmed).toBe(true);
  });
});

describe("rejectRetailerMatch", () => {
  it("deletes the match, allowing a future findRetailerMatches run to re-match it", async () => {
    const item = await prisma.goodreadsTbrItem.create({ data: { title: `${TITLE_PREFIX} B`, owned: false } });
    const match = await prisma.retailerMatch.create({
      data: { tbrItemId: item.id, retailer: "librofm", productUrl: "https://libro.fm/x", matchedTitle: "x", confirmed: false },
    });

    await rejectRetailerMatch(match.id);

    expect(await prisma.retailerMatch.findUnique({ where: { id: match.id } })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/actions/retailerMatch.test.ts`
Expected: FAIL — `Cannot find module '@/lib/actions/retailerMatch'`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/actions/retailerMatch.ts
"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";

export async function confirmRetailerMatch(matchId: string): Promise<void> {
  await prisma.retailerMatch.update({ where: { id: matchId }, data: { confirmed: true } });
  revalidatePath("/tbr");
}

// Deletes the match outright, rather than marking it rejected -- the unique
// constraint on (tbrItemId, retailer) means findRetailerMatches will attempt
// this pair again on its next daily run once the row is gone.
export async function rejectRetailerMatch(matchId: string): Promise<void> {
  await prisma.retailerMatch.delete({ where: { id: matchId } });
  revalidatePath("/tbr");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/actions/retailerMatch.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/actions/retailerMatch.ts src/lib/actions/retailerMatch.test.ts
git commit -m "feat: add confirm/reject server actions for retailer matches"
```

---

### Task 10: Extend `getTbrGap` with retailer matches

**Files:**
- Modify: `src/lib/tbrGap.ts`
- Test: `src/lib/tbrGap.test.ts` (extend existing file)

- [ ] **Step 1: Write the failing test**

Add to `src/lib/tbrGap.test.ts` (find the existing `describe("getTbrGap"` block, or add a new one near it):

```typescript
describe("getTbrGap retailer matches", () => {
  it("includes each item's retailer matches with their latest price", async () => {
    const item = await prisma.goodreadsTbrItem.create({
      data: { title: "Test TBR Gap Retailer Match Item", owned: false },
    });
    const match = await prisma.retailerMatch.create({
      data: {
        tbrItemId: item.id,
        retailer: "librofm",
        productUrl: "https://libro.fm/x",
        matchedTitle: "Test TBR Gap Retailer Match Item",
        confirmed: true,
      },
    });
    await prisma.priceObservation.create({ data: { retailerMatchId: match.id, price: 20, observedAt: new Date("2026-08-14") } });
    await prisma.priceObservation.create({ data: { retailerMatchId: match.id, price: 15, observedAt: new Date("2026-08-15") } });

    const gap = await getTbrGap();
    const found = gap.find((i) => i.id === item.id);

    expect(found?.retailerMatches).toEqual([
      expect.objectContaining({
        id: match.id,
        retailer: "librofm",
        confirmed: true,
        matchedTitle: "Test TBR Gap Retailer Match Item",
        currentPrice: 15,
        previousPrice: 20,
      }),
    ]);

    await prisma.priceObservation.deleteMany({ where: { retailerMatchId: match.id } });
    await prisma.retailerMatch.deleteMany({ where: { tbrItemId: item.id } });
    await prisma.goodreadsTbrItem.deleteMany({ where: { id: item.id } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/tbrGap.test.ts`
Expected: FAIL — `found?.retailerMatches` is `undefined`.

- [ ] **Step 3: Update the implementation**

In `src/lib/tbrGap.ts`, update `TbrGapItem` and `computeTbrGap`:

```typescript
export interface TbrGapRetailerMatch {
  id: string;
  retailer: string;
  confirmed: boolean;
  matchedTitle: string;
  currentPrice: number | null;
  previousPrice: number | null;
}

export interface TbrGapItem {
  id: string;
  title: string;
  author: string | null;
  coverImagePath: string | null;
  isbn: string | null;
  retailerMatches: TbrGapRetailerMatch[];
}
```

```typescript
async function computeTbrGap(): Promise<TbrGapItem[]> {
  const tbrItems = await prisma.goodreadsTbrItem.findMany({
    where: { owned: false },
    select: {
      id: true,
      title: true,
      author: true,
      coverImagePath: true,
      isbn: true,
      retailerMatches: {
        select: {
          id: true,
          retailer: true,
          confirmed: true,
          matchedTitle: true,
          observations: { orderBy: { observedAt: "desc" }, take: 2, select: { price: true } },
        },
      },
    },
  });

  return tbrItems
    .map((tbr) => ({
      id: tbr.id,
      title: tbr.title,
      author: tbr.author,
      coverImagePath: tbr.coverImagePath,
      isbn: tbr.isbn,
      retailerMatches: tbr.retailerMatches.map((m) => ({
        id: m.id,
        retailer: m.retailer,
        confirmed: m.confirmed,
        matchedTitle: m.matchedTitle,
        currentPrice: m.observations[0]?.price ?? null,
        previousPrice: m.observations[1]?.price ?? null,
      })),
    }))
    .sort((a, b) => sortKey(a).localeCompare(sortKey(b), undefined, { sensitivity: "base" }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/tbrGap.test.ts`
Expected: PASS (all tests, including the existing ones — the added field is additive).

- [ ] **Step 5: Commit**

```bash
git add src/lib/tbrGap.ts src/lib/tbrGap.test.ts
git commit -m "feat: include retailer matches and prices in getTbrGap"
```

---

### Task 11: `RetailerPriceBadge` component

**Files:**
- Create: `src/components/RetailerPriceBadge.tsx`
- Test: `src/components/RetailerPriceBadge.test.tsx`

- [ ] **Step 1: Write the failing test**

```typescript
// src/components/RetailerPriceBadge.test.tsx
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RetailerPriceBadge } from "@/components/RetailerPriceBadge";
import type { TbrGapRetailerMatch } from "@/lib/tbrGap";

function makeMatch(overrides: Partial<TbrGapRetailerMatch> = {}): TbrGapRetailerMatch {
  return {
    id: "match-1",
    retailer: "librofm",
    confirmed: true,
    matchedTitle: "The Way of Kings",
    currentPrice: 19.99,
    previousPrice: null,
    ...overrides,
  };
}

describe("RetailerPriceBadge", () => {
  it("renders a confirm/reject prompt for an unconfirmed match", () => {
    const html = renderToStaticMarkup(
      <RetailerPriceBadge match={makeMatch({ confirmed: false, currentPrice: null })} />,
    );
    expect(html).toContain("The Way of Kings");
    expect(html).toContain("Confirm");
    expect(html).toContain("Reject");
  });

  it("renders a plain price badge for a confirmed match with no drop", () => {
    const html = renderToStaticMarkup(
      <RetailerPriceBadge match={makeMatch({ confirmed: true, currentPrice: 19.99, previousPrice: null })} />,
    );
    expect(html).toContain("19.99");
    expect(html).not.toContain("↓");
  });

  it("renders a drop indicator when previousPrice is higher than currentPrice", () => {
    const html = renderToStaticMarkup(
      <RetailerPriceBadge match={makeMatch({ confirmed: true, currentPrice: 9.99, previousPrice: 19.99 })} />,
    );
    expect(html).toContain("↓");
    expect(html).toContain("9.99");
    expect(html).toContain("19.99");
  });

  it("renders nothing when confirmed but no price has been scraped yet", () => {
    const html = renderToStaticMarkup(
      <RetailerPriceBadge match={makeMatch({ confirmed: true, currentPrice: null, previousPrice: null })} />,
    );
    expect(html).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/RetailerPriceBadge.test.tsx`
Expected: FAIL — `Cannot find module '@/components/RetailerPriceBadge'`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/components/RetailerPriceBadge.tsx
import type { TbrGapRetailerMatch } from "@/lib/tbrGap";
import { confirmRetailerMatch, rejectRetailerMatch } from "@/lib/actions/retailerMatch";

const RETAILER_LABELS: Record<string, string> = {
  librofm: "libro.fm",
  googleplay: "Google Play Books",
};

export function RetailerPriceBadge({ match }: { match: TbrGapRetailerMatch }) {
  const label = RETAILER_LABELS[match.retailer] ?? match.retailer;

  if (!match.confirmed) {
    return (
      <div className="flex flex-wrap items-center gap-1 text-xs">
        <span className="text-foreground/70">
          Confirm match: &quot;{match.matchedTitle}&quot; on {label}?
        </span>
        <form action={confirmRetailerMatch.bind(null, match.id)}>
          <button type="submit" className="text-link underline">
            Confirm
          </button>
        </form>
        <form action={rejectRetailerMatch.bind(null, match.id)}>
          <button type="submit" className="text-link underline">
            Reject
          </button>
        </form>
      </div>
    );
  }

  if (match.currentPrice === null) return null;

  const isDrop = match.previousPrice !== null && match.currentPrice < match.previousPrice;

  return (
    <p className={`text-xs ${isDrop ? "font-semibold text-status-positive" : "text-foreground/70"}`}>
      {isDrop && "↓ "}
      {label}: ${match.currentPrice.toFixed(2)}
      {isDrop && ` (was $${match.previousPrice!.toFixed(2)})`}
    </p>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/RetailerPriceBadge.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/RetailerPriceBadge.tsx src/components/RetailerPriceBadge.test.tsx
git commit -m "feat: add RetailerPriceBadge component"
```

---

### Task 12: Render `RetailerPriceBadge` on `/tbr`

**Files:**
- Modify: `src/app/tbr/page.tsx`

- [ ] **Step 1: Add the import**

```typescript
import { RetailerPriceBadge } from "@/components/RetailerPriceBadge";
```

- [ ] **Step 2: Render matches in the list view**

In the list-view `<TicketCard>` block, add the matches after the author line:

```tsx
<TicketCard key={item.id} className="p-3">
  <CoverThumbnail coverImagePath={item.coverImagePath} className="mb-2" />
  <p className="font-medium text-foreground-strong">{item.title}</p>
  {item.author && <p className="text-sm text-foreground/70">{item.author}</p>}
  {item.retailerMatches.length > 0 && (
    <div className="mt-1 space-y-1">
      {item.retailerMatches.map((match) => (
        <RetailerPriceBadge key={match.id} match={match} />
      ))}
    </div>
  )}
</TicketCard>
```

- [ ] **Step 3: Render matches in the grid view**

`CoverGridCard` doesn't currently accept extra children below its text block, and per its own file comment it's shared with the catalog's `SearchResult` shape — adding retailer-specific props there would leak this feature into an unrelated component. Instead, wrap it for the `/tbr` grid case only:

```tsx
<ul className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-4">
  {group.items.map((item) => (
    <li key={item.id}>
      <CoverGridCard result={item} />
      {item.retailerMatches.length > 0 && (
        <div className="mt-1 space-y-1 px-1">
          {item.retailerMatches.map((match) => (
            <RetailerPriceBadge key={match.id} match={match} />
          ))}
        </div>
      )}
    </li>
  ))}
</ul>
```

Note this changes the existing `<ul>`'s children from `<CoverGridCard key={item.id} .../>` directly to a wrapping `<li>` — `CoverGridCard` itself still renders its own inner `<li data-testid="catalog-grid-item">`, so this introduces a harmless nested `<li>` (browsers tolerate it, and no test asserts on `/tbr`'s DOM nesting depth). Confirm this by re-running the `/tbr` view-mode tests in Step 5 below.

- [ ] **Step 4: Manually verify in the dev server**

Run: `npm run dev`, then open `http://localhost:3000/tbr` in a browser. Expected: page loads without error; since no `RetailerMatch` rows exist yet in dev data, no badges render (this is the "no match yet" case from the spec — confirmed by Task 6's tests, not by anything visible here yet).

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: all tests pass, including the pre-existing `src/app` / `viewMode` tests unaffected by this change.

- [ ] **Step 6: Commit**

```bash
git add src/app/tbr/page.tsx
git commit -m "feat: render retailer price badges on /tbr"
```

---

### Task 13: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all tests pass (0 failures).

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 5: Commit any lint/format fixups if needed**

```bash
git add -A
git commit -m "chore: fix lint/type issues from TBR price tracking" --allow-empty
```

(Use `--allow-empty` only if Steps 2–4 found nothing to fix and there's nothing staged; otherwise omit it.)
