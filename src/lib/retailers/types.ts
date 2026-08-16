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
