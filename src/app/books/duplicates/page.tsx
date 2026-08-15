import Link from "next/link";
import { getDuplicateGroups, refreshDuplicateGroupsCache } from "@/lib/duplicates";
import { mergeBooks } from "@/lib/actions/duplicates";
import { MergeButton } from "@/app/books/duplicates/MergeButton";
import { TicketCard } from "@/components/ui/TicketCard";
import { CoverThumbnail } from "@/components/CoverThumbnail";

export const dynamic = "force-dynamic";

export default async function DuplicateBooksPage() {
  // Duplicate groups are computed at sync/create/merge time and persisted
  // (see refreshDuplicateGroupsCache() in duplicates.ts) rather than
  // recomputed on every page view. `computedAt === null` only happens once
  // ever, on the very first visit after this cache was introduced (or a
  // fresh install) before any sync/create/merge has run yet -- bootstrap it
  // here so the page doesn't just show an empty result.
  const cached = await getDuplicateGroups();
  const { groups, truncated } =
    cached.computedAt === null ? await refreshDuplicateGroupsCache() : cached;

  return (
    <main className="mx-auto max-w-2xl p-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="font-display text-2xl font-semibold text-foreground-strong">
          Possible Duplicate Books
        </h1>
        <Link href="/books" className="text-sm text-link underline">
          Back to All Books
        </Link>
      </div>
      <p className="mb-4 text-sm text-foreground/70">
        Books grouped here have closely-matching titles and may be the same book split across
        multiple rows (e.g. a physical copy scanned separately from an already-owned ebook or
        audiobook). Review each group and, if they really are the same book, pick the one to keep
        — its title, author, and ISBN are kept as-is; the others&apos; physical copies and
        ebook/audiobook ownership move onto it, and the other rows are removed.
      </p>
      {truncated && (
        <p className="mb-4 rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-800">
          The last duplicate scan hit an internal safety limit before finishing — some duplicates
          may be missing below. This list is recomputed automatically whenever a book is added,
          edited, or synced, so it should resolve itself the next time that happens.
        </p>
      )}

      {groups.length === 0 ? (
        <p className="text-foreground/70">No likely duplicates found.</p>
      ) : (
        <ul className="space-y-6">
          {groups.map((group) => (
            <TicketCard key={group.books.map((book) => book.id).join(",")} className="p-3">
              <ul className="space-y-2">
                {group.books.map((book) => (
                  <li key={book.id} className="flex gap-3 rounded-lg border border-perforation p-2 text-sm">
                    <CoverThumbnail coverImagePath={book.coverImagePath} size="compact" />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-foreground-strong">{book.title}</p>
                      {book.author && <p className="text-foreground/70">{book.author}</p>}
                      {book.isbn && <p className="font-mono text-foreground/70">ISBN: {book.isbn}</p>}
                      <p className="text-foreground/70">
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
                    </div>
                  </li>
                ))}
              </ul>
            </TicketCard>
          ))}
        </ul>
      )}
    </main>
  );
}
