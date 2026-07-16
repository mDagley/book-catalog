import { prisma } from "@/lib/prisma";
import { saveCoverImage, SAFE_COVER_FILENAME } from "@/lib/coverStorage";
import { titleMatchScore, DEFAULT_MATCH_THRESHOLD } from "@/lib/matching";

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

  // Fuzzy title match fallback: a physical edition's ISBN almost always
  // differs from an ebook/audiobook edition's ISBN, so the ISBN check above
  // alone can't find a book you already own digitally when scanning in a
  // physical copy of the same title -- without this, every such scan would
  // create a duplicate Book row instead of attaching to the existing one.
  // Mirrors the same fuzzy-match-then-attach pattern absSync.ts already uses
  // for ABS items. As with that, the matched book's title/author/isbn are
  // never overwritten here, both to protect a good existing title from a
  // differently-formatted scan input, and to limit the damage of a
  // false-positive fuzzy match.
  const candidates = await prisma.book.findMany({ select: { id: true, title: true } });
  let titleMatch: { id: string; title: string } | null = null;
  let bestScore = -1;
  for (const candidate of candidates) {
    const score = titleMatchScore(candidate.title, title);
    if (score >= DEFAULT_MATCH_THRESHOLD && score > bestScore) {
      titleMatch = candidate;
      bestScore = score;
    }
  }
  if (titleMatch) {
    await prisma.physicalCopy.create({
      data: { ...copyData, bookId: titleMatch.id },
    });
    return { bookId: titleMatch.id };
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
// restrict fetches to Open Library's covers CDN (and its known redirect targets
// below) to avoid SSRF.
//
// archive.org (and its subdomains) are included because covers.openlibrary.org's
// own redirects land there for a real subset of covers -- confirmed against the
// live API, a cover can 302 twice: covers.openlibrary.org -> archive.org's bulk
// cover-zip storage (e.g. https://archive.org/download/m_covers_0008/....zip/....jpg)
// -> a specific numbered storage shard (e.g. https://ia600703.us.archive.org/...).
// That shard subdomain varies per item/availability, so a fixed hostname list
// isn't possible -- any *.archive.org subdomain must be allowed, not just the
// bare domain. Without this, picking the Open Library cover for exactly those
// books failed with "Unsupported cover image host" even though nothing was
// actually wrong.
function isAllowedCoverHost(hostname: string): boolean {
  return (
    hostname === "covers.openlibrary.org" ||
    hostname === "archive.org" ||
    hostname.endsWith(".archive.org")
  );
}

// Confirmed against the live API: a real cover can need two redirect hops
// (covers.openlibrary.org -> archive.org/download/... -> a numbered
// ia*.us.archive.org shard) before reaching the actual image. One hop
// wasn't enough -- reported in practice as "Unsupported cover image host"
// (rejected at the second hop, before this fix widened the host check) even
// for real, working ISBNs. Follow up to three hops, re-validating the
// destination against the same allowlist each time, rather than flatly
// rejecting a redirect chain past the first hop.
const MAX_COVER_FETCH_REDIRECTS = 3;

function isAllowedCoverUrl(url: string): boolean {
  try {
    const { hostname, protocol } = new URL(url);
    return protocol === "https:" && isAllowedCoverHost(hostname);
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
