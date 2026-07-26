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
  const parsedLimit = limitParam ? parseInt(limitParam, 10) : NaN;
  const limit = Number.isNaN(parsedLimit) || parsedLimit <= 0 ? DEFAULT_PAGE_SIZE : parsedLimit;

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

  const loadMoreParams = new URLSearchParams();
  if (query) loadMoreParams.set("q", query);
  if (types) loadMoreParams.set("types", types.join(","));
  if (format) loadMoreParams.set("format", format);
  if (status) loadMoreParams.set("status", status.join(","));
  if (statusMode !== "or") loadMoreParams.set("statusMode", statusMode);
  loadMoreParams.set("limit", String(limit + DEFAULT_PAGE_SIZE));

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

          {hasMore && (
            <div className="mt-4 text-center">
              <Link
                href={`/books?${loadMoreParams.toString()}`}
                className={`inline-block rounded-lg px-3 py-2 text-sm font-medium ${BUTTON_VARIANT_CLASSES.secondary}`}
              >
                Load more
              </Link>
            </div>
          )}
        </>
      )}
    </main>
  );
}
