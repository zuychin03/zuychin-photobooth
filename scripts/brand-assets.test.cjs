/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS test harness evaluates the compiled component. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const sharp = require('sharp');
const { mark, palette, rasterSpecs, validateMark, themedSvg, squareSvg, parseArgs } = require('./generate-brand.cjs');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('local master has both approved path layers and no cross-repository dependency', () => {
  assert.equal(mark.viewBox, '320 51 610 557');
  assert.equal(mark.inkPaths.length, 6);
  assert.equal(mark.accentPaths.length, 7);
  assert.equal(validateMark().aspect, 610 / 557);
  assert.doesNotMatch(read('components/Logo.tsx'), /arcade|gallery|aperture/i);
});

test('actual Logo component preserves label, geometry and independently themed facets', () => {
  const exports = {};
  const code = ts.transpileModule(read('components/Logo.tsx'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  vm.runInNewContext(code, { exports, require: id => id === '@/lib/code-z-master.json' ? mark : require(id) });
  for (const props of [{}, { title: 'Zuychin Photobooth', className: 'text-foreground' }]) {
    const tree = exports.Logo(props);
    assert.equal(tree.type, 'svg');
    assert.equal(tree.props['aria-label'], props.title ?? 'Zuychin');
    assert.equal(tree.props.role, 'img');
    assert.equal(tree.props.fill, 'currentColor');
    assert.equal(tree.props.viewBox, mark.viewBox);
    const [ink, accent] = tree.props.children;
    assert.deepEqual(Array.from(ink.props.children, child => child.props.d), mark.inkPaths);
    assert.deepEqual(Array.from(accent.props.children, child => child.props.d), mark.accentPaths);
    assert.equal(accent.props.fill, 'var(--accent)');
  }
});

test('shared navigation owns the foreground brand on every page', () => {
  const source = read('components/SiteNav.tsx');
  assert.match(source, /<Logo\b[^>]*className="[^"]*\btext-foreground\b/);
  assert.match(source, /aria-label="Zuychin Photobooth home"/);
  assert.match(read('app/layout.tsx'), /<SiteNav\s*\/>/);
  assert.doesNotMatch(read('app/page.tsx'), /<Logo\b/);
});

test('standalone SVGs are reproducible, theme-aware and self-contained', () => {
  const expected = themedSvg();
  for (const file of ['public/favicon.svg', 'public/favicon-v2.svg', 'public/zuychin-logo.svg']) assert.equal(read(file), expected);
  for (const colour of [palette.light.ink, palette.light.accent, palette.dark.ink, palette.dark.accent]) assert(expected.includes(colour));
  assert.match(expected, /prefers-color-scheme:dark/);
  assert.doesNotMatch(expected, /<script|<image|href=|url\(/i);
});

test('decoded app tiles are opaque and the maskable artwork fits the central safe circle', async () => {
  for (const spec of rasterSpecs) {
    const png = fs.readFileSync(path.join(root, spec.file));
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(png.readUInt32BE(16), spec.size);
    assert.equal(png.readUInt32BE(20), spec.size);
    const svg = squareSvg(spec);
    if (!spec.badge) assert(svg.includes(palette.dark.ink) && svg.includes(palette.dark.accent));
    for (const d of [...mark.inkPaths, ...mark.accentPaths]) assert(svg.includes(d));
    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let visible = 0, transparent = 0;
    for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * 4;
      if (!spec.badge) assert.equal(data[i + 3], 255);
      else if (data[i + 3] === 0) transparent++;
      const foreground = Math.abs(data[i] - 12) + Math.abs(data[i + 1] - 10) + Math.abs(data[i + 2] - 9) > 12;
      if (foreground && data[i + 3]) {
        visible++;
        if (spec.maskable) assert(Math.hypot(x + .5 - info.width / 2, y + .5 - info.height / 2) <= info.width * .4, `Artwork outside safe circle at ${x},${y}`);
      }
    }
    assert(visible > 100);
    if (spec.badge) assert(transparent > data.length / 16);
    if (spec.legacy) assert(fs.readFileSync(path.join(root, spec.legacy)).equals(png));
  }
});

test('existing favicon, PWA, offline and notification URLs still resolve to updated assets', () => {
  assert.match(read('app/layout.tsx'), /icon: "\/favicon-v2.svg"/);
  assert.match(read('app/layout.tsx'), /apple: "\/apple-touch-icon-v2.png"/);
  for (const name of ['icon-192-v2.png', 'icon-512-v2.png', 'icon-512-maskable-v2.png']) assert(read('app/manifest.ts').includes('/' + name));
  assert.match(read('public/offline.html'), /src="\/icon-192-v2.png"/);
  assert.match(read('public/sw.js'), /const VERSION = "v4-photobooth-icons"/);
  assert.match(read('public/sw.js'), /badge: "\/badge-v2.png"/);
  assert.doesNotMatch(read('public/sw.js'), /self\.skipWaiting\(/);
});

test('generator requires explicit installed tooling and rejects unknown arguments', () => {
  assert.throws(() => parseArgs([]), /required/);
  assert.throws(() => parseArgs(['--install']), /Usage/);
  assert.equal(parseArgs(['--sharp-module', '.', '--check']).check, true);
});
