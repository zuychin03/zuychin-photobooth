"use client";

import { useEffect, useRef, useState } from "react";
import { Archive } from "lucide-react";
import { Section } from "@/components/ui/Section";
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
    } catch { if (token === epoch.current) setMessage("Couldn't check room storage. Close any other room tabs and try again."); }
    finally { if (token === epoch.current) setBusy(false); }
  };
  const clear = async () => {
    if (!selected || (selected.scope.kind === "account" && selected.scope.ownerId !== ownerId)) return;
    const token = epoch.current; setBusy(true); setMessage(null);
    try {
      const removed = await clearExpiredRoomMetadata(selected.scope, selected);
      if (token !== epoch.current) return;
      setRows(previous => previous?.map(row => row === selected ? { ...row, records: Math.max(0, row.records - removed), expired: Math.max(0, row.expired - removed) } : row).filter(row => row.records > 0) ?? null); setConfirm(null); setMessage(`Cleared ${removed} old room checkpoint${removed === 1 ? "" : "s"}.`);
    } catch { if (token === epoch.current) setMessage("Couldn't finish clearing. Check again and retry."); }
    finally { if (token === epoch.current) setBusy(false); }
  };
  const button = "btn btn-quiet min-h-10 text-sm";
  return <Section id="room-housekeeping-title" title="Old room data" icon={Archive} tone="slate" bodyClassName="mt-3">
    <p className="max-w-2xl text-sm text-muted-foreground">Leftovers from expired rooms. Projects and photos aren&apos;t affected.</p>
    <button type="button" className={`${button} mt-3`} disabled={busy} onClick={() => void inspect()}>{busy ? "Checking…" : "Check room storage"}</button>
    {visible && <ul className="mt-3 divide-y divide-border">{visible.map(row => <li key={`${row.scope.kind}:${row.roomId}:${row.sessionId}`} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm"><div><p>Room {row.roomId.slice(0, 8)} · {row.scope.kind === "device" ? "Device" : "Your account"}</p><p className="mt-1 text-muted-foreground">{row.records} checkpoints · {row.expired} expired{row.pending ? ` · ${row.pending} still recovering` : ""}{row.unknownExpiry ? ` · ${row.unknownExpiry} with no known expiry` : ""}</p></div><button type="button" className={button} disabled={busy || !row.expired} onClick={() => setConfirm(row)}>Clear expired</button></li>)}</ul>}
    {visible?.length === 0 && <p className="mt-3 text-sm text-muted-foreground">No saved room data here.</p>}
    {selected && <div role="alertdialog" aria-modal="false" aria-labelledby="room-clear-title" aria-describedby="room-clear-detail" className="notice mt-4"><h3 id="room-clear-title" className="font-bold">Clear this room&apos;s old data?</h3><p id="room-clear-detail" className="mt-1">This removes expired data for room {selected.roomId.slice(0, 8)}. Your projects and photos aren&apos;t affected.</p><div className="mt-3 flex flex-wrap gap-2"><button type="button" className={button} disabled={busy} onClick={() => setConfirm(null)}>Cancel</button><button type="button" className="btn btn-primary min-h-10 text-sm" disabled={busy} onClick={() => void clear()}>Clear</button></div></div>}
    {message && <p role="status" className="mt-3 text-sm">{message}</p>}
  </Section>;
}
