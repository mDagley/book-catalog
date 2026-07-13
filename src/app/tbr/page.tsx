import Link from "next/link";
import { getTbrGap } from "@/lib/tbrGap";

export const dynamic = "force-dynamic";

export default async function TbrGapPage() {
  const gap = await getTbrGap();

  return (
    <main className="mx-auto max-w-2xl p-4">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">TBR — Not Yet Owned</h1>
        <Link href="/" className="text-sm underline">
          Back to search
        </Link>
      </div>

      {gap.length === 0 ? (
        <p className="text-gray-600">
          Everything on your to-read shelf is already owned in some form.
        </p>
      ) : (
        <ul className="space-y-2">
          {gap.map((item) => (
            <li key={item.id} className="rounded border p-3">
              <p className="font-medium">{item.title}</p>
              {item.author && <p className="text-sm text-gray-600">{item.author}</p>}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
