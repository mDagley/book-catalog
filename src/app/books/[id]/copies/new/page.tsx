import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { AddCopyForm } from "./AddCopyForm";

export default async function AddCopyPage({
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
      <h1 className="mb-1 text-2xl font-semibold">Add a Copy</h1>
      <p className="mb-4 text-gray-600">{book.title}</p>
      <AddCopyForm bookId={book.id} />
    </main>
  );
}
