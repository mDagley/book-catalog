// One-off: adds the 7 books from ThriftBooks order #79666296 (placed
// 2026-08-09) as physical copies. Reuses createBookWithCopyData (same path
// the UI's "Add a Book" and scan forms use) so duplicate-ISBN/title matching
// and the DuplicateGroup cache refresh behave identically to a manual add.
//
// Format isn't printed on the ThriftBooks receipt, so every copy is created
// as PAPERBACK -- correct it per-book on /books/[id]/edit if any turn out to
// be hardcover. specialNotes records the as-purchased condition from the
// receipt for reference.
//
// Run from a dev machine with full node_modules (tsx is a devDependency):
//   npx tsx scripts/add-thriftbooks-order-79666296.ts
import "dotenv/config";
import { createBookWithCopyData } from "@/lib/books";
import { saveCoverFromUrl } from "@/lib/books";
import { lookupIsbn } from "@/lib/isbnLookup";
import { refreshDuplicateGroupsCache } from "@/lib/duplicates";
import { prisma } from "@/lib/prisma";

const ORDER_BOOKS = [
  { title: "I Had That Same Dream Again: The Complete Manga Collection", isbn: "1645054918", condition: "Like New" },
  { title: "In: A Graphic Novel", isbn: "0358345545", condition: "Very Good" },
  { title: "I Have a Secret (Light Novel)", isbn: "1648274153", condition: "Acceptable" },
  { title: "The Impending Blindness of Billie Scott", isbn: "1910395641", condition: "New" },
  { title: "I Who Have Never Known Men", isbn: "1945492600", condition: "New" },
  { title: "It's Lonely at the Centre of the Earth", isbn: "1534323864", condition: "New" },
  { title: "Orlanda", isbn: "1644215160", condition: "New" },
];

async function main() {
  for (const entry of ORDER_BOOKS) {
    const lookup = await lookupIsbn(entry.isbn);

    let coverImagePath: string | undefined;
    if (lookup.coverUrl) {
      const coverResult = await saveCoverFromUrl(lookup.coverUrl);
      if ("coverImagePath" in coverResult) {
        coverImagePath = coverResult.coverImagePath;
      }
    }

    const result = await createBookWithCopyData({
      title: lookup.title ?? entry.title,
      author: lookup.author ?? "",
      isbn: entry.isbn,
      format: "PAPERBACK",
      publisher: lookup.publisher ?? "",
      publishYear: lookup.publishYear?.toString() ?? "",
      specialNotes: `ThriftBooks order #79666296, condition: ${entry.condition}`,
      coverImagePath,
    });

    if ("error" in result) {
      console.error(`FAILED: ${entry.title} (${entry.isbn}): ${result.error}`);
      continue;
    }

    console.log(`OK: ${entry.title} -> book ${result.bookId}`);
  }

  await refreshDuplicateGroupsCache();
  console.log("Duplicate group cache refreshed.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
