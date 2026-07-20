import Link from "next/link";
import {
  searchCatalog,
  parseFormatParam,
  parseTypesParam,
  parseStatusParam,
  parseStatusModeParam,
} from "@/lib/search";
import { RefreshSyncButton } from "@/components/RefreshSyncButton";
import { SearchAutocomplete } from "@/components/SearchAutocomplete";
import { CatalogResultCard } from "@/components/CatalogResultCard";
import { CatalogFilters } from "@/components/CatalogFilters";

export const dynamic = "force-dynamic";

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    types?: string | string[];
    format?: string;
    status?: string | string[];
    statusMode?: string;
  }>;
}) {
  const {
    q,
    types: typesParam,
    format: formatParam,
    status: statusParam,
    statusMode: statusModeParam,
  } = await searchParams;
  const query = q?.trim() ?? "";
  const types = parseTypesParam(typesParam);
  const format = parseFormatParam(formatParam);
  const status = parseStatusParam(statusParam);
  const statusMode = parseStatusModeParam(statusModeParam);

  const results = await searchCatalog({ query, types, format, status, statusMode });
  const hasActiveFilters = Boolean(query || types || format || status);

  return (
    <main className="mx-auto max-w-2xl p-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="font-display text-2xl font-semibold text-foreground-strong">Book Catalog</h1>
        <RefreshSyncButton />
      </div>

      <form action="/" method="get" className="mb-4 space-y-2">
        <SearchAutocomplete
          scope="home"
          name="q"
          defaultValue={query}
          placeholder="Do I already own this?"
        />
        <CatalogFilters types={types} status={status} statusMode={statusMode} format={format} />
      </form>

      <div className="mb-4 flex gap-4 text-sm">
        <Link href="/books" className="text-link underline">
          Manage all books
        </Link>
        <Link href="/tbr" className="text-link underline">
          TBR gap view
        </Link>
      </div>

      {hasActiveFilters && results.length === 0 && (
        <p className="text-foreground/70">No matches found.</p>
      )}

      {results.length > 0 && (
        <ul className="space-y-3">
          {results.map((result) => (
            <CatalogResultCard key={result.bookId ?? result.title} result={result} />
          ))}
        </ul>
      )}

      <form action="/api/logout" method="post" className="mt-6">
        <button type="submit" className="text-sm text-link underline">
          Log out
        </button>
      </form>
    </main>
  );
}
