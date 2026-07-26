// One-time backfill: computes the correct `owned` value for every
// GoodreadsTbrItem that existed before the owned-flag migration (which
// defaults every row to `owned: false`). Run once per environment after
// deploying that migration -- see
// docs/superpowers/plans/2026-07-25-tbr-ownership-tracking.md.
//
// Not invoked automatically by any application code, sync, or test. This is
// the ONE place the old O(TBR items x owned books) fuzzy-match cost still
// runs -- once, deliberately, offline -- instead of on every page load.
import { prisma } from "@/lib/prisma";
import { isTitleMatch } from "@/lib/matching";

async function main() {
  const [tbrItems, books] = await Promise.all([
    prisma.goodreadsTbrItem.findMany({ select: { id: true, title: true } }),
    prisma.book.findMany({ select: { title: true } }),
  ]);
  const ownedTitles = books.map((b) => b.title);

  let updated = 0;
  for (const item of tbrItems) {
    const owned = ownedTitles.some((title) => isTitleMatch(item.title, title));
    if (owned) {
      await prisma.goodreadsTbrItem.update({ where: { id: item.id }, data: { owned: true } });
      updated++;
    }
  }

  console.log(`Backfilled ownership: ${updated}/${tbrItems.length} TBR items marked owned.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
