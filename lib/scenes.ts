// Shared-scene backdrops for Together mode, drawn in canvas so no image
// assets are needed. previewCss approximates the scene for picker swatches.
export interface SceneDef {
  id: string;
  name: string;
  previewCss: string;
  draw: (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) => void;
}

// mulberry32-style hash for deterministic star/photo placement
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

function vGradient(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  stops: [number, string][],
): void {
  const g = ctx.createLinearGradient(x, y, x, y + h);
  for (const [at, color] of stops) g.addColorStop(at, color);
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
}

export const SCENES: SceneDef[] = [
  {
    id: "studio-cream",
    name: "Cream studio",
    previewCss: "linear-gradient(180deg, #f5ede3, #e3d3bd)",
    draw(ctx, x, y, w, h) {
      vGradient(ctx, x, y, w, h, [
        [0, "#f5ede3"],
        [1, "#e3d3bd"],
      ]);
      const g = ctx.createRadialGradient(x + w / 2, y + h * 0.45, w * 0.1, x + w / 2, y + h * 0.45, w * 0.75);
      g.addColorStop(0, "rgba(255,255,255,0.35)");
      g.addColorStop(1, "rgba(0,0,0,0.08)");
      ctx.fillStyle = g;
      ctx.fillRect(x, y, w, h);
    },
  },
  {
    id: "studio-rose",
    name: "Rose studio",
    previewCss: "linear-gradient(180deg, #fde4e7, #f6bcc8)",
    draw(ctx, x, y, w, h) {
      vGradient(ctx, x, y, w, h, [
        [0, "#fde4e7"],
        [1, "#f6bcc8"],
      ]);
      const g = ctx.createRadialGradient(x + w / 2, y + h * 0.4, w * 0.1, x + w / 2, y + h * 0.4, w * 0.8);
      g.addColorStop(0, "rgba(255,255,255,0.4)");
      g.addColorStop(1, "rgba(136,19,55,0.08)");
      ctx.fillStyle = g;
      ctx.fillRect(x, y, w, h);
    },
  },
  {
    id: "sunset",
    name: "Sunset",
    previewCss: "linear-gradient(180deg, #ffd9a0, #ff9d6e 55%, #b06ab3)",
    draw(ctx, x, y, w, h) {
      vGradient(ctx, x, y, w, h, [
        [0, "#ffd9a0"],
        [0.55, "#ff9d6e"],
        [1, "#b06ab3"],
      ]);
      const sun = ctx.createRadialGradient(x + w / 2, y + h * 0.52, 2, x + w / 2, y + h * 0.52, w * 0.22);
      sun.addColorStop(0, "rgba(255, 244, 214, 0.95)");
      sun.addColorStop(1, "rgba(255, 244, 214, 0)");
      ctx.fillStyle = sun;
      ctx.fillRect(x, y, w, h);
    },
  },
  {
    id: "night",
    name: "Night sky",
    previewCss: "linear-gradient(180deg, #101b3c, #2a1e4f)",
    draw(ctx, x, y, w, h) {
      vGradient(ctx, x, y, w, h, [
        [0, "#0b1330"],
        [1, "#2a1e4f"],
      ]);
      const r = rand(7);
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      for (let i = 0; i < 60; i++) {
        const size = 0.6 + r() * 1.6;
        ctx.globalAlpha = 0.35 + r() * 0.65;
        ctx.fillRect(x + r() * w, y + r() * h * 0.75, size, size);
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#f6f1de";
      ctx.beginPath();
      ctx.arc(x + w * 0.8, y + h * 0.18, w * 0.07, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#151d3d";
      ctx.beginPath();
      ctx.arc(x + w * 0.83, y + h * 0.165, w * 0.06, 0, Math.PI * 2);
      ctx.fill();
    },
  },
  {
    id: "beach",
    name: "Beach",
    previewCss: "linear-gradient(180deg, #bfe6f5 55%, #6cc4d8 55%, #7db8c9 72%, #f0e3c0 72%)",
    draw(ctx, x, y, w, h) {
      vGradient(ctx, x, y, w, h * 0.55, [
        [0, "#bfe6f5"],
        [1, "#e8f6fb"],
      ]);
      vGradient(ctx, x, y + h * 0.55, w, h * 0.17, [
        [0, "#6cc4d8"],
        [1, "#8ed2df"],
      ]);
      vGradient(ctx, x, y + h * 0.72, w, h * 0.28, [
        [0, "#f0e3c0"],
        [1, "#e6d3a8"],
      ]);
      ctx.fillStyle = "rgba(255,255,255,0.55)";
      ctx.fillRect(x, y + h * 0.715, w, h * 0.012);
    },
  },
  {
    id: "polaroid-wall",
    name: "Polaroid wall",
    previewCss: "linear-gradient(180deg, #ded4c8, #cfc2b2)",
    draw(ctx, x, y, w, h) {
      vGradient(ctx, x, y, w, h, [
        [0, "#ded4c8"],
        [1, "#cfc2b2"],
      ]);
      const r = rand(21);
      const tones = ["#c9a9a6", "#a9bfb6", "#b3aecb", "#cbbfa0"];
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 4; col++) {
          const pw = w * 0.16;
          const ph = pw * 1.2;
          const px = x + w * (0.08 + col * 0.23) + (r() - 0.5) * w * 0.02;
          const py = y + h * (0.08 + row * 0.3) + (r() - 0.5) * h * 0.02;
          ctx.save();
          ctx.translate(px + pw / 2, py + ph / 2);
          ctx.rotate((r() - 0.5) * 0.22);
          ctx.fillStyle = "rgba(0,0,0,0.12)";
          ctx.fillRect(-pw / 2 + 2, -ph / 2 + 3, pw, ph);
          ctx.fillStyle = "#faf7f0";
          ctx.fillRect(-pw / 2, -ph / 2, pw, ph);
          ctx.fillStyle = tones[Math.floor(r() * tones.length)];
          ctx.fillRect(-pw / 2 + pw * 0.08, -ph / 2 + pw * 0.08, pw * 0.84, ph * 0.68);
          ctx.restore();
        }
      }
    },
  },
];

export function getScene(id: string): SceneDef | null {
  return SCENES.find((s) => s.id === id) ?? null;
}
