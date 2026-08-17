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
  // vi.restoreAllMocks() only restores vi.spyOn-based mocks; the module
  // mocks here are plain vi.fn() (registered via the vi.mock factories
  // above), so clearAllMocks is what actually resets their call history
  // between tests.
  vi.clearAllMocks();
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

  it("does not re-create a match for a retailer the user already rejected", async () => {
    const item = await prisma.goodreadsTbrItem.create({
      data: { title: `${TITLE_PREFIX} B2`, owned: false },
    });
    await prisma.retailerMatch.create({
      data: {
        tbrItemId: item.id,
        retailer: "librofm",
        productUrl: "https://libro.fm/audiobooks/wrong-book",
        matchedTitle: `${TITLE_PREFIX} B2`,
        confirmed: false,
        rejected: true,
      },
    });
    vi.mocked(librofmAdapter.search).mockResolvedValue(null);
    vi.mocked(googleplayAdapter.search).mockResolvedValue(null);

    await findRetailerMatches();

    expect(librofmAdapter.search).not.toHaveBeenCalled();
    const matches = await prisma.retailerMatch.findMany({ where: { tbrItemId: item.id } });
    expect(matches).toHaveLength(1);
    expect(matches[0].rejected).toBe(true);
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
