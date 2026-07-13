import { prisma } from "@/lib/prisma";
import { isTitleMatch } from "@/lib/matching";

export interface TbrGapItem {
  id: string;
  title: string;
  author: string | null;
}

export async function getTbrGap(): Promise<TbrGapItem[]> {
  const [tbrItems, books, absItems] = await Promise.all([
    prisma.goodreadsTbrItem.findMany(),
    prisma.book.findMany({ select: { title: true } }),
    prisma.absCacheItem.findMany({ select: { title: true } }),
  ]);

  const ownedTitles = [...books.map((b) => b.title), ...absItems.map((a) => a.title)];

  return tbrItems
    .filter((tbr) => !ownedTitles.some((owned) => isTitleMatch(tbr.title, owned)))
    .map((tbr) => ({ id: tbr.id, title: tbr.title, author: tbr.author }));
}
