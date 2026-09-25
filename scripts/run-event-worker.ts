import { parseEventRunnerOptions, runEventWorker } from "../lib/server/event-worker-runner";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
  console.log("Event worker: --apply --max-passes=3 --deadline-ms=300000. Default is zero-network dry-run. Uses PB_PUBLIC_ORIGIN, CRON_SECRET and PB_EVENTS_ENABLED from the process environment; never loads env files. Requires an authorised scheduler invocation at least every60seconds. No scheduler is installed by this command.");
} else {
  const controller = new AbortController(), stop = () => controller.abort(); process.once("SIGINT", stop); process.once("SIGTERM", stop);
  void (async () => {
    try { const result = await runEventWorker(parseEventRunnerOptions(args), process.env, { signal: controller.signal }); console.log(JSON.stringify(result)); process.exitCode = ["dry_run", "idle", "pass_limit"].includes(result.stop) ? 0 : 2; }
    catch { console.error("Event worker refused: invalid options or configuration. Use --help. Credentials and remote errors are not printed."); process.exitCode = 1; }
    finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
  })();
}
