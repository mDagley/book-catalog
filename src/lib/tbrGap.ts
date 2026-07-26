import { prisma } from "@/lib/prisma";
import { isTitleMatch } from "@/lib/matching";
import { normalizeIsbn } from "@/lib/isbn";

export interface TbrGapItem {
  id: string;
  title: string;
  author: string | null;
  coverImagePath: string | null;
  isbn: string | null;
}

// Author (trimmed) if present, else title (trimmed) -- used both to sort the
// full list and to decide which letter bucket an item falls into in
// groupByInitial, so the two always agree on what "browsing alphabetically"
// means for a given item.
function sortKey(item: Pick<TbrGapItem, "title" | "author">): string {
  return item.author?.trim() || item.title.trim();
}

// Strips diacritics before the A-Z test so bucketing agrees with sortKey's
// locale-aware, base-letter-insensitive sort (an author like "Émile Zola"
// sorts among the E's -- it should bucket under "E", not fall through to
// "#" just because its first character isn't plain ASCII).
function letterBucket(key: string): string {
  const normalized = key
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toUpperCase();
  const firstChar = normalized.charAt(0);
  return /[A-Z]/.test(firstChar) ? firstChar : "#";
}

async function computeTbrGap(): Promise<TbrGapItem[]> {
  const tbrItems = await prisma.goodreadsTbrItem.findMany({
    where: { owned: false },
    select: { id: true, title: true, author: true, coverImagePath: true, isbn: true },
  });

  return tbrItems
    .map((tbr) => ({
      id: tbr.id,
      title: tbr.title,
      author: tbr.author,
      coverImagePath: tbr.coverImagePath,
      isbn: tbr.isbn,
    }))
    .sort((a, b) => sortKey(a).localeCompare(sortKey(b), undefined, { sensitivity: "base" }));
}

// Call whenever a new owned title starts existing (a Book is created, or an
// existing Book's title changes to something new). Checks only currently-
// unowned TBR items against this ONE title -- O(unowned TBR items), not the
// full owned-books cross product -- and flips any fuzzy match to owned.
export async function markTbrItemsOwnedByTitle(title: string): Promise<void> {
  const unowned = await prisma.goodreadsTbrItem.findMany({
    where: { owned: false },
    select: { id: true, title: true },
  });
  const nowOwnedIds = unowned
    .filter((item) => isTitleMatch(item.title, title))
    .map((item) => item.id);
  if (nowOwnedIds.length === 0) return;
  await prisma.goodreadsTbrItem.updateMany({
    where: { id: { in: nowOwnedIds } },
    data: { owned: true },
  });
}

// Call whenever an owned title stops existing (a Book is deleted, or an
// existing Book's title changes away from its old value). Re-verifies only
// currently-owned TBR items against the full current owned-title list --
// bounded by how many TBR items have ever matched an owned book, not the
// full TBR list -- and flips any that no longer match back to unowned.
export async function recheckOwnedTbrItems(): Promise<void> {
  const [owned, books] = await Promise.all([
    prisma.goodreadsTbrItem.findMany({
      where: { owned: true },
      select: { id: true, title: true },
    }),
    prisma.book.findMany({ select: { title: true } }),
  ]);
  if (owned.length === 0) return;
  const ownedTitles = books.map((b) => b.title);
  const noLongerOwnedIds = owned
    .filter((item) => !ownedTitles.some((title) => isTitleMatch(item.title, title)))
    .map((item) => item.id);
  if (noLongerOwnedIds.length === 0) return;
  await prisma.goodreadsTbrItem.updateMany({
    where: { id: { in: noLongerOwnedIds } },
    data: { owned: false },
  });
}

export interface TbrOwnershipRecomputeResult {
  total: number;
  markedOwned: number;
  markedUnowned: number;
}

// Recomputes `owned` from scratch for EVERY TBR item, in both directions.
//
// This is the full cross-product the per-request path used to run (measured
// ~49s at 900 books x 808 TBR items) -- deliberately confined to this one
// explicitly-triggered function instead of every page load. It backs both the
// one-time post-migration backfill and the manual "Recompute ownership"
// button on /tbr.
//
// Unlike markTbrItemsOwnedByTitle/recheckOwnedTbrItems -- which are narrow,
// incremental, and each only move rows one direction -- this is the
// authoritative repair pass: it can correct a row that drifted EITHER way,
// so it stays correct when run repeatedly rather than only working once
// against an all-false starting state.
export async function recomputeAllTbrOwnership(): Promise<TbrOwnershipRecomputeResult> {
  const [tbrItems, books] = await Promise.all([
    prisma.goodreadsTbrItem.findMany({ select: { id: true, title: true, owned: true } }),
    prisma.book.findMany({ select: { title: true } }),
  ]);
  const ownedTitles = books.map((b) => b.title);

  // Only rows whose value actually changes are written -- a repeat run over
  // an already-correct table issues no UPDATE at all.
  const toOwned: string[] = [];
  const toUnowned: string[] = [];
  for (const item of tbrItems) {
    const owned = ownedTitles.some((title) => isTitleMatch(item.title, title));
    if (owned && !item.owned) toOwned.push(item.id);
    else if (!owned && item.owned) toUnowned.push(item.id);
  }

  if (toOwned.length > 0) {
    await prisma.goodreadsTbrItem.updateMany({
      where: { id: { in: toOwned } },
      data: { owned: true },
    });
  }
  if (toUnowned.length > 0) {
    await prisma.goodreadsTbrItem.updateMany({
      where: { id: { in: toUnowned } },
      data: { owned: false },
    });
  }

  return {
    total: tbrItems.length,
    markedOwned: toOwned.length,
    markedUnowned: toUnowned.length,
  };
}

// `query` is applied in-memory, after the DB query, against the full
// (already sorted) gap list -- filtering ~800 items in-process is cheap, and
// avoids a per-query DB round trip for what would otherwise be an unbounded
// set of possible query strings.
export async function getTbrGap(query?: string): Promise<TbrGapItem[]> {
  const gap = await computeTbrGap();

  const trimmed = query?.trim().toLowerCase();
  if (!trimmed) return gap;

  // Mirrors search.ts's isbn-shaped-query detection: reusing the same
  // already-lowercased `trimmed` is safe here because normalizeIsbn
  // uppercases internally regardless of input case, and the regex already
  // treats X/x equivalently.
  const looksLikeIsbnQuery = /^[0-9Xx\s-]+$/.test(trimmed);
  const normalizedIsbnQuery = looksLikeIsbnQuery ? normalizeIsbn(trimmed) : "";

  return gap.filter(
    (item) =>
      item.title.toLowerCase().includes(trimmed) ||
      (item.author?.toLowerCase().includes(trimmed) ?? false) ||
      (normalizedIsbnQuery !== "" &&
        item.isbn !== null &&
        normalizeIsbn(item.isbn).includes(normalizedIsbnQuery)),
  );
}

export interface TbrGapGroup {
  letter: string;
  items: TbrGapItem[];
}

// Assumes `items` is already sorted by the same sortKey used here (true for
// whatever getTbrGap returns) -- this only groups, it doesn't re-sort, so
// each group's items stay in the order they arrived in.
export function groupByInitial(items: TbrGapItem[]): TbrGapGroup[] {
  const groups = new Map<string, TbrGapItem[]>();
  for (const item of items) {
    const letter = letterBucket(sortKey(item));
    const group = groups.get(letter);
    if (group) {
      group.push(item);
    } else {
      groups.set(letter, [item]);
    }
  }

  const letters = [...groups.keys()].sort((a, b) => {
    if (a === "#") return 1;
    if (b === "#") return -1;
    return a.localeCompare(b);
  });
  return letters.map((letter) => ({ letter, items: groups.get(letter)! }));
}
