import Link from "next/link";
import {
  searchCatalog,
  parseFormatParam,
  parseTypesParam,
  parseStatusParam,
  parseStatusModeParam,
} from "@/lib/search";
import { CatalogFilters } from "@/components/CatalogFilters";
import { CatalogResultCard } from "@/components/CatalogResultCard";
import { SearchAutocomplete } from "@/components/SearchAutocomplete";
import { BUTTON_VARIANT_CLASSES } from "@/components/ui/Button";

const DEFAULT_PAGE_SIZE = 50;

// Hard ceiling on ?limit=. "Load more" accumulates server-side -- each click
// re-renders every row from the start, not just the new batch -- so without a
// cap, enough clicks (or a hand-typed ?limit=100000) rebuild the exact
// unpaginated full-catalog render this page was paginated to avoid. 500 rows
// is roughly 1.2MB of HTML, an acceptable worst case; past that, searching or
// filtering is the right tool, and the UI says so rather than silently
// offering a button that can't advance.
const MAX_PAGE_SIZE = 500;

export default async function BooksPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    types?: string | string[];
    format?: string;
    status?: string | string[];
    statusMode?: string;
    limit?: string;
  }>;
}) {
  const {
    q,
    types: typesParam,
    format: formatParam,
    status: statusParam,
    statusMode: statusModeParam,
    limit: limitParam,
  } = await searchParams;
  const query = q?.trim() ?? "";
  const types = parseTypesParam(typesParam);
  const format = parseFormatParam(formatParam);
  const status = parseStatusParam(statusParam);
  const statusMode = parseStatusModeParam(statusModeParam);
  // Number() rather than parseInt() so partially-numeric junk ("50abc") is
  // rejected outright instead of silently becoming 50. Anything not a
  // positive integer falls back to the default; anything above the ceiling is
  // clamped rather than rejected, so an over-large ?limit= still renders a
  // sane page instead of erroring.
  const parsedLimit = limitParam ? Number(limitParam) : NaN;
  const limit =
    Number.isInteger(parsedLimit) && parsedLimit > 0
      ? Math.min(parsedLimit, MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE;

  // Fetch one extra row to detect whether more results exist beyond this
  // page, without a second count query.
  const fetched = await searchCatalog({
    query,
    types,
    format,
    status,
    statusMode,
    browseAll: true,
    sortBy: "title",
    limit: limit + 1,
  });
  const hasMore = fetched.length > limit;
  const results = hasMore ? fetched.slice(0, limit) : fetched;
  // At the ceiling the next step would clamp straight back to it, so the link
  // would render but do nothing. Show the narrow-down hint instead of a
  // button that silently no-ops.
  const atMaxPageSize = limit >= MAX_PAGE_SIZE;
  const canLoadMore = hasMore && !atMaxPageSize;

  const loadMoreParams = new URLSearchParams();
  if (query) loadMoreParams.set("q", query);
  if (types) loadMoreParams.set("types", types.join(","));
  if (format) loadMoreParams.set("format", format);
  if (status) loadMoreParams.set("status", status.join(","));
  if (statusMode !== "or") loadMoreParams.set("statusMode", statusMode);
  loadMoreParams.set("limit", String(Math.min(limit + DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)));

  return (
    <main className="mx-auto max-w-2xl p-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="font-display text-2xl font-semibold text-foreground-strong">All Books</h1>
        <Link
          href="/books/scan"
          className={`rounded-lg px-3 py-2 text-sm font-medium ${BUTTON_VARIANT_CLASSES.primary}`}
        >
          + Add a book
        </Link>
      </div>

      <div className="mb-4 text-sm">
        <Link href="/books/duplicates" className="text-link underline">
          Check for duplicate books
        </Link>
      </div>

      <form action="/books" method="get" className="mb-4 space-y-2">
        <SearchAutocomplete
          scope="books"
          name="q"
          defaultValue={query}
          placeholder="Search by title, author, or ISBN"
        />
        <CatalogFilters types={types} status={status} statusMode={statusMode} format={format} />
      </form>

      {results.length === 0 ? (
        <p className="text-foreground/70">No books found.</p>
      ) : (
        <>
          <ul className="space-y-3">
            {results.map((result) => (
              <CatalogResultCard key={result.bookId ?? result.title} result={result} />
            ))}
          </ul>

          {canLoadMore && (
            <div className="mt-4 text-center">
              <Link
                href={`/books?${loadMoreParams.toString()}`}
                className={`inline-block rounded-lg px-3 py-2 text-sm font-medium ${BUTTON_VARIANT_CLASSES.secondary}`}
              >
                Load more
              </Link>
            </div>
          )}

          {hasMore && atMaxPageSize && (
            <p className="mt-4 text-center text-sm text-foreground/70">
              Showing the first {MAX_PAGE_SIZE} books. Search or use the filters above to narrow
              things down.
            </p>
          )}
        </>
      )}
    </main>
  );
}
