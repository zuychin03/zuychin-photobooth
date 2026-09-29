export function createStripPreviewGesture(ports: {
  open(mode: "tap" | "hold"): void;
  close(): void;
  schedule?(callback: () => void): () => void;
}) {
  let contact: { id: number; x: number; y: number; held: boolean } | null = null;
  let clear: (() => void) | null = null;
  const cancel = () => {
    clear?.(); clear = null;
    const held = contact?.held;
    contact = null;
    if (held) ports.close();
  };
  return {
    start(id: number, x: number, y: number) {
      if (contact) { cancel(); return; }
      const next = { id, x, y, held: false };
      contact = next;
      const schedule = ports.schedule ?? (callback => { const timer = setTimeout(callback, 300); return () => clearTimeout(timer); });
      clear = schedule(() => {
        if (contact !== next) return;
        next.held = true;
        ports.open("hold");
      });
    },
    move(id: number, x: number, y: number) {
      if (contact?.id === id && !contact.held && Math.hypot(x - contact.x, y - contact.y) > 10) cancel();
    },
    end(id: number) {
      if (contact?.id !== id) return;
      const held = contact.held;
      clear?.(); clear = null; contact = null;
      if (held) ports.close(); else ports.open("tap");
    },
    otherPointer(id: number) { if (contact && contact.id !== id) cancel(); },
    cancel,
  };
}
