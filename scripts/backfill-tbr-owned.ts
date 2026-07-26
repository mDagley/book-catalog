// One-time backfill: computes the correct `owned` value for every
// GoodreadsTbrItem that existed before the owned-flag migration (which
// defaults every row to `owned: false`). Run once per environment after
// deploying that migration -- see
// docs/superpowers/plans/2026-07-25-tbr-ownership-tracking.md.
//
// Equivalent to the "Recompute ownership" button on /tbr; this CLI form
// exists for environments where a shell is easier to reach than the UI.
// Both call the same recomputeAllTbrOwnership(), so there is exactly one
// implementation of the cross-product to trust rather than two that can
// silently drift apart.
//
// Not invoked automatically by any application code, sync, or test.
import { recomputeAllTbrOwnership } from "@/lib/tbrGap";
import { prisma } from "@/lib/prisma";

async function main() {
  const { total, markedOwned, markedUnowned } = await recomputeAllTbrOwnership();
  console.log(
    `Recomputed ownership across ${total} TBR items: ` +
      `${markedOwned} newly marked owned, ${markedUnowned} marked no longer owned.`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
