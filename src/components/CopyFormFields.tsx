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
  // Distinguishes this instance's field ids from any other CopyFormFields
  // rendered on the same page (e.g. one section per physical copy on the
  // consolidated book edit page) -- without it, every instance would emit
  // the same id="format" etc., which is invalid HTML and breaks label
  // association for every instance after the first. Empty by default so
  // the single-instance callers (AddCopyForm) keep their existing ids
  // unchanged.
  idPrefix?: string;
}

export function CopyFormFields({
  defaultFormat = "",
  defaultPublisher = "",
  defaultPublishYear = "",
  defaultSpecialNotes = "",
  idPrefix = "",
}: CopyFormFieldsProps) {
  const fieldId = (name: string) => (idPrefix ? `${idPrefix}-${name}` : name);
  const fieldClass =
    "mt-1 w-full rounded-lg border border-perforation bg-background px-3 py-2 text-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent";

  return (
    <>
      <div>
        <label htmlFor={fieldId("format")} className="block text-sm font-medium text-foreground">
          Format
        </label>
        <select
          id={fieldId("format")}
          name="format"
          required
          defaultValue={defaultFormat}
          className={fieldClass}
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
        <label htmlFor={fieldId("publisher")} className="block text-sm font-medium text-foreground">
          Publisher
        </label>
        <input id={fieldId("publisher")} name="publisher" defaultValue={defaultPublisher} className={fieldClass} />
      </div>
      <div>
        <label htmlFor={fieldId("publishYear")} className="block text-sm font-medium text-foreground">
          Publish Year
        </label>
        <input
          id={fieldId("publishYear")}
          name="publishYear"
          type="number"
          defaultValue={defaultPublishYear}
          className={`${fieldClass} font-mono`}
        />
      </div>
      <div>
        <label htmlFor={fieldId("specialNotes")} className="block text-sm font-medium text-foreground">
          Special Notes
        </label>
        <textarea
          id={fieldId("specialNotes")}
          name="specialNotes"
          defaultValue={defaultSpecialNotes}
          className={fieldClass}
        />
      </div>
    </>
  );
}
