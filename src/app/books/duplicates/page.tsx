import Link from "next/link";
import { findDuplicateBookGroups } from "@/lib/duplicates";
import { mergeBooks } from "@/lib/actions/duplicates";
import { MergeButton } from "@/app/books/duplicates/MergeButton";

export const dynamic = "force-dynamic";

export default async function DuplicateBooksPage() {
  const { groups, truncated } = await findDuplicateBookGroups();

  return (
    <main className="mx-auto max-w-2xl p-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Possible Duplicate Books</h1>
        <Link href="/books" className="text-sm underline">
          Back to Physical Books
        </Link>
      </div>
      <p className="mb-4 text-sm text-gray-600">
        Books grouped here have closely-matching titles and may be the same book split across
        multiple rows (e.g. a physical copy scanned separately from an already-owned ebook or
        audiobook). Review each group and, if they really are the same book, pick the one to keep
        — its title, author, and ISBN are kept as-is; the others&apos; physical copies and
        ebook/audiobook ownership move onto it, and the other rows are removed.
      </p>
      {truncated && (
        <p className="mb-4 rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-800">
          Duplicate detection stopped early to stay fast — some duplicates may not be shown below.
          Try again later, or run this less often if it keeps happening.
        </p>
      )}

      {groups.length === 0 ? (
        <p className="text-gray-600">No likely duplicates found.</p>
      ) : (
        <ul className="space-y-6">
          {groups.map((group) => (
            <li key={group.books.map((book) => book.id).join(",")} className="rounded border p-3">
              <ul className="space-y-2">
                {group.books.map((book) => (
                  <li key={book.id} className="rounded border p-2 text-sm">
                    <p className="font-medium">{book.title}</p>
                    {book.author && <p className="text-gray-600">{book.author}</p>}
                    {book.isbn && <p className="text-gray-500">ISBN: {book.isbn}</p>}
                    <p className="text-gray-500">
                      {book.copiesCount} {book.copiesCount === 1 ? "copy" : "copies"}
                      {book.hasEbook ? ", ebook" : ""}
                      {book.hasAudiobook ? ", audiobook" : ""}
                    </p>
                    <form
                      action={mergeBooks.bind(
                        null,
                        book.id,
                        group.books.filter((other) => other.id !== book.id).map((other) => other.id),
                      )}
                    >
                      <MergeButton />
                    </form>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
