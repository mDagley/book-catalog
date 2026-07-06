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
  return (
    <>
      <div>
        <label htmlFor="title" className="block text-sm font-medium">
          Title
        </label>
        <input
          id="title"
          name="title"
          required
          defaultValue={defaultTitle}
          className="mt-1 w-full rounded border p-2"
        />
      </div>
      <div>
        <label htmlFor="author" className="block text-sm font-medium">
          Author
        </label>
        <input
          id="author"
          name="author"
          defaultValue={defaultAuthor}
          className="mt-1 w-full rounded border p-2"
        />
      </div>
      <div>
        <label htmlFor="isbn" className="block text-sm font-medium">
          ISBN
        </label>
        <input
          id="isbn"
          name="isbn"
          defaultValue={defaultIsbn}
          className="mt-1 w-full rounded border p-2"
        />
      </div>
    </>
  );
}
