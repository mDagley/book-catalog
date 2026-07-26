// Recomputes `owned` for every GoodreadsTbrItem. Needed once after the
// owned-flag migration, which defaults every pre-existing row to `false`.
//
// >>> This does NOT run inside the deployed container. <<<
// It needs `tsx` to resolve the `@/` path alias, and tsx is a devDependency,
// which the production image prunes (`npm ci --omit=dev` in the Dockerfile's
// prod-deps stage). Moving tsx to "dependencies" just to support a script
// that's never run in production isn't worth the image weight.
//
// In production, click "Recompute ownership" on /tbr instead -- it calls the
// exact same recomputeAllTbrOwnership(), so there is one implementation of
// the cross-product to trust rather than two that can silently drift apart.
//
// This CLI form is for a dev machine with full node_modules installed, which
// can point at any DATABASE_URL (including production's) if a shell is more
// convenient than the UI:
//
//   DATABASE_URL="postgresql://..." npm run backfill:tbr-owned
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
