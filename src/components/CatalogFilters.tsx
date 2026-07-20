import { FORMAT_OPTIONS } from "@/components/CopyFormFields";
import { STATUS_FILTER_OPTIONS } from "@/components/ReadingProgressFields";
import type { OwnershipType, ReadStatusFilterValue, StatusFilterMode } from "@/lib/search";
import type { Format } from "@prisma/client";
import { Button } from "@/components/ui/Button";

export const OWNERSHIP_TYPE_OPTIONS: { value: OwnershipType; label: string }[] = [
  { value: "physical", label: "Physical" },
  { value: "ebook", label: "Ebook" },
  { value: "audiobook", label: "Audiobook" },
];

interface CatalogFiltersProps {
  types?: OwnershipType[];
  status?: ReadStatusFilterValue[];
  statusMode: StatusFilterMode;
  format?: Format;
}

// The ownership-type/status/format filter row shared between the home
// page's unified search and /books' "All Books" browse view. Rendered
// inside each page's own <form>, alongside that page's own
// SearchAutocomplete (which has a different `scope` per page, so it stays
// outside this shared component).
export function CatalogFilters({ types, status, statusMode, format }: CatalogFiltersProps) {
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm text-foreground">
      {OWNERSHIP_TYPE_OPTIONS.map((opt) => (
        <label key={opt.value} className="flex items-center gap-1">
          <input
            type="checkbox"
            name="types"
            value={opt.value}
            defaultChecked={types?.includes(opt.value) ?? false}
            className="accent-accent"
          />
          {opt.label}
        </label>
      ))}
      {STATUS_FILTER_OPTIONS.map((opt) => (
        <label key={opt.value} className="flex items-center gap-1">
          <input
            type="checkbox"
            name="status"
            value={opt.value}
            defaultChecked={status?.includes(opt.value) ?? false}
            className="accent-accent"
          />
          {opt.label}
        </label>
      ))}
      <span className="flex items-center gap-1 text-foreground/70">
        Match:
        <label className="flex items-center gap-1">
          <input
            type="radio"
            name="statusMode"
            value="or"
            defaultChecked={statusMode === "or"}
            className="accent-accent"
          />
          Any
        </label>
        <label className="flex items-center gap-1">
          <input
            type="radio"
            name="statusMode"
            value="and"
            defaultChecked={statusMode === "and"}
            className="accent-accent"
          />
          All
        </label>
      </span>
      <select
        name="format"
        defaultValue={format ?? ""}
        className="rounded-lg border border-perforation bg-background px-2 py-1 text-sm text-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
        aria-label="Filter by physical format"
      >
        <option value="">Any format</option>
        {FORMAT_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      <Button type="submit">Search</Button>
    </div>
  );
}
