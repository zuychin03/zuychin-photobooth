/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS CLI loads explicitly supplied local tooling. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Buffer } = require('node:buffer');
const mark = require('../lib/code-z-master.json');

const root = path.resolve(__dirname, '..');
const palette = {
  light: { ink: '#1c1917', accent: '#e11d48' },
  dark: { ink: '#fafaf9', accent: '#fb7185', background: '#0c0a09' },
};
const rasterSpecs = [
  { file: 'public/apple-touch-icon.png', size: 180, fraction: 0.84 },
  { file: 'public/icon-192.png', size: 192, fraction: 0.84 },
  { file: 'public/icon-512.png', size: 512, fraction: 0.84 },
  { file: 'public/icon-512-maskable.png', size: 512, fraction: 0.58 },
];

function validateMark() {
  const box = mark.viewBox.split(/\s+/).map(Number);
  assert(box.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0);
  for (const paths of [mark.inkPaths, mark.accentPaths]) {
    assert(Array.isArray(paths) && paths.length > 0);
    assert(paths.every(d => typeof d === 'string' && /^[MmLlHhVvCcSsQqTtAaZz\d\s.,+-]+$/.test(d)), 'Only SVG path data is allowed');
  }
  return { aspect: box[2] / box[3] };
}

function paths(data) { return data.map(d => `<path d="${d}"/>`).join(''); }
function themedSvg() {
  validateMark();
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${mark.viewBox}"><style>.ink{fill:${palette.light.ink}}.accent{fill:${palette.light.accent}}@media(prefers-color-scheme:dark){.ink{fill:${palette.dark.ink}}.accent{fill:${palette.dark.accent}}}</style><g class="ink">${paths(mark.inkPaths)}</g><g class="accent">${paths(mark.accentPaths)}</g></svg>\n`;
}

function squareSvg({ size, fraction }) {
  const { aspect } = validateMark();
  const width = size * fraction;
  const height = width / aspect;
  assert(width <= size && height <= size);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" fill="${palette.dark.background}"/><svg x="${(size - width) / 2}" y="${(size - height) / 2}" width="${width}" height="${height}" viewBox="${mark.viewBox}" preserveAspectRatio="xMidYMid meet"><g fill="${palette.dark.ink}">${paths(mark.inkPaths)}</g><g fill="${palette.dark.accent}">${paths(mark.accentPaths)}</g></svg></svg>\n`;
}

function parseArgs(args) {
  let sharpModule;
  let check = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--check' && !check) check = true;
    else if (args[i] === '--sharp-module' && !sharpModule && args[i + 1] && !args[i + 1].startsWith('--')) sharpModule = path.resolve(args[++i]);
    else throw new Error('Usage: node scripts/generate-brand.cjs --sharp-module <installed Sharp path> [--check]');
  }
  assert(sharpModule, '--sharp-module is required; no dependencies are installed');
  return { sharpModule, check };
}

async function main(args) {
  const { sharpModule, check } = parseArgs(args);
  const sharp = require(sharpModule);
  const artifacts = { 'public/favicon.svg': themedSvg(), 'public/zuychin-logo.svg': themedSvg() };
  for (const spec of rasterSpecs) artifacts[spec.file] = await sharp(Buffer.from(squareSvg(spec))).png().toBuffer();
  for (const [file, content] of Object.entries(artifacts)) {
    const target = path.join(root, file);
    if (check) assert(fs.readFileSync(target).equals(Buffer.from(content)), `Generated asset drift: ${file}`);
    else fs.writeFileSync(target, content);
  }
  console.log(JSON.stringify({ mode: check ? 'checked' : 'generated', master: 'lib/code-z-master.json', files: Object.keys(artifacts), sharp: sharp.versions.sharp }));
}

module.exports = { mark, palette, rasterSpecs, validateMark, themedSvg, squareSvg, parseArgs };
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
