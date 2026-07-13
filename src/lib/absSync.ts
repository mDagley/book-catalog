// src/lib/absSync.ts
import { prisma } from "@/lib/prisma";
import type { MediaType } from "@prisma/client";

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

const MAX_PAGES = 500; // 500 * 100 = 50,000 items per library, matching the
// audiobook-compare reference script's own safety cap.
const PAGE_LIMIT = 100;

const LIBRARY_MEDIA_TYPES: Record<string, MediaType> = {
  "panda ebooks": "EBOOK",
  "panda audiobooks": "AUDIOBOOK",
};

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
      allItems.push({
        absItemId: item.id,
        title: metadata.title ?? "",
        author: metadata.authorName ?? null,
        isbn: metadata.isbn ?? null,
      });
    }

    if (allItems.length >= (data.total ?? Infinity)) break;
  }

  return allItems;
}

// Upserts every item from the "Panda EBooks" and "Panda Audiobooks" libraries
// into AbsCacheItem, keyed on absItemId. Does NOT delete cache rows for items
// no longer present in ABS (unlike the Goodreads TBR sync, which does a full
// replace) — per the design spec, ABS sync is upsert-only.
export async function syncAbsCache(
  baseUrl: string,
  token: string,
): Promise<{ synced: number }> {
  const libraries = await fetchAbsLibraries(baseUrl, token);
  let synced = 0;

  for (const library of libraries) {
    const mediaType = LIBRARY_MEDIA_TYPES[library.name.toLowerCase()];
    if (!mediaType) continue;

    const items = await fetchAbsLibraryItems(baseUrl, token, library.id);
    for (const item of items) {
      await prisma.absCacheItem.upsert({
        where: { absItemId: item.absItemId },
        create: {
          absItemId: item.absItemId,
          title: item.title,
          author: item.author,
          isbn: item.isbn,
          mediaType,
        },
        update: {
          title: item.title,
          author: item.author,
          isbn: item.isbn,
          mediaType,
          lastSyncedAt: new Date(),
        },
      });
      synced++;
    }
  }

  return { synced };
}
