import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { EditBookForm } from "./EditBookForm";

export default async function EditBookPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const book = await prisma.book.findUnique({ where: { id } });

  if (!book) {
    notFound();
  }

  return (
    <main className="mx-auto max-w-lg p-4">
      <h1 className="mb-4 text-2xl font-semibold">Edit Book</h1>
      <EditBookForm
        bookId={book.id}
        defaultTitle={book.title}
        defaultAuthor={book.author ?? ""}
        defaultIsbn={book.isbn ?? ""}
      />
    </main>
  );
}
