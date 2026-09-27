import { EventClientError } from "./client";
import type { EventPostcardClient } from "./postcard-client";
import type { PostcardView } from "./postcard-contract";
import type { PostcardDraft } from "./postcard-journal";
import { postcardOrigin } from "./postcard-transport";

export async function copyPostcardReceipt(client: Pick<EventPostcardClient, "eventId" | "guestId" | "assertActive" | "view" | "reserve">, draft: PostcardDraft, origin: string, write: (link: string) => Promise<void>, signal: AbortSignal): Promise<void> {
  const base = postcardOrigin(origin), { postcardId, submissionId } = draft.proposal;
  const active = () => { if (signal.aborted) throw new EventClientError("cancelled"); client.assertActive(signal); };
  const eligible = (view: PostcardView) => {
    active();
    if (view.eventId !== draft.eventId || view.postcardId !== postcardId || view.submissionId !== submissionId || JSON.stringify(view.source) !== JSON.stringify(draft.proposal.source) || JSON.stringify(view.design) !== JSON.stringify(draft.proposal.design)) throw new EventClientError("conflict");
    if (!view.canSubmit || !view.selfConsent.submission) throw new EventClientError("access_denied");
    if (view.state !== "ready" || Date.parse(view.expiresAt) <= Date.now()) throw new EventClientError("not_ready");
  };
  active();
  if (client.eventId !== draft.eventId || client.guestId !== draft.guestId) throw new EventClientError("identity_changed");
  if (!draft.receipt) throw new EventClientError("journal_unavailable");
  eligible(await client.view(postcardId, signal));
  const result = await client.reserve(postcardId, submissionId, draft.reserveRequestId, signal);
  active();
  if (result.receipt.state !== "ready" || result.receipt.submissionId !== submissionId || Date.parse(result.receipt.eventExpiresAt) <= Date.now() || result.fragmentOnly !== true || !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(result.receiptToken)) throw new EventClientError("invalid_response");
  eligible(await client.view(postcardId, signal));
  await write(`${base}/receipt/${submissionId}?event=${draft.eventId}#token=${result.receiptToken}`);
  active();
}
