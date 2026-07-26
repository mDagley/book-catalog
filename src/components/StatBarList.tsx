import type { CountBucket } from "@/lib/stats";

interface StatBarListProps {
  buckets: CountBucket[];
  /** What one unit is, e.g. "books" or "copies" -- shown in hover text. */
  unit: string;
}

// Single-hue horizontal bars. Colour deliberately carries NO information:
// bar length encodes the count, and every bar is the same fill.
//
// This is a hard constraint, not a style choice. The theme's two candidate
// data colours (Sakura Ink and Bamboo) measure ΔE 0.2 apart under
// deuteranopia -- a red/green colourblind reader would see one colour -- so
// this palette cannot support multi-series categorical charts at all. See
// docs/superpowers/specs/2026-07-26-library-stats-design.md.
//
// The fill uses --link (#9C4258 light / #E8A2AC dark), the one theme colour
// that clears the >=3:1 contrast-vs-surface check in BOTH modes. Do not
// switch it to --accent: that measures 2.15:1 on the cream background.
export function StatBarList({ buckets, unit }: StatBarListProps) {
  // Scale to the largest bucket, not to the total: this compares categories
  // against each other, so the biggest bar should fill the row.
  const max = Math.max(...buckets.map((b) => b.count), 1);

  return (
    <ul className="space-y-2">
      {buckets.map((bucket) => (
        <li key={bucket.label} className="flex items-center gap-3">
          <span className="w-32 shrink-0 truncate text-sm text-foreground" title={bucket.label}>
            {bucket.label}
          </span>
          <span
            className="h-3 flex-1 overflow-hidden rounded-full bg-perforation/30"
            // Native title = the guidance's hover layer with no client-side
            // JS, so this whole page stays a server component.
            title={`${bucket.label}: ${bucket.count.toLocaleString()} ${unit}`}
          >
            <span
              className="block h-full rounded-full bg-link"
              style={{ width: `${(bucket.count / max) * 100}%` }}
            />
          </span>
          {/* The number is ALWAYS text, never encoded in length alone --
              this is what makes the page readable to a screen reader and
              removes any need for a separate table view. */}
          <span className="w-12 shrink-0 text-right text-sm tabular-nums text-foreground/70">
            {bucket.count.toLocaleString()}
          </span>
        </li>
      ))}
    </ul>
  );
}
