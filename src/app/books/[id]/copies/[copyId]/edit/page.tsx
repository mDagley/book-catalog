import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { EditCopyForm } from "./EditCopyForm";

export default async function EditCopyPage({
  params,
}: {
  params: Promise<{ id: string; copyId: string }>;
}) {
  const { id, copyId } = await params;
  const copy = await prisma.physicalCopy.findUnique({
    where: { id: copyId },
    include: { book: true },
  });

  if (!copy || copy.bookId !== id) {
    notFound();
  }

  return (
    <main className="mx-auto max-w-lg p-4">
      <h1 className="mb-1 text-2xl font-semibold">Edit Copy</h1>
      <p className="mb-4 text-gray-600">{copy.book.title}</p>
      <EditCopyForm
        copyId={copy.id}
        bookId={id}
        defaultFormat={copy.format}
        defaultPublisher={copy.publisher ?? ""}
        defaultPublishYear={copy.publishYear?.toString() ?? ""}
        defaultSpecialNotes={copy.specialNotes ?? ""}
      />
    </main>
  );
}
