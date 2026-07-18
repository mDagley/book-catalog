import Link from "next/link";
import { getTbrGap, groupByInitial } from "@/lib/tbrGap";

export const dynamic = "force-dynamic";

export default async function TbrGapPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const query = q?.trim() ?? "";
  const gap = await getTbrGap(query);
  const groups = groupByInitial(gap);

  return (
    <main className="mx-auto max-w-2xl p-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">TBR — Not Yet Owned</h1>
        <Link href="/" className="text-sm underline">
          Back to search
        </Link>
      </div>

      <form action="/tbr" method="get" className="mb-4">
        <input
          type="text"
          name="q"
          defaultValue={query}
          placeholder="Search by title or author"
          className="w-full rounded border p-2"
        />
      </form>

      {groups.length > 0 && (
        <nav className="mb-4 flex flex-wrap gap-2 text-sm" aria-label="Jump to letter">
          {groups.map((group) => (
            <a key={group.letter} href={`#letter-${group.letter}`} className="underline">
              {group.letter}
            </a>
          ))}
        </nav>
      )}

      {gap.length === 0 ? (
        <p className="text-gray-600">
          {query
            ? "No matches found."
            : "Everything on your to-read shelf is already owned in some form."}
        </p>
      ) : (
        groups.map((group) => (
          <section key={group.letter} className="mb-4">
            <h2
              id={`letter-${group.letter}`}
              className="mb-2 text-lg font-semibold text-gray-700"
            >
              {group.letter}
            </h2>
            <ul className="space-y-2">
              {group.items.map((item) => (
                <li key={item.id} className="rounded border p-3">
                  <p className="font-medium">{item.title}</p>
                  {item.author && <p className="text-sm text-gray-600">{item.author}</p>}
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </main>
  );
}
