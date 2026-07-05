import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const bookCount = await prisma.book.count();

  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-4">
      <h1 className="text-2xl font-semibold">Book Catalog</h1>
      <p className="mt-2 text-gray-600">{bookCount} books in catalog</p>
      <form action="/api/logout" method="post" className="mt-6">
        <button type="submit" className="text-sm underline">
          Log out
        </button>
      </form>
    </main>
  );
}
