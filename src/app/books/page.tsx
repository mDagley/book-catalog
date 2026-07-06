import Link from "next/link";
import { prisma } from "@/lib/prisma";

export default async function BooksPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const query = q?.trim() || "";

  const books = await prisma.book.findMany({
    where: query
      ? {
          OR: [
            { title: { contains: query, mode: "insensitive" } },
            { author: { contains: query, mode: "insensitive" } },
            { isbn: { contains: query, mode: "insensitive" } },
          ],
        }
      : undefined,
    include: { copies: true },
    orderBy: { title: "asc" },
  });

  return (
    <main className="mx-auto max-w-2xl p-4">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Physical Books</h1>
        <Link href="/books/new" className="rounded bg-black px-3 py-2 text-sm text-white">
          + Add a book
        </Link>
      </div>

      <form action="/books" method="get" className="mb-4">
        <input
          type="text"
          name="q"
          defaultValue={query}
          placeholder="Search by title, author, or ISBN"
          className="w-full rounded border p-2"
        />
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
