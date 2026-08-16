import Link from "next/link";
import { getTbrGap, groupByInitial } from "@/lib/tbrGap";
import { getViewMode } from "@/lib/viewMode";
import { setViewMode } from "@/lib/actions/viewMode";
import { CoverThumbnail } from "@/components/CoverThumbnail";
import { CoverGridCard } from "@/components/CoverGridCard";
import { RecomputeOwnershipButton } from "@/components/RecomputeOwnershipButton";
import { SearchAutocomplete } from "@/components/SearchAutocomplete";
import { TicketCard } from "@/components/ui/TicketCard";

export const dynamic = "force-dynamic";

// The "#" bucket (groupByInitial's catch-all for non-letter first characters)
// can't be used directly in an href/id -- "#" is meaningful in a URL fragment
// and awkward to reference from a CSS/JS selector, so it gets a dedicated
// anchor token here while the visible jump-nav label stays "#".
function anchorId(letter: string): string {
  return letter === "#" ? "letter-hash" : `letter-${letter}`;
}

export default async function TbrGapPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const query = q?.trim() ?? "";
  const gap = await getTbrGap(query);
  const groups = groupByInitial(gap);
  const viewMode = await getViewMode("tbr");

  return (
    <main className={`mx-auto w-full min-w-0 p-4 ${viewMode === "grid" ? "max-w-6xl" : "max-w-2xl"}`}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="font-display text-2xl font-semibold text-foreground-strong">TBR — Not Yet Owned</h1>
        <div className="flex flex-wrap items-center gap-3">
          <form action={setViewMode.bind(null, "tbr", viewMode === "grid" ? "list" : "grid")}>
            <button type="submit" className="text-sm text-link underline">
              {viewMode === "grid" ? "Switch to list view" : "Switch to grid view"}
            </button>
          </form>
          <RecomputeOwnershipButton />
          <Link href="/" className="text-sm text-link underline">
            Back to search
          </Link>
        </div>
      </div>

      <form action="/tbr" method="get" className="mb-4">
        <SearchAutocomplete
          scope="tbr"
          name="q"
          defaultValue={query}
          placeholder="Search by title, author, or ISBN"
        />
      </form>

      {groups.length > 0 && (
        <nav className="mb-4 flex flex-wrap gap-2 text-sm" aria-label="Jump to letter">
          {groups.map((group) => (
            <a key={group.letter} href={`#${anchorId(group.letter)}`} className="text-link underline">
              {group.letter}
            </a>
          ))}
        </nav>
      )}

      {gap.length === 0 ? (
        <p className="text-foreground/70">
          {query
            ? "No matches found."
            : "Everything on your to-read shelf is already owned in some form."}
        </p>
      ) : (
        groups.map((group) => (
          <section key={group.letter} className="mb-4">
            <h2
              id={anchorId(group.letter)}
              className="mb-2 font-display text-lg font-semibold text-foreground-strong"
            >
              {group.letter}
            </h2>
            {viewMode === "grid" ? (
              <ul className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-4">
                {group.items.map((item) => (
                  <CoverGridCard key={item.id} result={item} />
                ))}
              </ul>
            ) : (
              <ul className="space-y-2">
                {group.items.map((item) => (
                  <TicketCard key={item.id} className="p-3">
                    <CoverThumbnail coverImagePath={item.coverImagePath} className="mb-2" />
                    <p className="font-medium text-foreground-strong">{item.title}</p>
                    {item.author && <p className="text-sm text-foreground/70">{item.author}</p>}
                  </TicketCard>
                ))}
              </ul>
            )}
          </section>
        ))
      )}
    </main>
  );
}
