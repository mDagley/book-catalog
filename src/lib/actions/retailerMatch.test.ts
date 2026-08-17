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
  it("sets rejected to true rather than deleting the row, so the pair is never re-matched", async () => {
    const item = await prisma.goodreadsTbrItem.create({ data: { title: `${TITLE_PREFIX} B`, owned: false } });
    const match = await prisma.retailerMatch.create({
      data: { tbrItemId: item.id, retailer: "librofm", productUrl: "https://libro.fm/x", matchedTitle: "x", confirmed: false },
    });

    await rejectRetailerMatch(match.id);

    const updated = await prisma.retailerMatch.findUniqueOrThrow({ where: { id: match.id } });
    expect(updated.rejected).toBe(true);
  });

  it("does not throw when rejecting a match that has price observations", async () => {
    const item = await prisma.goodreadsTbrItem.create({ data: { title: `${TITLE_PREFIX} C`, owned: false } });
    const match = await prisma.retailerMatch.create({
      data: { tbrItemId: item.id, retailer: "librofm", productUrl: "https://libro.fm/x", matchedTitle: "x", confirmed: true },
    });
    await prisma.priceObservation.create({ data: { retailerMatchId: match.id, price: 9.99 } });

    await expect(rejectRetailerMatch(match.id)).resolves.not.toThrow();

    const updated = await prisma.retailerMatch.findUniqueOrThrow({ where: { id: match.id } });
    expect(updated.rejected).toBe(true);
  });
});
