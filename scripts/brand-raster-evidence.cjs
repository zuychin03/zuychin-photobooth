/* eslint-disable @typescript-eslint/no-require-imports -- Local raster evidence uses the existing Sharp dependency. */
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const { rasterSpecs } = require('./generate-brand.cjs');
const root = path.resolve(__dirname, '..');

async function main() {
  const evidence = path.join(root, 'docs/development/evidence'); fs.mkdirSync(evidence, { recursive: true });
  const rows = [];
  for (const spec of rasterSpecs) {
    const { data, info } = await sharp(path.join(root, spec.file)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let maxRadius = 0, outside = 0, alphaMin = 255, alphaMax = 0;
    for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * 4, a = data[i + 3]; alphaMin = Math.min(alphaMin, a); alphaMax = Math.max(alphaMax, a);
      if (a && Math.abs(data[i] - 12) + Math.abs(data[i + 1] - 10) + Math.abs(data[i + 2] - 9) > 12) {
        const radius = Math.hypot(x + .5 - info.width / 2, y + .5 - info.height / 2) / info.width;
        maxRadius = Math.max(maxRadius, radius); if (radius > .4) outside++;
      }
    }
    rows.push({ file: spec.file, width: info.width, height: info.height, alphaMin, alphaMax, foregroundMaxRadiusFraction: maxRadius, foregroundOutsideSafeCircle: outside, maskable: Boolean(spec.maskable) });
  }
  const composites = [];
  const icon = path.join(root, 'public/icon-512-v2.png'), maskable = path.join(root, 'public/icon-512-maskable-v2.png');
  for (const [index, shape] of ['square', 'round', 'circle', 'safe'].entries()) {
    const size = 176, source = shape === 'square' ? icon : maskable;
    let image = await sharp(source).resize(size, size).png().toBuffer();
    if (shape !== 'square') {
      const mask = shape === 'round' ? `<rect width="176" height="176" rx="40" fill="white"/>` : `<circle cx="88" cy="88" r="${shape === 'safe' ? 70.4 : 88}" fill="white"/>`;
      image = await sharp(image).composite([{ input: Buffer.from(`<svg width="176" height="176">${mask}</svg>`), blend: 'dest-in' }]).png().toBuffer();
    }
    composites.push({ input: image, left: 24 + index * 200, top: 56 });
  }
  for (const [index, size] of [16, 32, 48, 96].entries()) composites.push({ input: await sharp(icon).resize(size, size).png().toBuffer(), left: 48 + index * 180, top: 316 - size / 2 });
  const labels = '<svg width="824" height="402"><style>text{font-family:Arial,sans-serif;fill:#fafaf9;font-size:15px}</style><text x="24" y="28">V2 Photobooth app icon · actual raster crops</text><text x="24" y="255">Standard</text><text x="224" y="255">Rounded mask</text><text x="424" y="255">Circular mask</text><text x="624" y="255">80% safe circle</text><text x="48" y="385">16 px</text><text x="228" y="385">32 px</text><text x="408" y="385">48 px</text><text x="588" y="385">96 px</text></svg>';
  composites.push({ input: Buffer.from(labels), left: 0, top: 0 });
  await sharp({ create: { width: 824, height: 402, channels: 4, background: '#292524' } }).composite(composites).png().toFile(path.join(evidence, 'pwa-icon-v2.png'));
  fs.writeFileSync(path.join(evidence, 'pwa-icon-v2.json'), JSON.stringify({ sharp: sharp.versions.sharp, scope: 'Decoded raster opacity, safe-circle geometry, and synthetic launcher crops. No installed-device claim.', icons: rows }, null, 2) + '\n');
  console.log(JSON.stringify(rows));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
