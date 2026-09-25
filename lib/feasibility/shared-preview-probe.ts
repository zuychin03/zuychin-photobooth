import { SharedPreviewPainter, type SharedPreviewInput, type SharedPreviewStatus } from "../shared-preview";
import { getScene } from "../scenes";
import type { Role } from "../layouts";
import type { ProbeResult } from "./types";

export interface SyntheticPeople { inputs: SharedPreviewInput[]; stop(): void }
export async function createSyntheticPeople(count: 2 | 4): Promise<SyntheticPeople> {
  if (process.env.NODE_ENV !== "development") throw new Error("Synthetic people are development-only");
  const inputs: SharedPreviewInput[] = [], streams: MediaStream[] = [], canvases: HTMLCanvasElement[] = [];
  let timer: ReturnType<typeof setInterval> | null = null, frame = 0;
  const stop = () => { if (timer) clearInterval(timer); timer = null; inputs.forEach(input => { input.video.pause(); input.video.srcObject = null; input.video.remove(); }); streams.forEach(stream => stream.getTracks().forEach(track => track.stop())); canvases.forEach(canvas => { canvas.width = canvas.height = 0; }); };
  const paint = () => {
    canvases.forEach((canvas, index) => {
      const ctx = canvas.getContext("2d")!, sway = Math.sin(frame / 10 + index) * 4;
      ctx.fillStyle = "#eee7db"; ctx.fillRect(0, 0, 240, 320);
      ctx.fillStyle = ["#bd4869", "#218879", "#5553b9", "#c8842d"][index];
      ctx.beginPath(); ctx.ellipse(120 + sway, 78, 31, 38, 0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.moveTo(96 + sway, 119); ctx.lineTo(143 + sway, 119); ctx.lineTo(169 + sway, 256); ctx.lineTo(74 + sway, 256); ctx.closePath(); ctx.fill();
      ctx.lineWidth = 22; ctx.lineCap = "round"; ctx.beginPath(); ctx.moveTo(94 + sway, 133); ctx.lineTo(53 + sway, 209); ctx.moveTo(145 + sway, 133); ctx.lineTo(184 + sway, 198); ctx.moveTo(104 + sway, 242); ctx.lineTo(91 + sway, 320); ctx.moveTo(141 + sway, 242); ctx.lineTo(151 + sway, 320); ctx.strokeStyle = ctx.fillStyle; ctx.stroke();
      ctx.fillStyle = "#fffaf4"; ctx.font = "bold 28px sans-serif"; ctx.fillText((["A", "B", "C", "D"] as const)[index], 111 + sway, 191);
    }); frame++;
  };
  try {
    for (let index = 0; index < count; index++) { const canvas = document.createElement("canvas"); canvas.width = 240; canvas.height = 320; canvases.push(canvas); }
    paint(); timer = setInterval(paint, 125);
    for (let index = 0; index < count; index++) {
      const video = document.createElement("video"); video.muted = true; video.playsInline = true; video.setAttribute("aria-label", `Synthetic person ${index + 1}`);
      const stream = canvases[index].captureStream(8); streams.push(stream); video.srcObject = stream;
      inputs.push({ role: (["A", "B", "C", "D"] as Role[])[index], video, mirror: index === 0 });
      await new Promise<void>((resolve, reject) => { const timeout = setTimeout(() => reject(new Error("Synthetic playback timed out")), 10000); void video.play().then(() => { clearTimeout(timeout); resolve(); }, error => { clearTimeout(timeout); reject(error); }); });
    }
    return { inputs, stop };
  } catch (error) { stop(); throw error; }
}

export async function runSharedPreviewProbe(): Promise<ProbeResult[]> {
  if (process.env.NODE_ENV !== "development") throw new Error("Shared preview probe is development-only");
  const results: ProbeResult[] = [];
  for (const count of [2, 4] as const) {
    const fixture = await createSyntheticPeople(count), canvas = document.createElement("canvas");
    let status: SharedPreviewStatus | null = null, updates = 0;
    const painter = new SharedPreviewPainter(canvas, { onStatus: value => { status = value; updates++; } });
    const config = { inputs: fixture.inputs, intendedRoles: fixture.inputs.map(input => input.role), localRole: "A" as const, scene: getScene("studio-cream"), places: { A: { dx: -0.05, dy: 0, scale: 0.9 } } };
    try {
      painter.start({ ...config, scene: null }); await painter.renderFrame();
      if ((status as SharedPreviewStatus | null)?.mode !== "originals") throw new Error("Original tiles were not ready");
      painter.update(config);
      const until = Date.now() + 40000;
      while (true) {
        await new Promise(resolve => setTimeout(resolve, 50));
        const current = status as SharedPreviewStatus | null;
        if (current?.mode === "together" || current?.reason === "slow-segmentation") break;
        if (current?.reason === "segmentation-unavailable" || Date.now() > until) throw new Error("Native segmentation did not become available");
      }
      const completed = status as SharedPreviewStatus | null;
      if (completed?.displayedRoles.length !== count || canvas.width > 640 || canvas.height > 640) throw new Error("Shared preview omitted a person or exceeded its canvas bound");
      results.push({ id: `shared-preview-native-${count}`, status: "pass", detail: `Local IMAGE segmenter ran with ${count} synthetic sources. Result: ${completed.mode}; measured group work ${completed.inferenceMs?.toFixed(1)} ms. Silhouettes do not verify real human edges.` });
      let final = completed;
      if (completed.reason === "slow-segmentation") {
        const previousUpdates = updates, retryDeadline = Date.now() + 15000; painter.retryTogether();
        while (true) {
          await new Promise(resolve => setTimeout(resolve, 50));
          const current = status as SharedPreviewStatus | null;
          if (updates > previousUpdates && (current?.mode === "together" || current?.reason === "slow-segmentation")) { final = current; break; }
          if (current?.reason === "segmentation-unavailable" || Date.now() > retryDeadline) throw new Error("Warm preview retry did not settle");
        }
        results.push({ id: `shared-preview-warm-retry-${count}`, status: "pass", detail: `One explicit retry reused the existing model with unchanged bounds. Initial work: ${completed.inferenceMs?.toFixed(1)} ms. Warm work: ${final.inferenceMs?.toFixed(1)} ms; result: ${final.mode}.` });
      }
      results.push({ id: `shared-preview-together-rendered-${count}`, status: final.mode === "together" ? "pass" : "unsupported", detail: final.mode === "together" ? `All ${count} intended sources reached the Together compositor on this desktop; synthetic masks do not prove human segmentation quality.` : "This desktop retained the bounded originals fallback after warm retry. Actual all-person Together drawing remains unverified for this run." });
      fixture.inputs[1].video.pause(); painter.update(config); await painter.renderFrame();
      const paused = status as SharedPreviewStatus | null;
      if (paused?.mode !== "local-only" || !paused.missingRoles.includes("B")) throw new Error("Paused peer falsely remained in Together");
      painter.update({ ...config, inputs: fixture.inputs.slice(0, 1) }); await painter.renderFrame();
      if ((status as SharedPreviewStatus | null)?.mode !== "local-only") throw new Error("Missing peer fallback failed");
      results.push({ id: `shared-preview-fallback-${count}`, status: "pass", detail: "Paused and missing peer states show a labelled local-only original instead of incomplete Together." });
      await painter.dispose(); const context = canvas.getContext("2d")!, after = context.getImageData(0, 0, 1, 1).data[3];
      await new Promise(resolve => setTimeout(resolve, 180));
      if (after !== 0 || context.getImageData(0, 0, 1, 1).data[3] !== 0) throw new Error("Disposed renderer repainted its target");
      results.push({ id: `shared-preview-disposal-${count}`, status: "pass", detail: "Native model disposed and the cleared target stayed clear after its scheduled frame interval." });
    } finally { await painter.dispose(); fixture.stop(); canvas.width = canvas.height = 0; }
  }
  return results;
}
