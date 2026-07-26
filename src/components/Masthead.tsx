import Link from "next/link";
import { PandaStamp } from "@/components/PandaStamp";

// Slim shared app-identity bar rendered once, above every page's own heading
// (see layout.tsx).
//
// The stamp + wordmark link home. This bar was originally inert -- the theme
// phase deliberately added no nav, to avoid an IA redesign it hadn't scoped
// -- but that left the whole /books subtree with no way back: /books linked
// only to /books/scan and /books/duplicates, /books/duplicates linked only
// back to /books, and /books/[id], /books/new and /books/scan had no
// outbound links at all. The browser back button was the only exit. Linking
// the wordmark fixes every one of those at once, including any page added
// later, and matches the near-universal convention that an app's name in its
// header returns you to the start.
//
// Pages with their own explicit "Back to search" link (/tbr, /stats, /books)
// keep it -- this is a safety net, not a replacement for visible in-page
// navigation.
export function Masthead() {
  return (
    <div className="border-b border-dashed border-perforation px-4 py-2">
      <div className="mx-auto flex max-w-2xl items-center">
        <Link
          href="/"
          // inline-flex so the focus ring wraps just the stamp and wordmark,
          // rather than stretching across the full row.
          className="inline-flex items-center gap-2 rounded focus:outline-none focus:ring-1 focus:ring-accent"
        >
          <PandaStamp className="h-5 w-5 text-foreground-strong" />
          <span className="font-display text-sm font-semibold tracking-wide text-foreground-strong">
            Book Catalog
          </span>
        </Link>
      </div>
    </div>
  );
}
