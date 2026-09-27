export interface SchedulerEnvironment {
  CRON_SECRET?: string;
  SCHEDULER_ENABLED?: string;
  EVENTS_ENABLED?: string;
  PROJECTS_ENABLED?: string;
  MEDIA_ENABLED?: string;
  REMINDERS_ENABLED?: string;
}

interface ScheduledEvent { cron: string }
interface Ports {
  fetch(url: string, init: RequestInit): Promise<Response>;
  log(line: string): void;
  timeoutSignal(milliseconds: number): AbortSignal;
}
const ORIGIN = "https://photobooth.zuychin.me";
const TIMEOUT_MS = 120_000;
const JOBS = [
  { name: "events", flag: "EVENTS_ENABLED", cron: "* * * * *", path: "/api/events/maintenance" },
  { name: "projects", flag: "PROJECTS_ENABLED", cron: "* * * * *", path: "/api/projects/maintenance" },
  { name: "media", flag: "MEDIA_ENABLED", cron: "*/15 * * * *", path: "/api/media/maintenance" },
  { name: "reminders", flag: "REMINDERS_ENABLED", cron: "*/15 * * * *", path: "/api/reminders" },
] as const;

function discardBody(response: Response) {
  // Never consume provider/application bodies or wait for their cancellation acknowledgement.
  void response.body?.cancel().catch(() => {});
}

export function createScheduler(overrides: Partial<Ports> = {}) {
  const ports: Ports = {
    fetch: (url, init) => fetch(url, init),
    log: line => console.log(line),
    timeoutSignal: milliseconds => AbortSignal.timeout(milliseconds),
    ...overrides,
  };
  return {
    async scheduled(event: ScheduledEvent, env: SchedulerEnvironment): Promise<void> {
      if (env.SCHEDULER_ENABLED !== "true") return;
      const jobs = JOBS.filter(job => job.cron === event.cron && env[job.flag] === "true");
      if (!jobs.length) return;
      if (!env.CRON_SECRET || !/^[\x21-\x7e]{1,4096}$/.test(env.CRON_SECRET)) {
        throw new Error("Scheduler configuration unavailable");
      }
      const secret = env.CRON_SECRET;
      const results = await Promise.allSettled(jobs.map(async job => {
        const signal = ports.timeoutSignal(TIMEOUT_MS);
        let abort: () => void = () => {};
        let status: number | null = null;
        try {
          const deadline = new Promise<never>((_, reject) => {
            abort = () => reject(new Error("Request deadline"));
            signal.addEventListener("abort", abort, { once: true });
          });
          const request = async () => {
            signal.throwIfAborted();
            const response = await ports.fetch(`${ORIGIN}${job.path}`, {
              method: "GET", redirect: "error", cache: "no-store", signal,
              headers: { Authorization: `Bearer ${secret}` },
            });
            discardBody(response);
            signal.throwIfAborted();
            return response.status;
          };
          status = await Promise.race([request(), deadline]);
          if (status !== 200) throw new Error("Unconfirmed maintenance pass");
          ports.log(JSON.stringify({ job: job.name, status, outcome: "http_ok" }));
        } catch {
          ports.log(JSON.stringify({ job: job.name, status, outcome: signal.aborted ? "timeout" : status === 409 ? "busy" : "failed" }));
          throw new Error("Maintenance job failed");
        } finally {
          signal.removeEventListener("abort", abort);
        }
      }));
      if (results.some(result => result.status === "rejected")) throw new Error("Maintenance pass failed");
    },
  };
}

export default createScheduler();
