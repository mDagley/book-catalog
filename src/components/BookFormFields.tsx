interface BookFormFieldsProps {
  defaultTitle?: string;
  defaultAuthor?: string;
  defaultIsbn?: string;
}

export function BookFormFields({
  defaultTitle = "",
  defaultAuthor = "",
  defaultIsbn = "",
}: BookFormFieldsProps) {
  const fieldClass =
    "mt-1 w-full rounded-lg border border-perforation bg-background px-3 py-2 text-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent";

  return (
    <>
      <div>
        <label htmlFor="title" className="block text-sm font-medium text-foreground">
          Title
        </label>
        <input id="title" name="title" required defaultValue={defaultTitle} className={fieldClass} />
      </div>
      <div>
        <label htmlFor="author" className="block text-sm font-medium text-foreground">
          Author
        </label>
        <input id="author" name="author" defaultValue={defaultAuthor} className={fieldClass} />
      </div>
      <div>
        <label htmlFor="isbn" className="block text-sm font-medium text-foreground">
          ISBN
        </label>
        <input
          id="isbn"
          name="isbn"
          defaultValue={defaultIsbn}
          className={`${fieldClass} font-mono`}
        />
      </div>
    </>
  );
}
