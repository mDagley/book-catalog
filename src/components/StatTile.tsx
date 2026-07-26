import { TicketCard } from "@/components/ui/TicketCard";

interface StatTileProps {
  label: string;
  value: number;
  /** Renders larger, for the one number the page leads with. */
  hero?: boolean;
}

// A single headline number. Per the visualization guidance a handful of
// standalone figures is a stat tile, NOT a one-bar chart -- there is no
// magnitude comparison to make between "total books" and "total copies".
export function StatTile({ label, value, hero = false }: StatTileProps) {
  return (
    <TicketCard as="div" className="p-3">
      <p
        className={
          hero
            ? "font-display text-4xl font-semibold text-foreground-strong"
            : "font-display text-2xl font-semibold text-foreground-strong"
        }
      >
        {value.toLocaleString()}
      </p>
      <p className="mt-1 text-sm text-foreground/70">{label}</p>
    </TicketCard>
  );
}
