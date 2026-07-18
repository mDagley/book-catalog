import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { deleteCopy } from "@/lib/actions/copies";
import {
  updateReadStatus,
  updateRating,
  clearReadStatusManual,
  clearRatingManual,
} from "@/lib/actions/readingProgress";
import { FORMAT_LABELS } from "@/components/CopyFormFields";
import { READ_STATUS_OPTIONS, RATING_OPTIONS } from "@/components/ReadingProgressFields";

export default async function BookDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const book = await prisma.book.findUnique({
    where: { id },
    include: {
      copies: { orderBy: { createdAt: "asc" } },
      ebookCopies: { orderBy: { createdAt: "asc" } },
      audiobookCopies: { orderBy: { createdAt: "asc" } },
    },
  });

  if (!book) {
    notFound();
  }

  return (
    <main className="mx-auto max-w-2xl p-4">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">{book.title}</h1>
          {book.author && <p className="text-gray-600">{book.author}</p>}
          {book.isbn && <p className="text-sm text-gray-500">ISBN: {book.isbn}</p>}
        </div>
        <Link href={`/books/${book.id}/edit`} className="rounded border px-3 py-2 text-sm">
          Edit
        </Link>
      </div>

      <div className="mb-4 space-y-2 rounded border p-3">
        <div className="flex flex-wrap items-center gap-2">
          <form action={updateReadStatus.bind(null, book.id)} className="flex items-center gap-2">
            <label htmlFor="readStatus" className="text-sm font-medium">
              Status
            </label>
            <select
              id="readStatus"
              name="readStatus"
              defaultValue={book.readStatus ?? ""}
              className="rounded border p-1 text-sm"
            >
              <option value="">Not set</option>
              {READ_STATUS_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <button type="submit" className="rounded border px-2 py-1 text-sm">
              Save
            </button>
          </form>
          <span className="text-xs text-gray-500">
            {book.readStatusManual ? "Manually set" : "Synced from Goodreads"}
          </span>
          {book.readStatusManual && (
            <form action={clearReadStatusManual.bind(null, book.id)}>
              <button type="submit" className="text-xs underline">
                Let Goodreads manage this again
              </button>
            </form>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <form action={updateRating.bind(null, book.id)} className="flex items-center gap-2">
            <label htmlFor="rating" className="text-sm font-medium">
              Rating
            </label>
            <select
              id="rating"
              name="rating"
              defaultValue={book.rating?.toString() ?? ""}
              className="rounded border p-1 text-sm"
            >
              <option value="">Unrated</option>
              {RATING_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n} {n === 1 ? "star" : "stars"}
                </option>
              ))}
            </select>
            <button type="submit" className="rounded border px-2 py-1 text-sm">
              Save
            </button>
          </form>
          <span className="text-xs text-gray-500">
            {book.ratingManual ? "Manually set" : "Synced from Goodreads"}
          </span>
          {book.ratingManual && (
            <form action={clearRatingManual.bind(null, book.id)}>
              <button type="submit" className="text-xs underline">
                Let Goodreads manage this again
              </button>
            </form>
          )}
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-medium">Copies ({book.copies.length})</h2>
        <Link
          href={`/books/${book.id}/copies/new`}
          className="rounded bg-black px-3 py-2 text-sm text-white"
        >
          + Add a copy
        </Link>
      </div>

      <ul className="space-y-3">
        {book.copies.map((copy) => (
          <li key={copy.id} className="rounded border p-3">
            <p className="font-medium">{FORMAT_LABELS[copy.format]}</p>
            {copy.publisher && <p className="text-sm text-gray-600">{copy.publisher}</p>}
            {copy.publishYear && <p className="text-sm text-gray-600">{copy.publishYear}</p>}
            {copy.specialNotes && <p className="text-sm text-gray-600">{copy.specialNotes}</p>}
            {copy.coverImagePath && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/api/covers/${encodeURIComponent(copy.coverImagePath)}`}
                alt="Cover"
                className="mt-2 h-32 w-24 rounded object-cover"
              />
            )}
            <div className="mt-2 flex gap-2">
              <Link
                href={`/books/${book.id}/copies/${copy.id}/edit`}
                className="text-sm underline"
              >
                Edit
              </Link>
              <form action={deleteCopy.bind(null, copy.id)}>
                <button type="submit" className="text-sm text-red-600 underline">
                  Delete
                </button>
              </form>
            </div>
          </li>
        ))}
      </ul>

      {book.ebookCopies.length > 0 && (
        <>
          <h2 className="mb-2 mt-6 text-lg font-medium">Ebooks ({book.ebookCopies.length})</h2>
          <ul className="space-y-3">
            {book.ebookCopies.map((copy) => (
              <li key={copy.id} className="rounded border p-3">
                {copy.coverImagePath ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/api/covers/${encodeURIComponent(copy.coverImagePath)}`}
                    alt="Cover"
                    className="h-32 w-24 rounded object-cover"
                  />
                ) : (
                  <p className="text-sm text-gray-600">No cover set.</p>
                )}
                <Link
                  href={`/books/${book.id}/ebook-copies/${copy.id}/edit`}
                  className="mt-2 inline-block text-sm underline"
                >
                  Edit cover
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}

      {book.audiobookCopies.length > 0 && (
        <>
          <h2 className="mb-2 mt-6 text-lg font-medium">
            Audiobooks ({book.audiobookCopies.length})
          </h2>
          <ul className="space-y-3">
            {book.audiobookCopies.map((copy) => (
              <li key={copy.id} className="rounded border p-3">
                {copy.coverImagePath ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/api/covers/${encodeURIComponent(copy.coverImagePath)}`}
                    alt="Cover"
                    className="h-32 w-24 rounded object-cover"
                  />
                ) : (
                  <p className="text-sm text-gray-600">No cover set.</p>
                )}
                <Link
                  href={`/books/${book.id}/audiobook-copies/${copy.id}/edit`}
                  className="mt-2 inline-block text-sm underline"
                >
                  Edit cover
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
