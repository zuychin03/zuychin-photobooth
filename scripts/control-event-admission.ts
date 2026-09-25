import { parseAdmissionOptions, runEventAdmission } from "../lib/server/event-admission-control";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
  console.log("Event admission: --action=status|pause|resume [--expected-revision=N] [--apply]. Default is zero-network dry-run. Mutations require the exact current revision. Uses NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from the process environment; never loads env files. Requires migration027. Hosted execution needs separate authorisation.");
} else {
  const abort = new AbortController(), stop = () => abort.abort(); process.once("SIGINT", stop); process.once("SIGTERM", stop);
  void (async () => {
    try { console.log(JSON.stringify(await runEventAdmission(parseAdmissionOptions(args), process.env, { signal: abort.signal }))); }
    catch { console.error("Event admission unconfirmed. Check configuration and migration027; read status before retrying an uncertain change. No secret or remote error is printed."); process.exitCode = 1; }
    finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
  })();
}
