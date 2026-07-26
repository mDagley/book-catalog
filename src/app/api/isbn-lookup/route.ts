import { NextResponse } from "next/server";
import { lookupIsbn } from "@/lib/isbnLookup";
import { normalizeIsbn, isValidIsbn } from "@/lib/isbn";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const rawIsbn = searchParams.get("isbn");
  const isbn = rawIsbn ? normalizeIsbn(rawIsbn) : "";

  if (!isValidIsbn(isbn)) {
    return NextResponse.json({ error: "A valid ISBN is required" }, { status: 400 });
  }

  const result = await lookupIsbn(isbn);
  return NextResponse.json(result);
}
