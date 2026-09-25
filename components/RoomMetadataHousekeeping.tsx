"use client";

import { useEffect, useRef, useState } from "react";
import type { ProjectScope } from "@/lib/projects/model";
import { clearExpiredRoomMetadata, inspectRoomMetadata, type RoomMetadataSummary } from "@/lib/rtc/local-cleanup";

type Row = RoomMetadataSummary & { scope: ProjectScope };
export function RoomMetadataHousekeeping({ ownerId }: { ownerId: string | null }) {
  const [rows, setRows] = useState<Row[] | null>(null), [confirm, setConfirm] = useState<Row | null>(null), [busy, setBusy] = useState(false), [message, setMessage] = useState<string | null>(null);
  const epoch = useRef(0);
  useEffect(() => { const token = ++epoch.current; queueMicrotask(() => { if (token === epoch.current) { setBusy(false); setRows(null); setConfirm(null); setMessage(null); } }); return () => { epoch.current = token + 1; }; }, [ownerId]);
  const visible = rows?.filter(row => row.scope.kind === "device" || row.scope.ownerId === ownerId);
  const selected = confirm && (confirm.scope.kind === "device" || confirm.scope.ownerId === ownerId) ? confirm : null;
  const inspect = async () => {
    const token = epoch.current; setBusy(true); setMessage(null);
    try {
      const scopes: ProjectScope[] = [{ kind: "device" }, ...(ownerId ? [{ kind: "account" as const, ownerId }] : [])], result: Row[] = [];
      for (const scope of scopes) result.push(...(await inspectRoomMetadata(scope)).map(row => ({ ...row, scope })));
      if (token === epoch.current) setRows(result);
    } catch { if (token === epoch.current) setMessage("Room storage could not be inspected. Close other room tabs and try again."); }
    finally { if (token === epoch.current) setBusy(false); }
  };
  const clear = async () => {
    if (!selected || (selected.scope.kind === "account" && selected.scope.ownerId !== ownerId)) return;
    const token = epoch.current; setBusy(true); setMessage(null);
    try {
      const removed = await clearExpiredRoomMetadata(selected.scope, selected);
      if (token !== epoch.current) return;
      setRows(previous => previous?.map(row => row === selected ? { ...row, records: Math.max(0, row.records - removed), expired: Math.max(0, row.expired - removed) } : row).filter(row => row.records > 0) ?? null); setConfirm(null); setMessage(`${removed} expired room checkpoint${removed === 1 ? "" : "s"} cleared. Saved projects and originals are unchanged.`);
    } catch { if (token === epoch.current) setMessage("Clearing could not finish. Active rooms, pending recovery and saved projects are retained. Try inspecting again."); }
    finally { if (token === epoch.current) setBusy(false); }
  };
  const button = "min-h-11 rounded-lg border border-border px-4 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50";
  return <section className="mt-6 border-t border-border pt-6" aria-labelledby="room-housekeeping-title">
    <h2 id="room-housekeeping-title" className="font-medium">Expired room checkpoints</h2>
    <p className="mt-2 max-w-2xl text-sm text-foreground/70">Room designs and recovery checkpoints use a small separate store. Review expired rooms to free checkpoint space. Clearing here preserves every saved project and original photo.</p>
    <button type="button" className={`${button} mt-3`} disabled={busy} onClick={() => void inspect()}>{busy ? "Working…" : "Inspect room storage"}</button>
    {visible && <ul className="mt-3 divide-y divide-border">{visible.map(row => <li key={`${row.scope.kind}:${row.roomId}:${row.sessionId}`} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm"><div><p>Room {row.roomId.slice(0, 8)} · {row.scope.kind === "device" ? "Device" : "Your account"}</p><p className="mt-1 text-foreground/65">{row.records} checkpoints · {row.expired} safely expired{row.pending ? ` · ${row.pending} pending recovery` : ""}{row.unknownExpiry ? ` · ${row.unknownExpiry} without verified expiry` : ""}</p></div><button type="button" className={button} disabled={busy || !row.expired} onClick={() => setConfirm(row)}>Clear expired checkpoints</button></li>)}</ul>}
    {visible?.length === 0 && <p className="mt-3 text-sm text-foreground/65">No room checkpoints in your visible scopes.</p>}
    {selected && <div role="alertdialog" aria-modal="false" aria-labelledby="room-clear-title" aria-describedby="room-clear-detail" className="mt-4 rounded-xl border border-border bg-muted p-4"><h3 id="room-clear-title" className="font-medium">Clear this room&apos;s expired checkpoints?</h3><p id="room-clear-detail" className="mt-2 text-sm">This removes expired connection and design checkpoints for room {selected.roomId.slice(0, 8)}. Saved projects, original photos, active checkpoints and pending recovery stay on this device.</p><div className="mt-3 flex flex-wrap gap-2"><button type="button" className={button} disabled={busy} onClick={() => setConfirm(null)}>Keep checkpoints</button><button type="button" className={`${button} bg-accent text-accent-foreground`} disabled={busy} onClick={() => void clear()}>Clear expired checkpoints</button></div></div>}
    {message && <p role="status" className="mt-3 text-sm">{message}</p>}
  </section>;
}
