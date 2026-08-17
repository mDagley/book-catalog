import type { TbrGapRetailerMatch } from "@/lib/tbrGap";
import { confirmRetailerMatch, rejectRetailerMatch } from "@/lib/actions/retailerMatch";
import { BUTTON_VARIANT_CLASSES } from "@/components/ui/Button";

const RETAILER_LABELS: Record<string, string> = {
  librofm: "libro.fm",
  googleplay: "Google Play Books",
};

export function RetailerPriceBadge({ match }: { match: TbrGapRetailerMatch }) {
  const label = RETAILER_LABELS[match.retailer] ?? match.retailer;

  if (!match.confirmed) {
    return (
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <span className="text-foreground/70">
          Confirm match: &quot;{match.matchedTitle}&quot; on {label}?
        </span>
        <form action={confirmRetailerMatch.bind(null, match.id)}>
          <button
            type="submit"
            className={`rounded-md px-2 py-0.5 text-xs font-medium ${BUTTON_VARIANT_CLASSES.primary}`}
          >
            Confirm
          </button>
        </form>
        <form action={rejectRetailerMatch.bind(null, match.id)}>
          <button
            type="submit"
            className={`rounded-md px-2 py-0.5 text-xs font-medium ${BUTTON_VARIANT_CLASSES.secondary}`}
          >
            Reject
          </button>
        </form>
      </div>
    );
  }

  if (match.currentPrice === null) return null;

  const isDrop = match.previousPrice !== null && match.currentPrice < match.previousPrice;

  return (
    <p className={`text-xs ${isDrop ? "font-semibold text-status-positive" : "text-foreground/70"}`}>
      {isDrop && "↓ "}
      {label}: ${match.currentPrice.toFixed(2)}
      {isDrop && ` (was $${match.previousPrice!.toFixed(2)})`}
    </p>
  );
}
