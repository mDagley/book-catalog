import Link from "next/link";
import {
  searchCatalog,
  countCatalog,
  getAvailableStartsWithLetters,
  parseFormatParam,
  parseTypesParam,
  parseStatusParam,
  parseStatusModeParam,
  parseSortParam,
  parseStartsWithLetter,
} from "@/lib/search";
import { getDensity } from "@/lib/density";
import { setDensity } from "@/lib/actions/density";
import { getViewMode } from "@/lib/viewMode";
import { setViewMode } from "@/lib/actions/viewMode";
import { CatalogFilters } from "@/components/CatalogFilters";
import { CatalogResultCard } from "@/components/CatalogResultCard";
import { CoverGridCard } from "@/components/CoverGridCard";
import { SearchAutocomplete } from "@/components/SearchAutocomplete";
import { Button, BUTTON_VARIANT_CLASSES } from "@/components/ui/Button";

const DEFAULT_PAGE_SIZE = 50;

// Hard ceiling on ?limit=. "Load more" accumulates server-side -- each click
// re-renders every row from the start, not just the new batch -- so without a
// cap, enough clicks (or a hand-typed ?limit=100000) rebuild the exact
// unpaginated full-catalog render this page was paginated to avoid. 500 rows
// is roughly 1.2MB of HTML, an acceptable worst case; past that, searching or
// filtering is the right tool, and the UI says so rather than silently
// offering a button that can't advance.
const MAX_PAGE_SIZE = 500;

const SORT_OPTIONS = [
  { value: "title", label: "Title A–Z" },
  { value: "author", label: "Author A–Z" },
  { value: "createdAt", label: "Recently added" },
  { value: "rating", label: "Rating high→low" },
] as const;

export default async function BooksPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    types?: string | string[];
    format?: string;
    status?: string | string[];
    statusMode?: string;
    sort?: string;
    startsWith?: string;
    limit?: string;
  }>;
}) {
  const {
    q,
    types: typesParam,
    format: formatParam,
    status: statusParam,
    statusMode: statusModeParam,
    sort: sortParam,
    startsWith: startsWithParam,
    limit: limitParam,
  } = await searchParams;
  const query = q?.trim() ?? "";
  const types = parseTypesParam(typesParam);
  const format = parseFormatParam(formatParam);
  const status = parseStatusParam(statusParam);
  const statusMode = parseStatusModeParam(statusModeParam);
  const sortBy = parseSortParam(sortParam);
  // Jump-to-letter only makes sense under an alphabetical sort (see the
  // design spec's Jump-to-letter section) -- a hand-typed ?startsWith=
  // under "recently added" or "rating" is silently ignored, matching every
  // other parse* helper's treatment of an inapplicable/malformed param.
  const supportsLetterJump = sortBy === "title" || sortBy === "author";
  // Explicit annotation needed -- TypeScript infers this ternary as plain
  // `string`, not the `"title" | "author"` literal union startsWith.field
  // expects, without it.
  const letterField: "title" | "author" = sortBy === "author" ? "author" : "title";
  const activeLetter = supportsLetterJump ? parseStartsWithLetter(startsWithParam) : undefined;

  const density = await getDensity("books");
  const viewMode = await getViewMode("books");
  // Deliberately excludes `query` -- per the design spec, the search box is
  // always visible regardless of the filter chrome's state, so typing a
  // query shouldn't force the types/status/format block open too.
  const hasActiveFilters = Boolean(types || format || status);

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

  const baseOptions = {
    query,
    types,
    format,
    status,
    statusMode,
    browseAll: true,
    sortBy,
    ...(activeLetter ? { startsWith: { letter: activeLetter, field: letterField } } : {}),
  };

  // Fetch one extra row to detect whether more results exist beyond this
  // page, without a second count query.
  const fetched = await searchCatalog({ ...baseOptions, limit: limit + 1 });
  const hasMore = fetched.length > limit;
  const results = hasMore ? fetched.slice(0, limit) : fetched;
  // At the ceiling the next step would clamp straight back to it, so the link
  // would render but do nothing. Show the narrow-down hint instead of a
  // button that silently no-ops.
  const atMaxPageSize = limit >= MAX_PAGE_SIZE;
  const canLoadMore = hasMore && !atMaxPageSize;

  const totalCount = await countCatalog(baseOptions);

  // The nav must list every available letter, not collapse to just the
  // currently-selected one -- so this deliberately queries WITHOUT the
  // startsWith filter, even when one is active.
  const availableLetters = supportsLetterJump
    ? await getAvailableStartsWithLetters(
        { query, types, format, status, statusMode, browseAll: true, sortBy },
        letterField,
      )
    : [];

  // Shared by "Load more" and the jump-to-letter links -- every param
  // EXCEPT limit/startsWith, which each caller sets for itself.
  function buildBaseParams(): URLSearchParams {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (types) params.set("types", types.join(","));
    if (format) params.set("format", format);
    if (status) params.set("status", status.join(","));
    if (statusMode !== "or") params.set("statusMode", statusMode);
    if (sortBy !== "title") params.set("sort", sortBy);
    return params;
  }

  const loadMoreParams = buildBaseParams();
  if (activeLetter) loadMoreParams.set("startsWith", activeLetter);
  loadMoreParams.set("limit", String(Math.min(limit + DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)));

  return (
    <main className="mx-auto w-full min-w-0 max-w-2xl p-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="font-display text-2xl font-semibold text-foreground-strong">All Books</h1>
        <Link
          href="/books/scan"
          className={`rounded-lg px-3 py-2 text-sm font-medium ${BUTTON_VARIANT_CLASSES.primary}`}
        >
          + Add a book
        </Link>
      </div>

      <div className="mb-4 flex flex-wrap gap-4 text-sm">
        <Link href="/" className="text-link underline">
          Back to search
        </Link>
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
        {/* Carries the active letter forward across a search/sort/filter
            resubmit -- e.g. typing a new query while browsing letter "M"
            keeps that letter applied. Unconditional on whether the NEXT sort
            will support it: if the submitted sort no longer does
            (createdAt/rating), supportsLetterJump's own gating on the read
            side already drops it silently, matching every other
            inapplicable-param case in this file. */}
        {activeLetter && <input type="hidden" name="startsWith" value={activeLetter} />}
        <label className="flex items-center gap-1 text-sm text-foreground/70">
          Sort
          <select
            name="sort"
            defaultValue={sortBy}
            className="rounded-lg border border-perforation bg-background px-2 py-1 text-sm text-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <CatalogFilters
          types={types}
          status={status}
          statusMode={statusMode}
          format={format}
          defaultOpen={hasActiveFilters}
        />
        <Button type="submit" variant="secondary">Search</Button>
      </form>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 text-sm text-foreground/70">
        <p>
          {results.length === totalCount
            ? `${totalCount} book${totalCount === 1 ? "" : "s"}`
            : `Showing ${results.length} of ${totalCount} book${totalCount === 1 ? "" : "s"}`}
        </p>
        <div className="flex flex-wrap items-center gap-4">
          <form action={setViewMode.bind(null, "books", viewMode === "grid" ? "list" : "grid")}>
            <button type="submit" className="text-link underline">
              {viewMode === "grid" ? "Switch to list view" : "Switch to grid view"}
            </button>
          </form>
          {viewMode === "list" && (
            <form
              action={setDensity.bind(null, "books", density === "compact" ? "comfortable" : "compact")}
            >
              <button type="submit" className="text-link underline">
                {density === "compact" ? "Switch to comfortable view" : "Switch to compact view"}
              </button>
            </form>
          )}
        </div>
      </div>

      {supportsLetterJump && availableLetters.length > 0 && (
        <nav className="mb-4 flex flex-wrap gap-2 text-sm" aria-label="Jump to letter">
          {availableLetters.map((letter) => {
            const params = buildBaseParams();
            params.set("startsWith", letter);
            const isActive = letter === activeLetter;
            return (
              <Link
                key={letter}
                href={`/books?${params.toString()}`}
                className={
                  isActive ? "font-semibold text-foreground-strong underline" : "text-link underline"
                }
              >
                {letter}
              </Link>
            );
          })}
          {activeLetter && (
            <Link href={`/books?${buildBaseParams().toString()}`} className="text-foreground/70 underline">
              Clear
            </Link>
          )}
        </nav>
      )}

      {results.length === 0 ? (
        <p className="text-foreground/70">No books found.</p>
      ) : (
        <>
          {viewMode === "grid" ? (
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-4">
              {results.map((result) => (
                <CoverGridCard key={result.bookId ?? result.title} result={result} />
              ))}
            </ul>
          ) : (
            <ul className={density === "compact" ? "space-y-1" : "space-y-3"}>
              {results.map((result) => (
                <CatalogResultCard key={result.bookId ?? result.title} result={result} density={density} />
              ))}
            </ul>
          )}

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
