import { prisma } from "@/lib/prisma";
import { saveCoverImage, SAFE_COVER_FILENAME } from "@/lib/coverStorage";

export interface BookFormState {
  error?: string;
}

export const VALID_FORMATS = ["HARDCOVER", "PAPERBACK", "MASS_MARKET", "OTHER"] as const;
export type BookFormat = (typeof VALID_FORMATS)[number];

interface CopyFieldsInput {
  format: string;
  publisher: string;
  publishYear: string;
  specialNotes: string;
}

interface ParsedCopyFields {
  format: BookFormat;
  publisher: string | null;
  publishYear: number | null;
  specialNotes: string | null;
}

// Normalizes an ISBN for storage/comparison: strips everything except digits
// and the ISBN-10 check digit "X", and uppercases it. This lets a manually
// typed, hyphenated ISBN (e.g. "978-0-7653-2635-5") dedup-match a bare digit
// string decoded from a barcode scan (e.g. "9780765326355"). This does not
// affect how an ISBN is displayed anywhere.
export function normalizeIsbn(raw: string): string {
  return raw.replace(/[^0-9Xx]/g, "").toUpperCase();
}

export function parseCopyFields(
  input: CopyFieldsInput,
): ParsedCopyFields | { error: string } {
  if (!VALID_FORMATS.includes(input.format as BookFormat)) {
    return { error: "A valid format is required" };
  }

  let publishYear: number | null = null;
  if (input.publishYear.trim()) {
    publishYear = parseInt(input.publishYear, 10);
    if (Number.isNaN(publishYear)) {
      return { error: "Publish year must be a number" };
    }
  }

  return {
    format: input.format as BookFormat,
    publisher: input.publisher.trim() || null,
    publishYear,
    specialNotes: input.specialNotes.trim() || null,
  };
}

export async function createBookWithCopyData(
  input: { title: string; author: string; isbn: string; coverImagePath?: string } & CopyFieldsInput,
): Promise<{ bookId: string } | { error: string }> {
  const title = input.title.trim();
  const isbn = normalizeIsbn(input.isbn) || null;

  const parsedCopy = parseCopyFields(input);
  if ("error" in parsedCopy) {
    return parsedCopy;
  }

  const coverImagePath = input.coverImagePath?.trim() || null;
  if (coverImagePath && !SAFE_COVER_FILENAME.test(coverImagePath)) {
    return { error: "Invalid cover image reference" };
  }

  const copyData = { ...parsedCopy, coverImagePath };

  // Check for an ISBN match before validating the title: a rescan that attaches
  // a new copy to an already-existing book must not require a title, since the
  // existing book's title is authoritative and is never overwritten here.
  if (isbn) {
    // Book.isbn has no unique constraint, so if duplicate rows ever share an
    // ISBN, order deterministically (oldest first) rather than letting the
    // DB pick an arbitrary match.
    const existingBook = await prisma.book.findFirst({
      where: { isbn },
      orderBy: { createdAt: "asc" },
    });
    if (existingBook) {
      await prisma.physicalCopy.create({
        data: { ...copyData, bookId: existingBook.id },
      });
      return { bookId: existingBook.id };
    }
  }

  if (!title) {
    return { error: "Title is required" };
  }

  const book = await prisma.book.create({
    data: {
      title,
      author: input.author.trim() || null,
      isbn,
      copies: { create: copyData },
    },
  });

  return { bookId: book.id };
}

// Open Library is the only source CoverPicker ever populates selectedCoverDataUrl
// from when selectedCoverSource is "url" (see src/lib/isbnLookup.ts). Since the
// form field is just a plain hidden input, a request submitted outside the normal
// UI (devtools/curl) could otherwise point the server at an arbitrary URL, so we
// restrict fetches to Open Library's covers CDN to avoid SSRF.
const ALLOWED_COVER_HOSTS = ["covers.openlibrary.org"];

// Open Library's covers CDN occasionally redirects a given size/path to a
// different URL (e.g. a specific edge shard) — reported in practice as a
// "failed to fetch cover image" error even for real, working ISBNs. Follow
// up to one hop, re-validating the destination against the same allowlist
// each time, rather than flatly rejecting any redirect.
const MAX_COVER_FETCH_REDIRECTS = 1;

function isAllowedCoverUrl(url: string): boolean {
  try {
    const { hostname, protocol } = new URL(url);
    return protocol === "https:" && ALLOWED_COVER_HOSTS.includes(hostname);
  } catch {
    return false;
  }
}

export async function saveCoverFromUrl(
  url: string,
): Promise<{ coverImagePath: string } | { error: string }> {
  try {
    let currentUrl = url;

    for (let redirects = 0; ; redirects++) {
      if (!isAllowedCoverUrl(currentUrl)) {
        return { error: "Unsupported cover image host" };
      }

      const response = await fetch(currentUrl, { redirect: "manual" });
      // Only the status codes that actually carry Location-header redirect
      // semantics — a blanket 3xx check would also match 304 Not Modified
      // (no Location header, different meaning entirely) and incorrectly
      // treat it as a redirect with a missing Location, failing the fetch.
      const isRedirect =
        response.type === "opaqueredirect" ||
        [301, 302, 303, 307, 308].includes(response.status);

      if (isRedirect) {
        const location = response.headers.get("location");
        if (!location || redirects >= MAX_COVER_FETCH_REDIRECTS) {
          return { error: "Failed to fetch cover image" };
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      if (!response.ok) {
        return { error: "Failed to fetch cover image" };
      }

      const arrayBuffer = await response.arrayBuffer();
      const rawContentType = response.headers.get("content-type") ?? "image/jpeg";
      const contentType = rawContentType.split(";")[0].trim();
      const base64 = Buffer.from(arrayBuffer).toString("base64");
      const coverImagePath = await saveCoverImage(`data:${contentType};base64,${base64}`);
      return { coverImagePath };
    }
  } catch {
    return { error: "Failed to fetch cover image" };
  }
}

export async function updateBookData(
  bookId: string,
  input: { title: string; author: string; isbn: string },
): Promise<{ ok: true } | { error: string }> {
  const title = input.title.trim();
  if (!title) {
    return { error: "Title is required" };
  }

  await prisma.book.update({
    where: { id: bookId },
    data: {
      title,
      author: input.author.trim() || null,
      isbn: normalizeIsbn(input.isbn) || null,
    },
  });

  return { ok: true };
}
