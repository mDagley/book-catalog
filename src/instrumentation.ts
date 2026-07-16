export async function register() {
  // Only run in the actual Node.js server process — instrumentation.ts is
  // also loaded for the Edge runtime, where node-cron (and the sync modules'
  // use of Node's fs/net-backed fetch through Prisma) doesn't apply.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const cron = await import("node-cron");
  const { syncAbsCache } = await import("@/lib/absSync");
  const { syncGoodreadsTbr } = await import("@/lib/goodreadsSync");
  const { syncOwnedPhysicalBooks } = await import("@/lib/ownedPhysicalSync");

  // Every 30 minutes — within the design spec's "every 30-60 minutes" range.
  cron.schedule(
    "*/30 * * * *",
    async () => {
      const absUrl = process.env.ABS_URL;
      const absToken = process.env.ABS_TOKEN;
      if (!absUrl || !absToken) {
        console.error("Skipping scheduled ABS sync: ABS_URL/ABS_TOKEN not set");
        return;
      }
      try {
        const result = await syncAbsCache(absUrl, absToken);
        console.log(`Scheduled ABS sync: ${result.synced} items synced`);
      } catch (error) {
        console.error("Scheduled ABS sync failed:", error);
      }
    },
    { noOverlap: true },
  );

  // Offset 5 minutes from the ABS sync's "*/30 * * * *" -- both jobs used to
  // share the identical expression, so they fired at the exact same instant
  // every 30 minutes. On the resource-constrained production VPS, running
  // both syncs' many sequential DB round-trips concurrently starved the
  // connection pool badly enough that this transaction failed with Prisma
  // P2028 ("Unable to start a transaction in the given time").
  cron.schedule(
    "5,35 * * * *",
    async () => {
      const userId = process.env.GOODREADS_USER_ID;
      if (!userId) {
        console.error("Skipping scheduled Goodreads sync: GOODREADS_USER_ID not set");
        return;
      }
      try {
        const result = await syncGoodreadsTbr(userId);
        console.log(`Scheduled Goodreads sync: ${result.synced} items synced`);
      } catch (error) {
        console.error("Scheduled Goodreads sync failed:", error);
      }
      try {
        const shelfName = process.env.GOODREADS_OWNED_PHYSICAL_SHELF || undefined;
        const result = await syncOwnedPhysicalBooks(userId, shelfName);
        console.log(`Scheduled owned-physical sync: ${result.synced} items synced`);
      } catch (error) {
        console.error("Scheduled owned-physical sync failed:", error);
      }
    },
    { noOverlap: true },
  );

  console.log("Registered ABS and Goodreads sync cron jobs (every 30 minutes)");
}
