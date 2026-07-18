import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { EditEbookCopyCoverForm } from "./EditEbookCopyCoverForm";

export default async function EditEbookCopyPage({
  params,
}: {
  params: Promise<{ id: string; copyId: string }>;
}) {
  const { id, copyId } = await params;
  const copy = await prisma.ebookCopy.findUnique({
    where: { id: copyId },
    include: { book: true },
  });

  if (!copy || copy.bookId !== id) {
    notFound();
  }

  return (
    <main className="mx-auto max-w-lg p-4">
      <h1 className="mb-1 text-2xl font-semibold">Edit Ebook Cover</h1>
      <p className="mb-4 text-gray-600">{copy.book.title}</p>
      <EditEbookCopyCoverForm
        copyId={copy.id}
        bookId={id}
        currentCoverPath={copy.coverImagePath}
        bookIsbn={copy.book.isbn}
      />
    </main>
  );
}
