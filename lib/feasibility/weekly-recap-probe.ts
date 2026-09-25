import { composeRecap, renderWeeklyRecap, weeklyRecapGeometry, type WeeklyRecapPorts } from "../recap";

export async function runWeeklyRecapProbe() {
  if (process.env.NODE_ENV !== "development") throw new Error("Development only");
  const checks: { name: string; passed: boolean; detail: string }[] = [];
  const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
  const canvases: HTMLCanvasElement[] = [], colours = ["#ed3344", "#22bb66", "#3355ee", "#eeaa22"];
  const canvas = () => { const value = document.createElement("canvas"); canvases.push(value); return value; };
  const encode = (value: HTMLCanvasElement) => new Promise<Blob>((resolve, reject) => value.toBlob(blob => blob ? resolve(blob) : reject(new Error("PNG encode failed")), "image/png"));
  const blobs: Blob[] = []; let live = 0, maximum = 0, active = true, changed = false;
  const sources = colours.map((_, index) => ({ id: String(index), async resolve() { return { url: `https://synthetic.invalid/${index}`, fingerprint: changed ? "changed" : String(index) }; } }));
  const ports: WeeklyRecapPorts = {
    fetch: async url => new Response(blobs[Number(String(url).split("/").at(-1))], { headers: { "Content-Type": "image/png" } }),
    decode: async blob => { const bitmap = await createImageBitmap(blob); maximum = Math.max(maximum, ++live); const close = bitmap.close.bind(bitmap); bitmap.close = () => { close(); live--; }; return bitmap; },
    canvas, compose: (values, title) => { const value = composeRecap(values, title, 2); canvases.push(value); return value; }, encode,
  };
  const options = { assertActive() { if (!active) throw new Error("synthetic_account_changed"); } };
  const run = async (name: string, operation: () => Promise<string>) => { try { checks.push({ name, passed: true, detail: await operation() }); } catch (error) { checks.push({ name, passed: false, detail: error instanceof Error ? error.message : "Failed" }); } };
  try {
    for (const colour of colours) { const value = canvas(); value.width = 2030; value.height = 1184; const context = value.getContext("2d")!; context.fillStyle = colour; context.fillRect(0, 0, value.width, value.height); blobs.push(await encode(value)); value.width = value.height = 0; }
    await run("Four native Quad strips retain all colours within 4096 pixels", async () => {
      const result = await renderWeeklyRecap(sources, "Synthetic week", options, ports), bitmap = await createImageBitmap(result.blob);
      try {
        check(result.width === 4096 && bitmap.width === result.width && bitmap.height === result.height, "Output geometry differs");
        const value = canvas(); value.width = bitmap.width; value.height = bitmap.height; const context = value.getContext("2d")!; context.drawImage(bitmap, 0, 0);
        const geometry = weeklyRecapGeometry(colours.map(() => ({ width: 640, height: Math.round(1184 * 640 / 2030) })));
        for (let index = 0; index < colours.length; index++) {
          const x = Math.floor((48 + index * (geometry.colW + 28) + geometry.colW / 2) * geometry.renderScale), y = Math.floor((48 + 130 + 320) * geometry.renderScale);
          const pixel = context.getImageData(x, y, 1, 1).data, expected = colours[index].slice(1).match(/../g)!.map(value => parseInt(value, 16));
          check(expected.every((channel, i) => Math.abs(channel - pixel[i]) <= 2), `Source ${index + 1} changed`);
        }
        check(maximum === 1 && live === 0, "Native original decodes overlapped"); value.width = value.height = 0;
        return `${result.width}×${result.height}; four source colours, one original decoded at a time`;
      } finally { bitmap.close(); }
    });
    await run("Source revocation after native encode prevents publication", async () => {
      let refused = false; changed = false;
      try { await renderWeeklyRecap(sources, "Revoked week", options, { ...ports, encode: async value => { const blob = await encode(value); changed = true; return blob; } }); } catch (error) { refused = error instanceof Error && error.message.includes("source photo changed"); }
      check(refused, "Revoked source output escaped"); changed = false; return "Final fresh source check refused the rendered PNG";
    });
    await run("Account change after native encode prevents publication", async () => {
      let refused = false;
      try { await renderWeeklyRecap(sources.slice(0, 1), "Changed account", options, { ...ports, encode: async value => { const blob = await encode(value); active = false; return blob; } }); } catch (error) { refused = error instanceof Error && error.message === "synthetic_account_changed"; }
      check(refused, "Previous account output escaped"); active = true; return "No private output returned after identity change";
    });
    await run("A fresh native recap succeeds after rejected work", async () => { const result = await renderWeeklyRecap(sources.slice(0, 1), "Retry", options, ports); check(result.blob.size > 0 && live === 0, "Retry failed to release originals"); return `${result.width}×${result.height}; retry completed`; });
  } finally { for (const value of canvases) value.width = value.height = 0; blobs.length = 0; }
  return { passed: checks.every(value => value.passed), checks };
}
