import Link from "next/link";
import type { ReactNode } from "react";
import type { SearchResult } from "@/lib/search";
import { PandaStamp } from "@/components/PandaStamp";
import { PhysicalBookIcon, EbookIcon, AudiobookIcon } from "@/components/FormatBadgeIcons";
import { TicketCard } from "@/components/ui/TicketCard";

interface FormatBadge {
  key: string;
  icon: ReactNode;
}

// Poster-style card for the grid view: full-bleed 2:3 cover with small
// corner badges (read status, owned formats) and minimal text below --
// the badges replace the text meta line CatalogResultCard shows, per the
// design spec's "corner badges + minimal text" choice.
export function CoverGridCard({ result }: { result: SearchResult }) {
  const formatBadges: FormatBadge[] = [
    ...(result.physicalCopies.length > 0
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
        {result.coverImagePath ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/covers/${encodeURIComponent(result.coverImagePath)}`}
            alt=""
            className="h-full w-full object-cover"
          />
        ) : (
          <div
            className="flex h-full w-full items-center justify-center text-3xl text-foreground/40"
            aria-hidden="true"
          >
            📖
          </div>
        )}
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
