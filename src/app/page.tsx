import Link from "next/link";
import { searchCatalog, parseFormatParam, parseTypesParam, type OwnershipType } from "@/lib/search";
import { FORMAT_OPTIONS, FORMAT_LABELS } from "@/components/CopyFormFields";
import { RefreshSyncButton } from "@/components/RefreshSyncButton";

export const dynamic = "force-dynamic";

const OWNERSHIP_TYPE_OPTIONS: { value: OwnershipType; label: string }[] = [
  { value: "physical", label: "Physical" },
  { value: "ebook", label: "Ebook" },
  { value: "audiobook", label: "Audiobook" },
];

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; types?: string | string[]; format?: string }>;
}) {
  const { q, types: typesParam, format: formatParam } = await searchParams;
  const query = q?.trim() ?? "";
  const types = parseTypesParam(typesParam);
  const format = parseFormatParam(formatParam);

  const results = await searchCatalog({ query, types, format });
  const hasActiveFilters = Boolean(query || types || format);

  return (
    <main className="mx-auto max-w-2xl p-4">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Book Catalog</h1>
        <RefreshSyncButton />
      </div>

      <form action="/" method="get" className="mb-4 space-y-2">
        <input
          type="text"
          name="q"
          defaultValue={query}
          placeholder="Do I already own this?"
          className="w-full rounded border p-2"
        />
        <div className="flex flex-wrap items-center gap-3 text-sm">
          {OWNERSHIP_TYPE_OPTIONS.map((opt) => (
            <label key={opt.value} className="flex items-center gap-1">
              <input
                type="checkbox"
                name="types"
                value={opt.value}
                defaultChecked={types?.includes(opt.value) ?? false}
              />
              {opt.label}
            </label>
          ))}
          <select
            name="format"
            defaultValue={format ?? ""}
            className="rounded border p-1"
            aria-label="Filter by physical format"
          >
            <option value="">Any format</option>
            {FORMAT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <button type="submit" className="rounded bg-black px-3 py-1 text-white">
            Search
          </button>
        </div>
      </form>

      <div className="mb-4 flex gap-4 text-sm">
        <Link href="/books" className="underline">
          Manage physical books
        </Link>
        <Link href="/tbr" className="underline">
          TBR gap view
        </Link>
      </div>

      {hasActiveFilters && results.length === 0 && (
        <p className="text-gray-600">No matches found.</p>
      )}

      {results.length > 0 && (
        <ul className="space-y-3">
          {results.map((result) => (
            <li key={result.bookId ?? result.title} className="rounded border p-3">
              <p className="font-medium">{result.title}</p>
              {result.author && <p className="text-sm text-gray-600">{result.author}</p>}
              <div className="mt-1 flex flex-wrap gap-2 text-sm">
                {result.physicalCopies.map((copy) => (
                  <span key={copy.id} className="rounded bg-gray-100 px-2 py-0.5">
                    Physical ({FORMAT_LABELS[copy.format]}
                    {copy.publisher ? `, ${copy.publisher}` : ""}
                    {copy.publishYear ? ` ${copy.publishYear}` : ""})
                  </span>
                ))}
                {result.hasEbook && (
                  <span className="rounded bg-gray-100 px-2 py-0.5">Ebook ✓</span>
                )}
                {result.hasAudiobook && (
                  <span className="rounded bg-gray-100 px-2 py-0.5">Audiobook ✓</span>
                )}
              </div>
              {result.bookId && (
                <Link
                  href={`/books/${result.bookId}`}
                  className="mt-1 inline-block text-sm underline"
                >
                  View details
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}

      <form action="/api/logout" method="post" className="mt-6">
        <button type="submit" className="text-sm underline">
          Log out
        </button>
      </form>
    </main>
  );
}
