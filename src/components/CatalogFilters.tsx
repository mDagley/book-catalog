import { FORMAT_OPTIONS } from "@/components/CopyFormFields";
import { STATUS_FILTER_OPTIONS } from "@/components/ReadingProgressFields";
import type { OwnershipType, ReadStatusFilterValue, StatusFilterMode } from "@/lib/search";
import type { Format } from "@prisma/client";

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
  // Whether at least one filter is currently active -- when true the
  // block renders expanded (a filtered list that LOOKS unfiltered is worse
  // than the height it saves); when false it collapses to a one-line
  // "Filters" summary, which is why /books' first screen was showing only
  // 2 books despite a 900px viewport. Optional, defaulting to true (today's
  // always-expanded behavior) -- this keeps this commit compiling on its
  // own, since both call sites are only updated to pass it explicitly in
  // later tasks (12-13).
  defaultOpen?: boolean;
}

// The ownership-type/status/format filter row shared between the home
// page's unified search and /books' "All Books" browse view. Rendered
// inside each page's own <form>, alongside that page's own
// SearchAutocomplete and its own submit button (a submit button living
// here would be unreachable while collapsed).
export function CatalogFilters({
  types,
  status,
  statusMode,
  format,
  defaultOpen = true,
}: CatalogFiltersProps) {
  return (
    <details open={defaultOpen}>
      <summary className="cursor-pointer select-none text-sm text-foreground/70">Filters</summary>
      <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-foreground">
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
      </div>
    </details>
  );
}
