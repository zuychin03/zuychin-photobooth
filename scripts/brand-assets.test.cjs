/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS test harness evaluates the compiled component. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const { mark, palette, rasterSpecs, validateMark, themedSvg, squareSvg, parseArgs } = require('./generate-brand.cjs');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('local master has both approved path layers and no cross-repository dependency', () => {
  assert.equal(mark.viewBox, '320 51 610 557');
  assert.equal(mark.inkPaths.length, 9);
  assert.equal(mark.accentPaths.length, 4);
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

test('home uses foreground ink and retains the existing responsive logo height', () => {
  const source = read('app/page.tsx');
  assert.match(source, /<Logo className="hero-animate h-12 w-auto text-foreground sm:h-14"/);
  assert.match(source, /Zuychin Photobooth/);
});

test('standalone SVGs are reproducible, theme-aware and self-contained', () => {
  const expected = themedSvg();
  for (const file of ['public/favicon.svg', 'public/zuychin-logo.svg']) assert.equal(read(file), expected);
  for (const colour of [palette.light.ink, palette.light.accent, palette.dark.ink, palette.dark.accent]) assert(expected.includes(colour));
  assert.match(expected, /prefers-color-scheme:dark/);
  assert.doesNotMatch(expected, /<script|<image|href=|url\(/i);
});

test('raster output dimensions and maskable safe region match existing consumer contracts', () => {
  for (const spec of rasterSpecs) {
    const png = fs.readFileSync(path.join(root, spec.file));
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(png.readUInt32BE(16), spec.size);
    assert.equal(png.readUInt32BE(20), spec.size);
    const svg = squareSvg(spec);
    assert(svg.includes(palette.dark.ink) && svg.includes(palette.dark.accent));
    if (spec.file.includes('maskable')) assert(Math.hypot(spec.fraction, spec.fraction / validateMark().aspect) <= 0.8);
  }
});

test('existing favicon, PWA, offline and notification URLs still resolve to updated assets', () => {
  assert.match(read('app/layout.tsx'), /icon: "\/favicon.svg"/);
  assert.match(read('app/layout.tsx'), /apple: "\/apple-touch-icon.png"/);
  for (const name of ['icon-192.png', 'icon-512.png', 'icon-512-maskable.png']) assert(read('app/manifest.ts').includes('/' + name));
  assert.match(read('public/offline.html'), /src="\/favicon.svg"/);
  assert.match(read('public/sw.js'), /const VERSION = "v2-code-z"/);
  assert.match(read('public/sw.js'), /badge: "\/icon-192.png"/);
});

test('generator requires explicit installed tooling and rejects unknown arguments', () => {
  assert.throws(() => parseArgs([]), /required/);
  assert.throws(() => parseArgs(['--install']), /Usage/);
  assert.equal(parseArgs(['--sharp-module', '.', '--check']).check, true);
});
