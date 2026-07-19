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
}

// The ownership-type/status/format filter row shared between the home
// page's unified search and /books' "All Books" browse view. Rendered
// inside each page's own <form>, alongside that page's own
// SearchAutocomplete (which has a different `scope` per page, so it stays
// outside this shared component).
export function CatalogFilters({ types, status, statusMode, format }: CatalogFiltersProps) {
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      {OWNERSHIP_TYPE_OPTIONS.map((opt) => (
        <label key={opt.value} className="flex items-center gap-1">
          <input
            type="checkbox"
            name="types"
            value={opt.value}
            defaultChecked={types?.includes(opt.value) ?? false}
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
          />
          {opt.label}
        </label>
      ))}
      <span className="flex items-center gap-1 text-gray-500">
        Match:
        <label className="flex items-center gap-1">
          <input type="radio" name="statusMode" value="or" defaultChecked={statusMode === "or"} />
          Any
        </label>
        <label className="flex items-center gap-1">
          <input type="radio" name="statusMode" value="and" defaultChecked={statusMode === "and"} />
          All
        </label>
      </span>
      <select
        name="format"
        defaultValue={format ?? ""}
        className="rounded border p-1"
        aria-label="Filter by physical format"
      >
        <option value="">Any format</option>
        {FORMAT_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      <button type="submit" className="rounded bg-black px-3 py-1 text-white">
        Search
      </button>
    </div>
  );
}
