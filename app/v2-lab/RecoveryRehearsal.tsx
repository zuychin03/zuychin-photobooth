"use client";
import { useRef, useState } from "react";
import { TemplateRow, type Recovery, type ShelfRow } from "@/components/TemplateRow";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWNYbxHxHwAFGAI/KI6gOQAAAABJRU5ErkJggg==";
export function RecoveryRehearsal() {
  const [kind, setKind] = useState<"future" | "damaged">("future"), [visible, setVisible] = useState(false), [recovery, setRecovery] = useState<Recovery | null>(null), [status, setStatus] = useState("No recovery fixture open."), [fail, setFail] = useState(false);
  const rowArea = useRef<HTMLUListElement>(null);
  if (process.env.NODE_ENV !== "development") return null;
  if (fail) throw new Error("Synthetic development render failure");
  const item: ShelfRow = { id: `synthetic-${kind}`, key: `device/synthetic-${kind}`, scope: { kind: "device" }, name: kind === "future" ? "Synthetic future recipe" : "Synthetic damaged recipe", revision: 0, updatedAt: null, readOnly: true };
  const button = "min-h-11 rounded-xl border border-border px-4 py-2 text-sm focus-visible:outline-2 focus-visible:outline-ring";
  const show = (value: typeof kind) => { setKind(value); setVisible(true); setRecovery(null); setStatus(`Showing synthetic ${value} read-only data. No shelf was opened or written.`); };
  return <section className="mt-10 border-y border-border py-7" aria-labelledby="recovery-rehearsal-heading"><h2 id="recovery-rehearsal-heading" className="font-display text-xl">Template recovery and page error rehearsal</h2><p className="mt-2 max-w-2xl text-sm text-muted-foreground">Actual template-row controls with synthetic read-only data, raw JSON and a one-pixel PNG. No private data or ordinary shelf writes. The error control deliberately leaves this lab for the real framework fallback.</p><div className="mt-4 flex flex-wrap gap-3"><button className={button} onClick={() => show("future")}>Show future recipe</button><button className={button} onClick={() => show("damaged")}>Show damaged recipe</button><button className={button} disabled={!visible} onClick={() => { const actions = Array.from(rowArea.current?.querySelectorAll("button,a,input") ?? []).map(element => element.textContent?.trim() ?? ""); const forbidden = actions.filter(label => /Use in current project|New project|Design|Rename|Duplicate|Save name|^Export$/.test(label)); setStatus(forbidden.length ? `FAIL: unexpected editable controls: ${forbidden.join(", ")}` : "PASS: no edit, apply, new-project, rename, duplicate or regular export controls are rendered."); }}>Check read-only controls</button><button className={button} onClick={() => setFail(true)}>Trigger test error</button></div><p role="status" className="mt-4 text-sm">{status}</p><ul ref={rowArea} aria-label="Synthetic read-only template">{visible && <TemplateRow key={item.key} item={item} busy={false} canApply={true} recovery={recovery} act={async (row, action) => {
    if (action === "raw") { const raw = kind === "future" ? JSON.stringify({ schemaVersion: 999, id: row.id, synthetic: true }, null, 2) : '{"schemaVersion":1,"synthetic":true,"damaged":'; setRecovery({ key: row.key, manifest: new Blob([raw], { type: "application/json" }), decorations: new Map([["synthetic-decoration", new Blob([Uint8Array.from(atob(png), value => value.charCodeAt(0))], { type: "image/png" })]]) }); setStatus("Synthetic recovery files prepared. Download delivery must be checked separately."); return true; }
    if (action === "delete") { setVisible(false); setRecovery(null); setStatus("Synthetic row removed from this rehearsal only. No stored template was changed."); return true; }
    setStatus(`FAIL: unexpected ${action} action.`); return false;
  }} />}</ul></section>;
}
