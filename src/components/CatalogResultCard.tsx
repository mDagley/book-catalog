import Link from "next/link";
import type { ReadStatus } from "@prisma/client";
import type { SearchResult } from "@/lib/search";
import { FORMAT_LABELS } from "@/components/CopyFormFields";
import { READ_STATUS_LABELS, ratingStars } from "@/components/ReadingProgressFields";
import { CoverThumbnail } from "@/components/CoverThumbnail";
import { PandaStamp } from "@/components/PandaStamp";
import { TicketCard, TicketDivider } from "@/components/ui/TicketCard";

// `satisfies` (rather than `: Record<string, string>`) means a future
// ReadStatus enum value that's added to the Prisma schema but forgotten here
// fails at compile time instead of silently producing an undefined
// className at runtime.
const STATUS_CLASS = {
  READ: "text-status-positive",
  READING: "text-status-active",
  TO_READ: "text-foreground/70",
} satisfies Record<ReadStatus, string>;

interface MetaPart {
  key: string;
  label: string;
  className?: string;
  ariaLabel?: string;
}

// One catalog entry as rendered in a search/browse result list -- shared
// between the home page's unified search and /books' "All Books" browse
// view, both of which render searchCatalog() results identically.
export function CatalogResultCard({ result }: { result: SearchResult }) {
  const metaParts: MetaPart[] = [
    ...result.physicalCopies.map((copy) => ({
      key: `physical-${copy.id}`,
      label: `${FORMAT_LABELS[copy.format]}${copy.publisher ? `, ${copy.publisher}` : ""}${copy.publishYear ? ` ${copy.publishYear}` : ""}`,
    })),
    ...(result.hasEbook ? [{ key: "ebook", label: "Ebook" }] : []),
    ...(result.hasAudiobook ? [{ key: "audiobook", label: "Audiobook" }] : []),
    ...(result.readStatus
      ? [
          {
            key: "status",
            label: READ_STATUS_LABELS[result.readStatus],
            className: STATUS_CLASS[result.readStatus],
          },
        ]
      : []),
    ...(result.rating !== null
      ? [
          {
            key: "rating",
            label: ratingStars(result.rating),
            ariaLabel: `Rated ${result.rating} out of 5`,
          },
        ]
      : []),
  ];

  return (
    <TicketCard className="relative p-3">
      {result.readStatus === "READ" && (
        <PandaStamp title="Read" className="absolute right-3 top-3 h-5 w-5 text-status-positive" />
      )}
      <CoverThumbnail coverImagePath={result.coverImagePath} />
      <p className="font-display font-semibold text-foreground-strong">{result.title}</p>
      {result.author && <p className="text-sm text-foreground/70">{result.author}</p>}
      {metaParts.length > 0 && (
        <>
          <TicketDivider />
          <p className="flex flex-wrap items-center font-mono text-xs uppercase tracking-wide text-foreground/70">
            {metaParts.map((part, index) => (
              <span key={part.key} className={part.className} aria-label={part.ariaLabel}>
                {index > 0 && <span className="mx-1 text-foreground/40">·</span>}
                {part.label}
              </span>
            ))}
          </p>
        </>
      )}
      {result.bookId && (
        <Link href={`/books/${result.bookId}`} className="mt-2 inline-block text-sm text-link underline">
          View details
        </Link>
      )}
    </TicketCard>
  );
}
