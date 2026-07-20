import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { EditBookForm } from "./EditBookForm";
import { EditCopyForm } from "@/components/EditCopyForm";
import { EditEbookCopyCoverForm } from "@/components/EditEbookCopyCoverForm";
import { EditAudiobookCopyCoverForm } from "@/components/EditAudiobookCopyCoverForm";
import {
  updateReadStatus,
  updateRating,
  clearReadStatusManual,
  clearRatingManual,
} from "@/lib/actions/readingProgress";
import { READ_STATUS_OPTIONS, RATING_OPTIONS } from "@/components/ReadingProgressFields";

export default async function EditBookPage({
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
    <main className="mx-auto max-w-lg space-y-8 p-4">
      <div>
        <h1 className="mb-4 text-2xl font-semibold">Edit Book</h1>
        <EditBookForm
          bookId={book.id}
          defaultTitle={book.title}
          defaultAuthor={book.author ?? ""}
          defaultIsbn={book.isbn ?? ""}
        />
      </div>

      <div className="space-y-2 rounded border p-3">
        <h2 className="text-lg font-medium">Reading Progress</h2>
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

      {book.copies.length > 0 && (
        <div>
          <h2 className="mb-2 text-lg font-medium">Physical Copies</h2>
          <div className="space-y-6">
            {book.copies.map((copy, index) => (
              <div key={copy.id} id={`copy-${copy.id}`} className="scroll-mt-4 rounded border p-3">
                <h3 className="mb-2 text-sm font-semibold text-gray-700">
                  Physical Copy #{index + 1}
                </h3>
                <EditCopyForm
                  copyId={copy.id}
                  bookId={book.id}
                  defaultFormat={copy.format}
                  defaultPublisher={copy.publisher ?? ""}
                  defaultPublishYear={copy.publishYear?.toString() ?? ""}
                  defaultSpecialNotes={copy.specialNotes ?? ""}
                  currentCoverPath={copy.coverImagePath}
                  bookIsbn={book.isbn}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {book.ebookCopies.length > 0 && (
        <div>
          <h2 className="mb-2 text-lg font-medium">Ebooks</h2>
          <div className="space-y-6">
            {book.ebookCopies.map((copy, index) => (
              <div key={copy.id} id={`copy-${copy.id}`} className="scroll-mt-4 rounded border p-3">
                <h3 className="mb-2 text-sm font-semibold text-gray-700">
                  Ebook #{index + 1}
                </h3>
                <EditEbookCopyCoverForm
                  copyId={copy.id}
                  bookId={book.id}
                  currentCoverPath={copy.coverImagePath}
                  bookIsbn={book.isbn}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {book.audiobookCopies.length > 0 && (
        <div>
          <h2 className="mb-2 text-lg font-medium">Audiobooks</h2>
          <div className="space-y-6">
            {book.audiobookCopies.map((copy, index) => (
              <div key={copy.id} id={`copy-${copy.id}`} className="scroll-mt-4 rounded border p-3">
                <h3 className="mb-2 text-sm font-semibold text-gray-700">
                  Audiobook #{index + 1}
                </h3>
                <EditAudiobookCopyCoverForm
                  copyId={copy.id}
                  bookId={book.id}
                  currentCoverPath={copy.coverImagePath}
                  bookIsbn={book.isbn}
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </main>
  );
}
