// src/lib/absSync.ts
import { prisma } from "@/lib/prisma";
import { normalizeIsbn } from "@/lib/books";
import { titleMatchScore, DEFAULT_MATCH_THRESHOLD } from "@/lib/matching";

export interface AbsLibrary {
  id: string;
  name: string;
}

export interface AbsBookItem {
  absItemId: string;
  title: string;
  author: string | null;
  isbn: string | null;
}

type AbsMediaType = "EBOOK" | "AUDIOBOOK";

const MAX_PAGES = 500; // 500 * 100 = 50,000 items per library, matching the
// audiobook-compare reference script's own safety cap.
const PAGE_LIMIT = 100;

const LIBRARY_NAME_SUBSTRINGS: [string, AbsMediaType][] = [
  ["panda ebooks", "EBOOK"],
  ["panda audiobooks", "AUDIOBOOK"],
];

// Case-insensitive SUBSTRING match, not exact match — mirrors the reference
// audiobook-compare/list_libraries.py script's own name-filtering behavior,
// so a library named e.g. "Panda EBooks (Archive)" still syncs rather than
// being silently skipped over a naming variation.
function getMediaTypeForLibrary(libraryName: string): AbsMediaType | null {
  const lower = libraryName.toLowerCase();
  for (const [substring, mediaType] of LIBRARY_NAME_SUBSTRINGS) {
    if (lower.includes(substring)) return mediaType;
  }
  return null;
}

export async function fetchAbsLibraries(baseUrl: string, token: string): Promise<AbsLibrary[]> {
  const response = await fetch(`${baseUrl}/api/libraries`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch ABS libraries: HTTP ${response.status}`);
  }
  const data = await response.json();
  return (data.libraries ?? []).map((lib: { id: string; name: string }) => ({
    id: lib.id,
    name: lib.name,
  }));
}

export async function fetchAbsLibraryItems(
  baseUrl: string,
  token: string,
  libraryId: string,
): Promise<AbsBookItem[]> {
  const headers = { Authorization: `Bearer ${token}` };
  const allItems: AbsBookItem[] = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${baseUrl}/api/libraries/${libraryId}/items?limit=${PAGE_LIMIT}&page=${page}`;
    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(
        `Failed to fetch ABS library items (library ${libraryId}, page ${page}): HTTP ${response.status}`,
      );
    }
    const data = await response.json();
    const results = data.results ?? [];
    if (results.length === 0) break;

    for (const item of results) {
      const metadata = item.media?.metadata ?? {};
      const title = typeof metadata.title === "string" ? metadata.title.trim() : "";
      if (!title) continue;
      allItems.push({
        absItemId: item.id,
        title,
        author: metadata.authorName ?? null,
        isbn:
          typeof metadata.isbn === "string" || typeof metadata.isbn === "number"
            ? normalizeIsbn(String(metadata.isbn)) || null
            : null,
      });
    }

    if (allItems.length >= (data.total ?? Infinity)) break;
  }

  return allItems;
}

interface SyncBook {
  id: string;
  title: string;
  absEbookItemIds: string[];
  absAudiobookItemIds: string[];
}

const SYNC_BOOK_SELECT = {
  id: true,
  title: true,
  absEbookItemIds: true,
  absAudiobookItemIds: true,
} as const;

function isLinked(book: SyncBook, mediaType: AbsMediaType, absItemId: string): boolean {
  const ids = mediaType === "EBOOK" ? book.absEbookItemIds : book.absAudiobookItemIds;
  return ids.includes(absItemId);
}

function findBestTitleMatch(books: SyncBook[], title: string): SyncBook | null {
  let best: SyncBook | null = null;
  let bestScore = -1;
  for (const book of books) {
    const score = titleMatchScore(book.title, title);
    if (score >= DEFAULT_MATCH_THRESHOLD && score > bestScore) {
      best = book;
      bestScore = score;
    }
  }
  return best;
}

// Appends this item's ID onto the matched book's array WITHOUT touching its
// title/author/isbn -- per the design spec, ABS metadata is never written
// onto an existing Book, both to avoid a differently-formatted ABS title
// overwriting a good existing one, and to limit the damage of a false-
// positive fuzzy match.
async function linkItemToExistingBook(
  book: SyncBook,
  mediaType: AbsMediaType,
  absItemId: string,
): Promise<SyncBook> {
  if (mediaType === "EBOOK") {
    return prisma.book.update({
      where: { id: book.id },
      data: { absEbookItemIds: { push: absItemId }, hasEbook: true, lastAbsSyncedAt: new Date() },
      select: SYNC_BOOK_SELECT,
    });
  }
  return prisma.book.update({
    where: { id: book.id },
    data: {
      absAudiobookItemIds: { push: absItemId },
      hasAudiobook: true,
      lastAbsSyncedAt: new Date(),
    },
    select: SYNC_BOOK_SELECT,
  });
}

async function createBookForItem(item: AbsBookItem, mediaType: AbsMediaType): Promise<SyncBook> {
  if (mediaType === "EBOOK") {
    return prisma.book.create({
      data: {
        title: item.title,
        author: item.author,
        absEbookItemIds: [item.absItemId],
        hasEbook: true,
        lastAbsSyncedAt: new Date(),
      },
      select: SYNC_BOOK_SELECT,
    });
  }
  return prisma.book.create({
    data: {
      title: item.title,
      author: item.author,
      absAudiobookItemIds: [item.absItemId],
      hasAudiobook: true,
      lastAbsSyncedAt: new Date(),
    },
    select: SYNC_BOOK_SELECT,
  });
}

// Drops any previously-linked ABS item ID not seen in this sync pass, then
// deletes any Book left with no ebook links, no audiobook links, and no
// physical copies -- mirroring the zero-copy cleanup already established for
// physical-only books (a Book backed by nothing shouldn't exist), except an
// ebook/audiobook-only Book with zero physical copies is now a normal state,
// not a defensive-only edge case.
async function removeStaleAbsLinks(seenItemIds: Set<string>): Promise<void> {
  const booksWithAbsLinks = await prisma.book.findMany({
    where: {
      OR: [{ absEbookItemIds: { isEmpty: false } }, { absAudiobookItemIds: { isEmpty: false } }],
    },
    select: {
      id: true,
      absEbookItemIds: true,
      absAudiobookItemIds: true,
      _count: { select: { copies: true } },
    },
  });

  for (const book of booksWithAbsLinks) {
    const remainingEbookIds = book.absEbookItemIds.filter((id) => seenItemIds.has(id));
    const remainingAudiobookIds = book.absAudiobookItemIds.filter((id) => seenItemIds.has(id));

    const unchanged =
      remainingEbookIds.length === book.absEbookItemIds.length &&
      remainingAudiobookIds.length === book.absAudiobookItemIds.length;
    if (unchanged) continue;

    const stillOwned =
      remainingEbookIds.length > 0 || remainingAudiobookIds.length > 0 || book._count.copies > 0;

    if (!stillOwned) {
      await prisma.book.delete({ where: { id: book.id } });
      continue;
    }

    await prisma.book.update({
      where: { id: book.id },
      data: {
        absEbookItemIds: remainingEbookIds,
        absAudiobookItemIds: remainingAudiobookIds,
        hasEbook: remainingEbookIds.length > 0,
        hasAudiobook: remainingAudiobookIds.length > 0,
      },
    });
  }
}

// Syncs the "Panda EBooks" and "Panda Audiobooks" ABS libraries directly onto
// Book rows (see docs/superpowers/specs/2026-07-14-catalog-data-model-unification-design.md).
// All ABS API calls happen before any database write, so a fetch failure
// partway through (e.g. the audiobook library's API call rejecting after the
// ebook library already succeeded) throws without touching the database at
// all -- matching the previous cache-table sync's same guarantee.
export async function syncAbsCache(baseUrl: string, token: string): Promise<{ synced: number }> {
  const libraries = await fetchAbsLibraries(baseUrl, token);

  const relevantLibraries = libraries
    .map((lib) => ({ lib, mediaType: getMediaTypeForLibrary(lib.name) }))
    .filter(
      (entry): entry is { lib: AbsLibrary; mediaType: AbsMediaType } => entry.mediaType !== null,
    );

  const pendingItems: { item: AbsBookItem; mediaType: AbsMediaType }[] = [];
  for (const { lib, mediaType } of relevantLibraries) {
    const items = await fetchAbsLibraryItems(baseUrl, token, lib.id);
    for (const item of items) {
      pendingItems.push({ item, mediaType });
    }
  }

  const books: SyncBook[] = await prisma.book.findMany({ select: SYNC_BOOK_SELECT });

  const seenItemIds = new Set<string>();
  let synced = 0;

  for (const { item, mediaType } of pendingItems) {
    seenItemIds.add(item.absItemId);

    const alreadyLinked = books.some((book) => isLinked(book, mediaType, item.absItemId));
    if (alreadyLinked) {
      synced++;
      continue;
    }

    const match = findBestTitleMatch(books, item.title);
    if (match) {
      const updated = await linkItemToExistingBook(match, mediaType, item.absItemId);
      books[books.findIndex((b) => b.id === updated.id)] = updated;
    } else {
      const created = await createBookForItem(item, mediaType);
      books.push(created);
    }

    synced++;
  }

  await removeStaleAbsLinks(seenItemIds);

  return { synced };
}
