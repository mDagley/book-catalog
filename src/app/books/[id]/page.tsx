import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { sortSeriesMembers } from "@/lib/series";
import { deleteCopy } from "@/lib/actions/copies";
import { FORMAT_LABELS } from "@/components/CopyFormFields";
import { TicketCard } from "@/components/ui/TicketCard";
import { BUTTON_VARIANT_CLASSES } from "@/components/ui/Button";
import { resolveListingCover } from "@/lib/listingCover";
import { PandaStamp } from "@/components/PandaStamp";

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

  const heroCoverPath = resolveListingCover(book);

  // Case-insensitive so "The Daevabad Trilogy" and "the daevabad trilogy"
  // group together. Exact equality only -- no fuzzy matching, deliberately,
  // so two genuinely different series with similar names never merge (see
  // the spec's non-goals). Only queried when this book has a series at all.
  const seriesMembers = book.seriesName
    ? sortSeriesMembers(
        await prisma.book.findMany({
          where: { seriesName: { equals: book.seriesName, mode: "insensitive" } },
          select: { id: true, title: true, seriesPosition: true },
        }),
      )
    : [];

  return (
    <main className="mx-auto max-w-2xl p-4">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-wrap items-start gap-4">
          {heroCoverPath && (
            <div className="relative aspect-[2/3] w-32 shrink-0 overflow-hidden rounded-lg border border-dashed border-perforation bg-surface">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/covers/${encodeURIComponent(heroCoverPath)}`}
                alt="Cover"
                className="h-full w-full object-cover"
              />
              {book.readStatus === "READ" && (
                <PandaStamp
                  title="Read"
                  className="absolute right-2 top-2 h-6 w-6 rounded-full bg-background/80 p-1 text-status-positive"
                />
              )}
            </div>
          )}
          <div>
            <h1 className="font-display text-2xl font-semibold text-foreground-strong">{book.title}</h1>
            {book.author && <p className="text-foreground/70">{book.author}</p>}
            {book.isbn && <p className="font-mono text-sm text-foreground/70">ISBN: {book.isbn}</p>}
          </div>
        </div>
        <Link
          href={`/books/${book.id}/edit`}
          className={`rounded-lg px-3 py-2 text-sm font-medium ${BUTTON_VARIANT_CLASSES.secondary}`}
        >
          Edit
        </Link>
      </div>

      {/* Shown only when at least one OTHER book shares the series -- a
          "series" listing just this book tells the reader nothing. */}
      {seriesMembers.length > 1 && (
        <section className="mb-4">
          <h2 className="mb-2 font-display text-lg font-medium text-foreground-strong">
            Part of: {book.seriesName}
          </h2>
          <ol className="space-y-1 text-sm">
            {seriesMembers.map((member) => (
              <li key={member.id}>
                {/* No trailing period for an un-numbered entry -- "—." reads
                    as a malformed list marker rather than a missing number. */}
                <span className="text-foreground/70">
                  {member.seriesPosition === null ? "—" : `${member.seriesPosition}.`}{" "}
                </span>
                {member.id === book.id ? (
                  <span className="text-foreground">
                    {member.title} <span className="text-foreground/70">(this book)</span>
                  </span>
                ) : (
                  <Link href={`/books/${member.id}`} className="text-link underline">
                    {member.title}
                  </Link>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}

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
