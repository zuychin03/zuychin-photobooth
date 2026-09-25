import { createHash, randomUUID } from "node:crypto";
import { cloudTimestamp, cloudUuid } from "../projects/cloud-contract";
import { computeRitualProof, ritualObject, ritualRevision, ritualTitle, validateRitualDefinition } from "../memories/ritual-contract";
import type { ReminderAdapter } from "./reminders";

export interface RitualTarget { recipientId: string; channel: string; target: { email: string | null } | { id: string; endpoint: string | null; p256dh: string | null; auth: string | null } }
export interface RitualClaim { id: string; dateId: string; revision: number; cycle: number; scheduledAt: string; title: string; token: string; targets: RitualTarget[]; terminal?: boolean }
export interface RitualReminderAdapter {
  ready(): Promise<boolean>;
  claim(runToken: string, token: string): Promise<RitualClaim | null>;
  begin(claim: RitualClaim, target: RitualTarget, payloadHash: string): Promise<"send" | "delivered" | "gone" | "uncertain" | "unavailable">;
  record(claim: RitualClaim, target: RitualTarget, outcome: "sent" | "gone"): Promise<void>;
  finish(claim: RitualClaim): Promise<void>;
  fail(claim: RitualClaim, uncertain: boolean): Promise<void>;
}
const unavailable = (): never => { throw new Error("ritual delivery unavailable"); };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function parseClaim(value: unknown, token: string): RitualClaim | null {
  if (value === null) return null;
  const v = ritualObject(value, ["id", "dateId", "revision", "cycle", "scheduledAt", "title", "token", "targets", "terminal"]);
  if (v.token !== token || typeof v.terminal !== "boolean" || !Number.isSafeInteger(v.cycle) || (v.cycle as number) < 0 || (v.cycle as number) > 1000000 || !Array.isArray(v.targets) || v.targets.length > 22 || v.terminal && v.targets.length) return unavailable();
  const keys = new Set<string>(), recipients = new Set<string>(); let pushes = 0;
  const targets = v.targets.map((item): RitualTarget => {
    const t = ritualObject(item, ["recipientId", "channel", "target"]), recipientId = cloudUuid(t.recipientId), key = `${recipientId}:${t.channel}`;
    if (typeof t.channel !== "string" || keys.has(key)) return unavailable(); keys.add(key); recipients.add(recipientId);
    if (t.channel === "email") {
      const address = ritualObject(t.target, ["email"]); if (address.email !== null && (typeof address.email !== "string" || address.email.length > 320)) return unavailable();
      return { recipientId, channel: t.channel, target: { email: address.email as string | null } };
    }
    if (!t.channel.startsWith("push:") || ++pushes > 20) return unavailable(); const id = cloudUuid(t.channel.slice(5));
    const subscription = ritualObject(t.target, ["id", "endpoint", "p256dh", "auth"]);
    if (subscription.id !== id || ["endpoint", "p256dh", "auth"].some(k => subscription[k] !== null && (typeof subscription[k] !== "string" || (subscription[k] as string).length > (k === "endpoint" ? 4096 : 256)))) return unavailable();
    return { recipientId, channel: t.channel, target: subscription as RitualTarget["target"] };
  });
  if (recipients.size > 2) return unavailable();
  return { id: cloudUuid(v.id), dateId: cloudUuid(v.dateId), revision: ritualRevision(v.revision), cycle: v.cycle as number, scheduledAt: new Date(cloudTimestamp(v.scheduledAt)).toISOString(), title: ritualTitle(v.title), token, targets, terminal: v.terminal };
}
export function createRitualReminderAdapter(rpc: (name: string, args?: Record<string, unknown>) => Promise<unknown>): RitualReminderAdapter {
  const args = (claim: RitualClaim) => ({ p_occurrence: claim.id, p_token: claim.token });
  return {
    async ready() {
      const value = await rpc("pb_ritual_capabilities");
      if (value === null) return false;
      const c = ritualObject(value, ["ready", "version", "maximumPerCouple", "pageMaximum", "proofSeconds", "deliveryVersion"]);
      if (c.ready !== true || c.version !== 1 || c.maximumPerCouple !== 20 || c.pageMaximum !== 20 || c.proofSeconds !== 30 || ![0, 1].includes(c.deliveryVersion as number)) return unavailable();
      return c.deliveryVersion === 1;
    },
    async claim(runToken, token) { return parseClaim(await rpc("pb_ritual_claim", { p_run_token: runToken, p_token: token }), token); },
    async begin(claim, target, payloadHash) {
      const result = await rpc("pb_ritual_dispatch", { ...args(claim), p_recipient: target.recipientId, p_channel: target.channel, p_hash: payloadHash });
      if (!["send", "delivered", "gone", "uncertain", "unavailable"].includes(result as string)) return unavailable(); return result as "send" | "delivered" | "gone" | "uncertain" | "unavailable";
    },
    async record(claim, target, outcome) { if (await rpc("pb_ritual_record", { ...args(claim), p_recipient: target.recipientId, p_channel: target.channel, p_outcome: outcome }) !== true) return unavailable(); },
    async finish(claim) {
      const c = ritualObject(await rpc("pb_ritual_finish_context", args(claim)), ["now", "schedule"]), proof = computeRitualProof(validateRitualDefinition(c.schedule), cloudTimestamp(c.now));
      if (await rpc("pb_ritual_finish", { ...args(claim), p_proof: proof }) !== true) return unavailable();
    },
    async fail(claim, uncertain) { if (!["stale", "retrying", "failed", "uncertain"].includes(await rpc("pb_ritual_fail", { ...args(claim), p_uncertain: uncertain }) as string)) return unavailable(); },
  };
}
export async function processRitualReminders(
  rituals: RitualReminderAdapter, provider: Pick<ReminderAdapter, "email" | "push" | "acquire">,
  options: { token: string; limit: number; emailEnabled: boolean; pushEnabled: boolean; emailFrom: string; startedAt?: number; html(title: string): string },
): Promise<{ processed: number; sent: number; failed: number; skipped: number }> {
  const result = { processed: 0, sent: 0, failed: 0, skipped: 0 };
  if (!Number.isInteger(options.limit) || options.limit < 0 || options.limit > 5) return unavailable();
  const started = options.startedAt ?? Date.now();
  const checkBudget = () => { if (Date.now() - started >= 45000) return unavailable(); };
  for (let index = 0; index < options.limit && Date.now() - started < 45000; index++) {
    if (!await provider.acquire(options.token)) return unavailable();
    const claim = await rituals.claim(options.token, randomUUID()); if (!claim) break;
    result.processed++; let failed = false, uncertain = false, next = 0, delivered = 0;
    if (claim.terminal) { result.failed++; continue; }
    const run = async () => {
      while (!failed && next < claim.targets.length) {
        const target = claim.targets[next++];
        try {
          checkBudget();
          if (!await provider.acquire(options.token)) return unavailable();
          const key = digest(`${claim.dateId}:${claim.revision}:${claim.scheduledAt}:${target.recipientId}:${target.channel}`);
          if (target.channel === "email") {
            const to = "email" in target.target ? target.target.email : null;
            if (!options.emailEnabled || !to || /[\s\r\n]/.test(to) || !to.includes("@")) return unavailable();
            const message = { to: [to], subject: `Photo date: ${claim.title}`, html: options.html(claim.title), key: `ritual-${key}` };
            checkBudget();
            const state = await rituals.begin(claim, target, digest(JSON.stringify({ from: options.emailFrom, ...message })));
            if (state === "delivered") { delivered++; continue; } if (state === "gone") continue;
            if (state === "uncertain") { uncertain = true; return unavailable(); } if (state !== "send") return unavailable();
            const outcome = await provider.email(message, AbortSignal.timeout(10000)); if (outcome.error) return unavailable();
          } else {
            const subscription = "id" in target.target ? target.target : null;
            if (!options.pushEnabled || !subscription?.endpoint || !subscription.p256dh || !subscription.auth) return unavailable();
            const actual = { id: subscription.id, endpoint: subscription.endpoint, p256dh: subscription.p256dh, auth: subscription.auth };
            checkBudget();
            const state = await rituals.begin(claim, target, digest(JSON.stringify({ target: actual, title: claim.title, topic: key.slice(0, 32) })));
            if (state === "delivered") { delivered++; continue; } if (state === "gone") continue;
            if (state === "uncertain") { uncertain = true; return unavailable(); } if (state !== "send") return unavailable();
            try { await provider.push(actual, claim.title, key.slice(0, 32), AbortSignal.timeout(10000)); }
            catch (error) {
              const status = (error as { statusCode?: number }).statusCode;
              if (status === 404 || status === 410) { await rituals.record(claim, target, "gone"); continue; }
              uncertain = true; throw error;
            }
          }
          await rituals.record(claim, target, "sent"); delivered++;
        } catch { failed = true; }
      }
    };
    await Promise.all([run(), run()]);
    try { if (failed) throw new Error("ritual target failed"); await rituals.finish(claim); if (delivered) result.sent++; else result.skipped++; }
    catch { result.failed++; await rituals.fail(claim, uncertain); }
  }
  return result;
}
