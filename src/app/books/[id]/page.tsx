import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { deleteCopy } from "@/lib/actions/copies";
import { FORMAT_LABELS } from "@/components/CopyFormFields";
import { TicketCard } from "@/components/ui/TicketCard";
import { BUTTON_VARIANT_CLASSES } from "@/components/ui/Button";

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
          <h1 className="font-display text-2xl font-semibold text-foreground-strong">{book.title}</h1>
          {book.author && <p className="text-foreground/70">{book.author}</p>}
          {book.isbn && <p className="font-mono text-sm text-foreground/70">ISBN: {book.isbn}</p>}
        </div>
        <Link
          href={`/books/${book.id}/edit`}
          className={`rounded-lg px-3 py-2 text-sm font-medium ${BUTTON_VARIANT_CLASSES.secondary}`}
        >
          Edit
        </Link>
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-lg font-medium text-foreground-strong">
          Copies ({book.copies.length})
        </h2>
        <Link
          href={`/books/${book.id}/copies/new`}
          className={`rounded-lg px-3 py-2 text-sm font-medium ${BUTTON_VARIANT_CLASSES.primary}`}
        >
          + Add a copy
        </Link>
      </div>

      <ul className="space-y-3">
        {book.copies.map((copy) => (
          <TicketCard key={copy.id} className="p-3">
            <p className="font-medium text-foreground-strong">{FORMAT_LABELS[copy.format]}</p>
            {copy.publisher && <p className="text-sm text-foreground/70">{copy.publisher}</p>}
            {copy.publishYear && <p className="font-mono text-sm text-foreground/70">{copy.publishYear}</p>}
            {copy.specialNotes && <p className="text-sm text-foreground/70">{copy.specialNotes}</p>}
            {copy.coverImagePath && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/api/covers/${encodeURIComponent(copy.coverImagePath)}`}
                alt="Cover"
                className="mt-2 h-32 w-24 rounded object-cover"
              />
            )}
            <div className="mt-2 flex gap-2">
              <Link href={`/books/${book.id}/edit#copy-${copy.id}`} className="text-sm text-link underline">
                Edit
              </Link>
              <form action={deleteCopy.bind(null, copy.id)}>
                <button type="submit" className="text-sm text-red-600 underline">
                  Delete
                </button>
              </form>
            </div>
          </TicketCard>
        ))}
      </ul>

      {book.ebookCopies.length > 0 && (
        <>
          <h2 className="mb-2 mt-6 font-display text-lg font-medium text-foreground-strong">
            Ebooks ({book.ebookCopies.length})
          </h2>
          <ul className="space-y-3">
            {book.ebookCopies.map((copy) => (
              <TicketCard key={copy.id} className="p-3">
                {copy.coverImagePath ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/api/covers/${encodeURIComponent(copy.coverImagePath)}`}
                    alt="Cover"
                    className="h-32 w-24 rounded object-cover"
                  />
                ) : (
                  <p className="text-sm text-foreground/70">No cover set.</p>
                )}
                <Link
                  href={`/books/${book.id}/edit#copy-${copy.id}`}
                  className="mt-2 inline-block text-sm text-link underline"
                >
                  Edit cover
                </Link>
              </TicketCard>
            ))}
          </ul>
        </>
      )}

      {book.audiobookCopies.length > 0 && (
        <>
          <h2 className="mb-2 mt-6 font-display text-lg font-medium text-foreground-strong">
            Audiobooks ({book.audiobookCopies.length})
          </h2>
          <ul className="space-y-3">
            {book.audiobookCopies.map((copy) => (
              <TicketCard key={copy.id} className="p-3">
                {copy.coverImagePath ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/api/covers/${encodeURIComponent(copy.coverImagePath)}`}
                    alt="Cover"
                    className="h-32 w-24 rounded object-cover"
                  />
                ) : (
                  <p className="text-sm text-foreground/70">No cover set.</p>
                )}
                <Link
                  href={`/books/${book.id}/edit#copy-${copy.id}`}
                  className="mt-2 inline-block text-sm text-link underline"
                >
                  Edit cover
                </Link>
              </TicketCard>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
