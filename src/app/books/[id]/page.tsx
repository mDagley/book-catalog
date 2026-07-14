import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { deleteCopy } from "@/lib/actions/copies";
import { FORMAT_LABELS } from "@/components/CopyFormFields";

export default async function BookDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const book = await prisma.book.findUnique({
    where: { id },
    include: { copies: { orderBy: { createdAt: "asc" } } },
  });

  if (!book) {
    notFound();
  }

  return (
    <main className="mx-auto max-w-2xl p-4">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">{book.title}</h1>
          {book.author && <p className="text-gray-600">{book.author}</p>}
          {book.isbn && <p className="text-sm text-gray-500">ISBN: {book.isbn}</p>}
        </div>
        <Link href={`/books/${book.id}/edit`} className="rounded border px-3 py-2 text-sm">
          Edit
        </Link>
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-medium">Copies ({book.copies.length})</h2>
        <Link
          href={`/books/${book.id}/copies/new`}
          className="rounded bg-black px-3 py-2 text-sm text-white"
        >
          + Add a copy
        </Link>
      </div>

      <ul className="space-y-3">
        {book.copies.map((copy) => (
          <li key={copy.id} className="rounded border p-3">
            <p className="font-medium">{FORMAT_LABELS[copy.format]}</p>
            {copy.publisher && <p className="text-sm text-gray-600">{copy.publisher}</p>}
            {copy.publishYear && <p className="text-sm text-gray-600">{copy.publishYear}</p>}
            {copy.specialNotes && <p className="text-sm text-gray-600">{copy.specialNotes}</p>}
            {copy.coverImagePath && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/api/covers/${encodeURIComponent(copy.coverImagePath)}`}
                alt="Cover"
                className="mt-2 h-32 w-24 rounded object-cover"
              />
            )}
            <div className="mt-2 flex gap-2">
              <Link
                href={`/books/${book.id}/copies/${copy.id}/edit`}
                className="text-sm underline"
              >
                Edit
              </Link>
              <form action={deleteCopy.bind(null, copy.id)}>
                <button type="submit" className="text-sm text-red-600 underline">
                  Delete
                </button>
              </form>
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}
