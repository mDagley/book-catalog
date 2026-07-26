import Link from "next/link";
import { getLibraryStats } from "@/lib/stats";
import { StatTile } from "@/components/StatTile";
import { StatBarList } from "@/components/StatBarList";

export const dynamic = "force-dynamic";

export default async function StatsPage() {
  const stats = await getLibraryStats();

  if (stats.totals.books === 0) {
    return (
      <main className="mx-auto max-w-2xl p-4">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h1 className="font-display text-2xl font-semibold text-foreground-strong">Library Stats</h1>
          <Link href="/" className="text-sm text-link underline">
            Back to search
          </Link>
        </div>
        <p className="text-foreground/70">
          Nothing catalogued yet — add a book and the numbers will show up here.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl p-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="font-display text-2xl font-semibold text-foreground-strong">Library Stats</h1>
        <Link href="/" className="text-sm text-link underline">
          Back to search
        </Link>
      </div>

      <section className="mb-6">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <StatTile label="Books" value={stats.totals.books} hero />
          <StatTile label="Copies" value={stats.totals.copies} />
          <StatTile label="In multiple formats" value={stats.totals.multiFormatBooks} />
          <StatTile label="Physical" value={stats.totals.physicalBooks} />
          <StatTile label="Ebook" value={stats.totals.ebookBooks} />
          <StatTile label="Audiobook" value={stats.totals.audiobookBooks} />
        </div>
      </section>

      <section className="mb-6">
        <h2 className="mb-1 font-display text-lg font-semibold text-foreground-strong">Reading</h2>
        <p className="mb-2 text-sm text-foreground/70">By book</p>
        <StatBarList buckets={stats.readStatus} unit="books" />
        <h3 className="mt-4 mb-2 font-display text-base font-semibold text-foreground-strong">
          Ratings
        </h3>
        <StatBarList buckets={stats.ratings} unit="books" />
      </section>

      <section className="mb-6">
        <h2 className="mb-1 font-display text-lg font-semibold text-foreground-strong">
          Physical shelf
        </h2>
        {/* Stated in the UI, not just the code: these count physical copies,
            so two paperbacks of one title count twice -- unlike the
            book-level numbers above. */}
        <p className="mb-2 text-sm text-foreground/70">By copy</p>
        <StatBarList buckets={stats.formats} unit="copies" />

        {/* Shown when there is EITHER a decade to chart or copies missing a
            year. Gating the whole section on `decades.length` alone hid the
            missing-year note in the one case it matters most: a shelf where
            no copy has a publish year at all would silently show nothing,
            rather than saying so. */}
        {(stats.decades.length > 0 || stats.publishYearUnknown > 0) && (
          <>
            <h3 className="mt-4 mb-2 font-display text-base font-semibold text-foreground-strong">
              Published
            </h3>
            {stats.decades.length > 0 && <StatBarList buckets={stats.decades} unit="copies" />}
            {stats.publishYearUnknown > 0 && (
              <p className="mt-2 text-sm text-foreground/70">
                {`${stats.publishYearUnknown.toLocaleString()} ${
                  stats.publishYearUnknown === 1 ? "copy has" : "copies have"
                } no publish year recorded.`}
              </p>
            )}
          </>
        )}

        {stats.topPublishers.length > 0 && (
          <>
            <h3 className="mt-4 mb-2 font-display text-base font-semibold text-foreground-strong">
              Top publishers
            </h3>
            <StatBarList buckets={stats.topPublishers} unit="copies" />
          </>
        )}
      </section>

      <section className="mb-6">
        <h2 className="mb-1 font-display text-lg font-semibold text-foreground-strong">Authors</h2>
        <p className="mb-2 text-sm text-foreground/70">By book</p>
        {stats.topAuthors.length > 0 ? (
          <StatBarList buckets={stats.topAuthors} unit="books" />
        ) : (
          <p className="text-sm text-foreground/70">No authors recorded yet.</p>
        )}
      </section>

      <section>
        <h2 className="mb-2 font-display text-lg font-semibold text-foreground-strong">
          To-read shelf
        </h2>
        <div className="grid grid-cols-3 gap-3">
          <StatTile label="On the shelf" value={stats.tbr.total} />
          <StatTile label="Already owned" value={stats.tbr.owned} />
          <StatTile label="Still to get" value={stats.tbr.gap} />
        </div>
      </section>
    </main>
  );
}
