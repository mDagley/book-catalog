import Link from "next/link";
import type { SearchResult } from "@/lib/search";
import { FORMAT_LABELS } from "@/components/CopyFormFields";
import { READ_STATUS_LABELS, ratingStars } from "@/components/ReadingProgressFields";
import { CoverThumbnail } from "@/components/CoverThumbnail";

// One catalog entry as rendered in a search/browse result list -- shared
// between the home page's unified search and /books' "All Books" browse
// view, both of which render searchCatalog() results identically.
export function CatalogResultCard({ result }: { result: SearchResult }) {
  return (
    <li className="rounded border p-3">
      <CoverThumbnail coverImagePath={result.coverImagePath} />
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
        {result.hasEbook && <span className="rounded bg-gray-100 px-2 py-0.5">Ebook ✓</span>}
        {result.hasAudiobook && (
          <span className="rounded bg-gray-100 px-2 py-0.5">Audiobook ✓</span>
        )}
        {result.readStatus && (
          <span className="rounded bg-gray-100 px-2 py-0.5">
            {READ_STATUS_LABELS[result.readStatus]}
          </span>
        )}
        {result.rating !== null && (
          <span
            className="rounded bg-gray-100 px-2 py-0.5"
            aria-label={`Rated ${result.rating} out of 5`}
          >
            {ratingStars(result.rating)}
          </span>
        )}
      </div>
      {result.bookId && (
        <Link href={`/books/${result.bookId}`} className="mt-1 inline-block text-sm underline">
          View details
        </Link>
      )}
    </li>
  );
}
