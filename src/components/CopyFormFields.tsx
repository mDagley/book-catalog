export const FORMAT_OPTIONS = [
  { value: "HARDCOVER", label: "Hardcover" },
  { value: "PAPERBACK", label: "Paperback" },
  { value: "MASS_MARKET", label: "Mass Market" },
  { value: "OTHER", label: "Other" },
] as const;

export const FORMAT_LABELS: Record<string, string> = Object.fromEntries(
  FORMAT_OPTIONS.map((opt) => [opt.value, opt.label]),
);

interface CopyFormFieldsProps {
  defaultFormat?: string;
  defaultPublisher?: string;
  defaultPublishYear?: string;
  defaultSpecialNotes?: string;
}

export function CopyFormFields({
  defaultFormat = "",
  defaultPublisher = "",
  defaultPublishYear = "",
  defaultSpecialNotes = "",
}: CopyFormFieldsProps) {
  return (
    <>
      <div>
        <label htmlFor="format" className="block text-sm font-medium">
          Format
        </label>
        <select
          id="format"
          name="format"
          required
          defaultValue={defaultFormat}
          className="mt-1 w-full rounded border p-2"
        >
          <option value="">Select a format</option>
          {FORMAT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="publisher" className="block text-sm font-medium">
          Publisher
        </label>
        <input
          id="publisher"
          name="publisher"
          defaultValue={defaultPublisher}
          className="mt-1 w-full rounded border p-2"
        />
      </div>
      <div>
        <label htmlFor="publishYear" className="block text-sm font-medium">
          Publish Year
        </label>
        <input
          id="publishYear"
          name="publishYear"
          type="number"
          defaultValue={defaultPublishYear}
          className="mt-1 w-full rounded border p-2"
        />
      </div>
      <div>
        <label htmlFor="specialNotes" className="block text-sm font-medium">
          Special Notes
        </label>
        <textarea
          id="specialNotes"
          name="specialNotes"
          defaultValue={defaultSpecialNotes}
          className="mt-1 w-full rounded border p-2"
        />
      </div>
    </>
  );
}
