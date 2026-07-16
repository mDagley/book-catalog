import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { parseFormatParam } from "@/lib/search";
import { normalizeIsbn } from "@/lib/books";
import { FORMAT_OPTIONS } from "@/components/CopyFormFields";

export default async function BooksPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; format?: string }>;
}) {
  const { q, format: formatParam } = await searchParams;
  const query = q?.trim() || "";
  const format = parseFormatParam(formatParam);

  // Book.isbn is always stored normalized (digits + uppercase X only, no
  // hyphens/spaces) -- mirror the same isbn-shaped guard + normalization
  // searchCatalog (src/lib/search.ts) already uses, so a hyphenated ISBN
  // typed here still matches, and a query with no digits/X never
  // spuriously matches every row via an empty-string `contains`.
  const looksLikeIsbnQuery = /^[0-9Xx\s-]+$/.test(query);
  const normalizedIsbnQuery = query && looksLikeIsbnQuery ? normalizeIsbn(query) : "";

  const books = await prisma.book.findMany({
    where: {
      ...(query
        ? {
            OR: [
              { title: { contains: query, mode: "insensitive" } },
              { author: { contains: query, mode: "insensitive" } },
              ...(normalizedIsbnQuery
                ? [{ isbn: { contains: normalizedIsbnQuery, mode: "insensitive" as const } }]
                : []),
            ],
          }
        : {}),
      ...(format ? { copies: { some: { format } } } : {}),
    },
    include: { copies: true },
    orderBy: { title: "asc" },
  });

  return (
    <main className="mx-auto max-w-2xl p-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Physical Books</h1>
        <Link href="/books/scan" className="rounded bg-black px-3 py-2 text-sm text-white">
          + Add a book
        </Link>
      </div>

      <div className="mb-4 text-sm">
        <Link href="/books/duplicates" className="underline">
          Check for duplicate books
        </Link>
      </div>

      <form action="/books" method="get" className="mb-4 space-y-2">
        <input
          type="text"
          name="q"
          defaultValue={query}
          placeholder="Search by title, author, or ISBN"
          className="w-full rounded border p-2"
        />
        <div className="flex items-center gap-2 text-sm">
          <select
            name="format"
            defaultValue={format ?? ""}
            className="rounded border p-1"
            aria-label="Filter by physical format"
          >
            <option value="">Any format</option>
            {FORMAT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <button type="submit" className="rounded bg-black px-3 py-1 text-white">
            Search
          </button>
        </div>
      </form>

      {books.length === 0 ? (
        <p className="text-gray-600">No books found.</p>
      ) : (
        <ul className="space-y-3">
          {books.map((book) => (
            <li key={book.id} className="rounded border p-3">
              <Link href={`/books/${book.id}`} className="font-medium hover:underline">
                {book.title}
              </Link>
              {book.author && <p className="text-sm text-gray-600">{book.author}</p>}
              <p className="text-sm text-gray-500">
                {book.copies.length} {book.copies.length === 1 ? "copy" : "copies"}
              </p>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
