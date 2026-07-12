import { NextResponse } from "next/server";
import { lookupIsbn } from "@/lib/isbnLookup";

// Strips everything except digits and the ISBN-10 check digit "X", and
// uppercases it, so hyphenated/spaced input (e.g. "978-0-7653-2635-5") and
// valid ISBN-10s ending in "X" (e.g. "080442957X") are both accepted. Kept as
// a small local copy rather than importing from src/lib/books.ts's
// normalizeIsbn: it's a ~3-line function used by two call sites, so a shared
// module would be more machinery than the duplication it removes.
function normalizeIsbn(raw: string): string {
  return raw.replace(/[^0-9Xx]/g, "").toUpperCase();
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const rawIsbn = searchParams.get("isbn");
  const isbn = rawIsbn ? normalizeIsbn(rawIsbn) : "";

  if (!/^(\d{13}|\d{9}[\dX])$/.test(isbn)) {
    return NextResponse.json({ error: "A valid ISBN is required" }, { status: 400 });
  }

  const result = await lookupIsbn(isbn);
  return NextResponse.json(result);
}
