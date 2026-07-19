import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

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
// not-yet-fixed listing behavior of not requiring a physical copy (see backlog
// item #7, tracked in project memory, not fixed here). "tbr" queries the
// separate GoodreadsTbrItem table, matching /tbr's own search.
async function fetchSuggestions(scope: Scope, q: string): Promise<Suggestion[]> {
  if (scope === "tbr") {
    return prisma.goodreadsTbrItem.findMany({
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
