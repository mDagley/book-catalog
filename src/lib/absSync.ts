// src/lib/absSync.ts
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { normalizeIsbn } from "@/lib/books";
import { findBestTitleMatch } from "@/lib/matching";

// True when `err` is specifically a Postgres unique-constraint violation on
// absItemId -- meaning a concurrent sync run (cron overlapping a manual
// refresh) already linked this exact ABS item to a book between this pass's
// initial already-linked check and this write. That's not a real error,
// just a race this pass lost; the item is already correctly linked
// somewhere. Narrowed to the absItemId constraint specifically (rather than
// any P2002) so an unrelated uniqueness violation doesn't get silently
// swallowed here. The driver-adapter error's constraint field names are
// double-quoted column identifiers (e.g. `"absItemId"`), confirmed against
// a real constraint violation on this project's Postgres adapter.
function isConcurrentAbsItemLink(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") return false;
  const meta = err.meta as
    | { driverAdapterError?: { cause?: { constraint?: { fields?: string[] } } } }
    | undefined;
  const fields = meta?.driverAdapterError?.cause?.constraint?.fields ?? [];
  return fields.some((f) => f.replace(/"/g, "") === "absItemId");
}

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
}

const SYNC_BOOK_SELECT = { id: true, title: true } as const;

// Creates one EbookCopy/AudiobookCopy row for this item WITHOUT touching the
// matched book's title/author/isbn -- per the design spec, ABS metadata is
// never written onto an existing Book, both to avoid a differently-formatted
// ABS title overwriting a good existing one, and to limit the damage of a
// false-positive fuzzy match. Title never changes here, so (unlike the old
// array-based version) there's nothing to refresh on the in-memory `books`
// list afterward -- only a newly CREATED book needs to be added to it.
async function linkItemToExistingBook(
  book: SyncBook,
  mediaType: AbsMediaType,
  absItemId: string,
): Promise<void> {
  if (mediaType === "EBOOK") {
    await prisma.$transaction([
      prisma.ebookCopy.create({ data: { bookId: book.id, absItemId } }),
      prisma.book.update({
        where: { id: book.id },
        data: { hasEbook: true, lastAbsSyncedAt: new Date() },
      }),
    ]);
    return;
  }
  await prisma.$transaction([
    prisma.audiobookCopy.create({ data: { bookId: book.id, absItemId } }),
    prisma.book.update({
      where: { id: book.id },
      data: { hasAudiobook: true, lastAbsSyncedAt: new Date() },
    }),
  ]);
}

async function createBookForItem(item: AbsBookItem, mediaType: AbsMediaType): Promise<SyncBook> {
  if (mediaType === "EBOOK") {
    return prisma.book.create({
      data: {
        title: item.title,
        author: item.author,
        isbn: item.isbn,
        hasEbook: true,
        lastAbsSyncedAt: new Date(),
        ebookCopies: { create: { absItemId: item.absItemId } },
      },
      select: SYNC_BOOK_SELECT,
    });
  }
  return prisma.book.create({
    data: {
      title: item.title,
      author: item.author,
      isbn: item.isbn,
      hasAudiobook: true,
      lastAbsSyncedAt: new Date(),
      audiobookCopies: { create: { absItemId: item.absItemId } },
    },
    select: SYNC_BOOK_SELECT,
  });
}

// Deletes any EbookCopy/AudiobookCopy row whose ABS item ID wasn't seen in
// this sync pass, then recomputes hasEbook/hasAudiobook for every book that
// actually lost a row, deleting the Book entirely if it ends up with no
// ebook copies, no audiobook copies, and no physical copies -- mirroring the
// zero-copy cleanup already established for physical-only books. A book
// that had no rows deleted is never touched at all (no wasted writes),
// naturally preserving the old array-based code's "unchanged: skip"
// optimization.
//
// `syncedMediaTypes` gates pruning PER media type: a media type's rows are
// only ever candidates for deletion if at least one item of that specific
// type was actually fetched this pass. This protects against two failure
// modes with one mechanism -- a library renamed/missing so it no longer
// matches the "panda ebooks"/"panda audiobooks" substrings, AND a
// correctly-matched library that happens to return zero items this pass
// (e.g. a transient ABS hiccup) -- either of which would otherwise look
// identical to "the user deleted every book of that type" and wipe real
// ownership data for a media type that was simply never confirmed this pass.
async function removeStaleAbsLinks(
  seenItemIds: Set<string>,
  syncedMediaTypes: Set<AbsMediaType>,
): Promise<void> {
  const affectedBookIds = new Set<string>();

  if (syncedMediaTypes.has("EBOOK")) {
    const staleEbookCopies = await prisma.ebookCopy.findMany({
      where: { absItemId: { notIn: Array.from(seenItemIds) } },
      select: { id: true, bookId: true },
    });
    if (staleEbookCopies.length > 0) {
      await prisma.ebookCopy.deleteMany({
        where: { id: { in: staleEbookCopies.map((c) => c.id) } },
      });
      for (const c of staleEbookCopies) affectedBookIds.add(c.bookId);
    }
  }

  if (syncedMediaTypes.has("AUDIOBOOK")) {
    const staleAudiobookCopies = await prisma.audiobookCopy.findMany({
      where: { absItemId: { notIn: Array.from(seenItemIds) } },
      select: { id: true, bookId: true },
    });
    if (staleAudiobookCopies.length > 0) {
      await prisma.audiobookCopy.deleteMany({
        where: { id: { in: staleAudiobookCopies.map((c) => c.id) } },
      });
      for (const c of staleAudiobookCopies) affectedBookIds.add(c.bookId);
    }
  }

  if (affectedBookIds.size === 0) return;
  const affectedIds = Array.from(affectedBookIds);

  // Aggregated per-table (one query each, not one per book) instead of
  // three count() queries per affected book -- a sync that drops stale
  // links for many books at once would otherwise fire 3xN queries here.
  const [ebookGroups, audiobookGroups, physicalGroups] = await Promise.all([
    prisma.ebookCopy.groupBy({
      by: ["bookId"],
      where: { bookId: { in: affectedIds } },
      _count: { bookId: true },
    }),
    prisma.audiobookCopy.groupBy({
      by: ["bookId"],
      where: { bookId: { in: affectedIds } },
      _count: { bookId: true },
    }),
    prisma.physicalCopy.groupBy({
      by: ["bookId"],
      where: { bookId: { in: affectedIds } },
      _count: { bookId: true },
    }),
  ]);
  const ebookCounts = new Map(ebookGroups.map((g) => [g.bookId, g._count.bookId]));
  const audiobookCounts = new Map(audiobookGroups.map((g) => [g.bookId, g._count.bookId]));
  const physicalCounts = new Map(physicalGroups.map((g) => [g.bookId, g._count.bookId]));

  for (const bookId of affectedIds) {
    const ebookCount = ebookCounts.get(bookId) ?? 0;
    const audiobookCount = audiobookCounts.get(bookId) ?? 0;
    const physicalCount = physicalCounts.get(bookId) ?? 0;

    if (ebookCount === 0 && audiobookCount === 0 && physicalCount === 0) {
      await prisma.book.delete({ where: { id: bookId } });
      continue;
    }

    await prisma.book.update({
      where: { id: bookId },
      data: {
        hasEbook: ebookCount > 0,
        hasAudiobook: audiobookCount > 0,
        lastAbsSyncedAt: new Date(),
      },
    });
  }
}

// Syncs the "Panda EBooks" and "Panda Audiobooks" ABS libraries directly onto
// Book rows (see docs/superpowers/specs/2026-07-14-catalog-data-model-unification-design.md
// and docs/superpowers/specs/2026-07-16-unify-copy-types-design.md).
// All ABS API calls happen before any database write, so a fetch failure
// partway through throws without touching the database at all.
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

  // A sync that fetched zero items at all is treated as suspicious rather
  // than "the user deleted their whole ABS ebook/audiobook collection" --
  // running the removal pass here would strip every currently-linked Book
  // and delete every ebook/audiobook-only Book in one shot, which is a much
  // likelier sign of a misconfigured library name or a transient ABS hiccup
  // than a real mass deletion. Skip straight to a no-op instead.
  if (pendingItems.length === 0) {
    return { synced: 0 };
  }

  const books: SyncBook[] = await prisma.book.findMany({ select: SYNC_BOOK_SELECT });

  const [existingEbookCopies, existingAudiobookCopies] = await Promise.all([
    prisma.ebookCopy.findMany({ select: { absItemId: true } }),
    prisma.audiobookCopy.findMany({ select: { absItemId: true } }),
  ]);
  const linkedEbookIds = new Set<string>(existingEbookCopies.map((c) => c.absItemId));
  const linkedAudiobookIds = new Set<string>(existingAudiobookCopies.map((c) => c.absItemId));
  const linkedIdSetFor = (mediaType: AbsMediaType): Set<string> =>
    mediaType === "EBOOK" ? linkedEbookIds : linkedAudiobookIds;

  const seenItemIds = new Set<string>();
  let synced = 0;

  for (const { item, mediaType } of pendingItems) {
    seenItemIds.add(item.absItemId);

    const linkedIds = linkedIdSetFor(mediaType);
    if (linkedIds.has(item.absItemId)) {
      synced++;
      continue;
    }

    try {
      const match = findBestTitleMatch(books, item.title);
      if (match) {
        await linkItemToExistingBook(match, mediaType, item.absItemId);
      } else {
        const created = await createBookForItem(item, mediaType);
        books.push(created);
      }
    } catch (err) {
      if (!isConcurrentAbsItemLink(err)) throw err;
    }
    linkedIds.add(item.absItemId);

    synced++;
  }

  const syncedMediaTypes = new Set<AbsMediaType>(pendingItems.map((p) => p.mediaType));

  await removeStaleAbsLinks(seenItemIds, syncedMediaTypes);

  return { synced };
}
