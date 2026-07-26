// Standalone ISBN helpers, deliberately free of any Prisma/DB import.
//
// This lives outside src/lib/books.ts for two reasons:
//
// 1. books.ts pulls in the Prisma client at the top level, so it can never be
//    imported from browser code. That forced client components (see
//    ScanAddForm) and lightweight route handlers (see /api/isbn-lookup) to
//    keep their own duplicate copies of this ~3-line function.
// 2. books.ts now imports the TBR ownership maintainers from tbrGap.ts, while
//    tbrGap.ts needs normalizeIsbn -- importing it from books.ts would make
//    those two modules mutually dependent.
//
// Keeping it here gives every consumer (server, browser, and tbrGap) one
// implementation with no cycle and no Prisma dependency.

// Normalizes an ISBN for storage/comparison: strips everything except digits
// and the ISBN-10 check digit "X", and uppercases it. This lets a manually
// typed, hyphenated ISBN (e.g. "978-0-7653-2635-5") dedup-match a bare digit
// string decoded from a barcode scan (e.g. "9780765326355"). This does not
// affect how an ISBN is displayed anywhere.
export function normalizeIsbn(raw: string): string {
  return raw.replace(/[^0-9Xx]/g, "").toUpperCase();
}

// True for a normalized ISBN-13 (13 digits) or ISBN-10 (9 digits plus a
// digit-or-X check character). Accepts raw, unnormalized input.
export function isValidIsbn(raw: string): boolean {
  return /^(\d{13}|\d{9}[\dX])$/.test(normalizeIsbn(raw));
}
