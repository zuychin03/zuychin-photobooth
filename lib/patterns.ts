// Frame textures drawn procedurally in the frame's ink color at low alpha,
// so every pattern pairs with every frame color and captions stay readable.
// Cells paint over the texture, leaving it visible in margins/gaps/footer.
export interface PatternDef {
  id: string;
  name: string;
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number, ink: string) => void;
}

// mulberry32-style hash so scatter patterns render identically in preview/export
function rand(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function heartPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const top = h * 0.3;
  ctx.beginPath();
  ctx.moveTo(x, y + top);
  ctx.bezierCurveTo(x, y, x - w / 2, y, x - w / 2, y + top);
  ctx.bezierCurveTo(x - w / 2, y + (h + top) / 2, x, y + (h + top) / 1.4, x, y + h);
  ctx.bezierCurveTo(x, y + (h + top) / 1.4, x + w / 2, y + (h + top) / 2, x + w / 2, y + top);
  ctx.bezierCurveTo(x + w / 2, y, x, y, x, y + top);
  ctx.closePath();
}

function sparklePath(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, rot: number) {
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const rad = i % 2 === 0 ? r : r * 0.32;
    const a = rot + (i * Math.PI) / 4;
    const px = x + Math.cos(a) * rad;
    const py = y + Math.sin(a) * rad;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

export const PATTERNS: PatternDef[] = [
  {
    id: "dots",
    name: "Polka dots",
    draw(ctx, w, h, ink) {
      ctx.save();
      ctx.globalAlpha = 0.14;
      ctx.fillStyle = ink;
      const gap = 56;
      for (let row = 0, y = gap / 2; y < h; y += gap, row++) {
        const off = row % 2 ? gap / 2 : 0;
        for (let x = gap / 2 + off; x < w; x += gap) {
          ctx.beginPath();
          ctx.arc(x, y, 6.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    },
  },
  {
    id: "stripes",
    name: "Diagonal stripes",
    draw(ctx, w, h, ink) {
      ctx.save();
      ctx.globalAlpha = 0.1;
      ctx.fillStyle = ink;
      ctx.beginPath();
      ctx.rect(0, 0, w, h);
      ctx.clip();
      ctx.translate(w / 2, h / 2);
      ctx.rotate(-Math.PI / 4);
      const diag = Math.hypot(w, h);
      for (let x = -diag / 2; x < diag / 2; x += 44) {
        ctx.fillRect(x, -diag / 2, 10, diag);
      }
      ctx.restore();
    },
  },
  {
    id: "checker",
    name: "Checkerboard",
    draw(ctx, w, h, ink) {
      ctx.save();
      ctx.globalAlpha = 0.08;
      ctx.fillStyle = ink;
      const s = 46;
      for (let row = 0; row * s < h; row++) {
        for (let col = 0; col * s < w; col++) {
          if ((row + col) % 2 === 0) ctx.fillRect(col * s, row * s, s, s);
        }
      }
      ctx.restore();
    },
  },
  {
    id: "grid",
    name: "Graph grid",
    draw(ctx, w, h, ink) {
      ctx.save();
      ctx.globalAlpha = 0.12;
      ctx.fillStyle = ink;
      const s = 44;
      for (let x = s; x < w; x += s) ctx.fillRect(x - 1, 0, 2, h);
      for (let y = s; y < h; y += s) ctx.fillRect(0, y - 1, w, 2);
      ctx.restore();
    },
  },
  {
    id: "confetti",
    name: "Confetti",
    draw(ctx, w, h, ink) {
      const r = rand(42);
      ctx.save();
      ctx.fillStyle = ink;
      for (let i = 0; i < 150; i++) {
        ctx.globalAlpha = 0.08 + r() * 0.1;
        const x = r() * w;
        const y = r() * h;
        if (r() < 0.5) {
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(r() * Math.PI);
          ctx.fillRect(-5, -1.75, 10 + r() * 6, 3.5);
          ctx.restore();
        } else {
          ctx.beginPath();
          ctx.arc(x, y, 2 + r() * 2.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    },
  },
  {
    id: "stars",
    name: "Sparkles",
    draw(ctx, w, h, ink) {
      const r = rand(7);
      ctx.save();
      ctx.fillStyle = ink;
      for (let i = 0; i < 70; i++) {
        ctx.globalAlpha = 0.1 + r() * 0.12;
        sparklePath(ctx, r() * w, r() * h, 4 + r() * 8, r() * Math.PI);
        ctx.fill();
      }
      ctx.restore();
    },
  },
  {
    id: "hearts",
    name: "Hearts",
    draw(ctx, w, h, ink) {
      ctx.save();
      ctx.globalAlpha = 0.13;
      ctx.fillStyle = ink;
      const gap = 64;
      for (let row = 0, y = gap / 2; y < h; y += gap, row++) {
        const off = row % 2 ? gap / 2 : 0;
        for (let x = gap / 2 + off; x < w; x += gap) {
          heartPath(ctx, x, y - 8, 16, 15);
          ctx.fill();
        }
      }
      ctx.restore();
    },
  },
];

export function getPattern(id: string | null | undefined): PatternDef | null {
  return PATTERNS.find((p) => p.id === id) ?? null;
}
