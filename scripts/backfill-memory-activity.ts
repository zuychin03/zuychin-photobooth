import { parseBackfillOptions, runActivityBackfill } from "../lib/server/activity-backfill";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
  console.log("Memory activity backfill: --apply --batch-size=25 --max-batches=10 --deadline-ms=60000. Default is a zero-network dry-run. Uses existing NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables; does not load env files. Server source markers are the durable checkpoint.");
} else {
  const controller = new AbortController(), stop = () => controller.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  void (async () => {
    try {
      const result = await runActivityBackfill(parseBackfillOptions(args), process.env, { signal: controller.signal, progress: value => console.log(JSON.stringify({ event: "acknowledged", ...value })) });
      console.log(JSON.stringify(result));
      process.exitCode = ["dry_run", "no_unlocked_work"].includes(result.stop) ? 0 : 2;
    } catch { console.error("Backfill refused: invalid options or service configuration. Use --help. Credentials and remote errors are not printed."); process.exitCode = 1; }
    finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
  })();
}
