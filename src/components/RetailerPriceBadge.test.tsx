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
