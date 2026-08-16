import Link from "next/link";
import type { ReactNode } from "react";
import type { ReadStatus } from "@prisma/client";
import { PandaStamp } from "@/components/PandaStamp";
import { PhysicalBookIcon, EbookIcon, AudiobookIcon } from "@/components/FormatBadgeIcons";
import { TicketCard } from "@/components/ui/TicketCard";
import { CoverThumbnail } from "@/components/CoverThumbnail";

interface FormatBadge {
  key: string;
  icon: ReactNode;
}

// The minimal shape this card needs -- deliberately narrower than
// SearchResult so non-catalog listings (e.g. TBR items, which own nothing
// and have no book to link to) satisfy it too, just with the ownership/link
// fields absent. SearchResult remains structurally compatible as-is.
export interface CoverGridCardData {
  title: string;
  author: string | null;
  coverImagePath: string | null;
  bookId?: string;
  readStatus?: ReadStatus | null;
  physicalCopies?: unknown[];
  hasEbook?: boolean;
  hasAudiobook?: boolean;
}

// Poster-style card for the grid view: full-bleed 2:3 cover with small
// corner badges (read status, owned formats) and minimal text below --
// the badges replace the text meta line CatalogResultCard shows, per the
// design spec's "corner badges + minimal text" choice. Ownership/link
// fields are optional -- when absent (e.g. TBR items), no badges or link
// render, since there's nothing owned and nowhere to link to.
export function CoverGridCard({ result }: { result: CoverGridCardData }) {
  const formatBadges: FormatBadge[] = [
    ...((result.physicalCopies?.length ?? 0) > 0
      ? [{ key: "physical", icon: <PhysicalBookIcon title="Physical copy" className="h-4 w-4" /> }]
      : []),
    ...(result.hasEbook
      ? [{ key: "ebook", icon: <EbookIcon title="Ebook" className="h-4 w-4" /> }]
      : []),
    ...(result.hasAudiobook
      ? [{ key: "audiobook", icon: <AudiobookIcon title="Audiobook" className="h-4 w-4" /> }]
      : []),
  ];

  const card = (
    <TicketCard as="div" className="flex h-full flex-col overflow-hidden p-0">
      <div className="relative aspect-[2/3] w-full bg-surface">
        <CoverThumbnail
          coverImagePath={result.coverImagePath}
          size="poster"
          alt=""
          className="h-full w-full"
        />
        {result.readStatus === "READ" && (
          <PandaStamp
            title="Read"
            className="absolute right-2 top-2 h-5 w-5 rounded-full bg-background/80 p-0.5 text-status-positive"
          />
        )}
        {formatBadges.length > 0 && (
          <div className="absolute left-2 top-2 flex flex-col gap-1">
            {formatBadges.map((badge) => (
              <span key={badge.key} className="rounded-full bg-background/80 p-0.5 text-foreground-strong">
                {badge.icon}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="flex-1 p-2">
        <p className="line-clamp-2 font-display text-sm font-semibold text-foreground-strong">
          {result.title}
        </p>
        {result.author && <p className="line-clamp-1 text-xs text-foreground/70">{result.author}</p>}
      </div>
    </TicketCard>
  );

  return (
    <li data-testid="catalog-grid-item">
      {result.bookId ? (
        <Link href={`/books/${result.bookId}`} aria-label={result.title} className="block h-full">
          {card}
        </Link>
      ) : (
        card
      )}
    </li>
  );
}
