import { XMLParser } from "fast-xml-parser";
import { prisma } from "@/lib/prisma";
import { normalizeIsbn as normalizeIsbnShared } from "@/lib/books";

export interface GoodreadsBook {
  title: string;
  author: string | null;
  isbn: string | null;
}

const SHELF = "to-read";
const MAX_PAGES = 100; // matches the audiobook-compare reference script's cap

const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false });

function normalizeIsbn(raw: unknown): string | null {
  const s = typeof raw === "string" ? raw : typeof raw === "number" ? String(raw) : "";
  const normalized = normalizeIsbnShared(s);
  return normalized || null;
}

export async function fetchGoodreadsPage(userId: string, page: number): Promise<GoodreadsBook[]> {
  const url = new URL(`https://www.goodreads.com/review/list_rss/${userId}`);
  url.searchParams.set("shelf", SHELF);
  url.searchParams.set("per_page", "200");
  url.searchParams.set("page", String(page));

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      },
    });
  } catch (err) {
    throw new Error(
      `Failed to reach Goodreads for shelf page ${page}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!response.ok) {
    throw new Error(`Failed to fetch Goodreads shelf page ${page}: HTTP ${response.status}`);
  }

  let text: string;
  try {
    text = await response.text();
  } catch (err) {
    throw new Error(
      `Failed to read Goodreads response body for shelf page ${page}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let parsed;
  try {
    parsed = parser.parse(text);
  } catch {
    throw new Error(
      `Goodreads returned non-XML on page ${page} (first 200 chars: ${text.slice(0, 200)})`,
    );
  }

  if (parsed?.rss === undefined) {
    throw new Error(
      `Goodreads returned an unexpected response shape on page ${page} (missing <rss> root; first 200 chars: ${text.slice(0, 200)})`,
    );
  }

  const rawItems = parsed.rss.channel?.item;
  if (!rawItems) return [];
  const items = Array.isArray(rawItems) ? rawItems : [rawItems];

  const books: GoodreadsBook[] = [];
  for (const item of items) {
    const title = typeof item.title === "string" ? item.title.trim() : "";
    if (!title) continue;
    const author =
      typeof item.author_name === "string" && item.author_name.trim()
        ? item.author_name.trim()
        : null;
    const isbn = normalizeIsbn(item.isbn13) ?? normalizeIsbn(item.isbn);
    books.push({ title, author, isbn });
  }
  return books;
}

export async function fetchAllGoodreadsBooks(userId: string): Promise<GoodreadsBook[]> {
  const allBooks: GoodreadsBook[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const books = await fetchGoodreadsPage(userId, page);
    if (books.length === 0) break;
    allBooks.push(...books);
    if (page === MAX_PAGES) {
      console.warn(
        `Goodreads sync hit the ${MAX_PAGES}-page cap for user ${userId} with page ${MAX_PAGES} still non-empty — results may be truncated.`,
      );
    }
  }
  return allBooks;
}

// Full replace (not upsert-by-id) since Goodreads' RSS feed exposes no stable
// per-item id to key on, and a book removed from the shelf should disappear
// from the TBR gap view too — per the design spec.
export async function syncGoodreadsTbr(userId: string): Promise<{ synced: number }> {
  const books = await fetchAllGoodreadsBooks(userId);

  await prisma.$transaction([
    prisma.goodreadsTbrItem.deleteMany(),
    prisma.goodreadsTbrItem.createMany({
      data: books.map((book) => ({
        title: book.title,
        author: book.author,
        isbn: book.isbn,
      })),
    }),
  ]);

  return { synced: books.length };
}
