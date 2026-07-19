import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getTbrGap } from "@/lib/tbrGap";

const SCOPES = ["home", "books", "tbr"] as const;
type Scope = (typeof SCOPES)[number];

const MIN_QUERY_LENGTH = 2;
const SUGGESTION_LIMIT = 8;

interface Suggestion {
  title: string;
  author: string | null;
}

function isScope(value: string | null): value is Scope {
  return value !== null && (SCOPES as readonly string[]).includes(value);
}

// "home" and "books" both suggest across the same Book table/shape, deliberately
// mirroring each page's own current search behavior -- including /books' own
// now-intentional all-ownership-types listing behavior (not requiring a
// physical copy), since /books was reworked into a full "All Books" browse
// page rather than a physical-only one (closing what was backlog item #7).
// "tbr" reuses getTbrGap, the same not-yet-owned-filtered, query-matched
// source /tbr itself renders from, so a suggested title always has a real
// result on the /tbr page.
async function fetchSuggestions(scope: Scope, q: string): Promise<Suggestion[]> {
  if (scope === "tbr") {
    const gap = await getTbrGap(q);
    return gap.slice(0, SUGGESTION_LIMIT).map(({ title, author }) => ({ title, author }));
  }

  return prisma.book.findMany({
    where: {
      OR: [
        { title: { contains: q, mode: "insensitive" } },
        { author: { contains: q, mode: "insensitive" } },
      ],
    },
    select: { title: true, author: true },
    take: SUGGESTION_LIMIT,
    orderBy: { title: "asc" },
  });
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const scopeParam = searchParams.get("scope");
  const q = searchParams.get("q")?.trim() ?? "";

  if (!isScope(scopeParam)) {
    return NextResponse.json({ error: "A valid scope is required" }, { status: 400 });
  }

  if (q.length < MIN_QUERY_LENGTH) {
    return NextResponse.json([]);
  }

  const suggestions = await fetchSuggestions(scopeParam, q);
  return NextResponse.json(suggestions);
}
