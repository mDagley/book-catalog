import { NextResponse } from "next/server";
import { lookupIsbn } from "@/lib/isbnLookup";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const isbn = searchParams.get("isbn");

  if (!isbn || !/^\d{10,13}$/.test(isbn)) {
    return NextResponse.json({ error: "A valid ISBN is required" }, { status: 400 });
  }

  const result = await lookupIsbn(isbn);
  return NextResponse.json(result);
}
