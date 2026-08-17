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
