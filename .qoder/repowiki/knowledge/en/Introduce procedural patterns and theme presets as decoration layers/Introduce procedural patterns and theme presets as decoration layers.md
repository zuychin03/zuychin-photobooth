---
kind: design
name: Introduce procedural patterns and theme presets as decoration layers
source: session
category: adr
---

# Introduce procedural patterns and theme presets as decoration layers

_Source: coding plans from commit period 143860c → adc8ffe - records intent at planning time; the implementation may lag or differ._

**Status:** accepted

## Context
Strips were previously plain solid-color frames with only manually-placed stickers. Users wanted richer visual variety without requiring custom assets, and the existing compose pipeline had no room for layered decorations.

## Decision drivers
- procedural generation avoids asset bloat
- deterministic preview/export parity via seeded RNG
- non-interactive baked decor keeps editor simple
- layered draw order preserves user sticker interactivity

## Considered options
- **Procedural pattern registry (patterns.ts) + theme presets (themes.ts)** - pros: no extra assets to ship; deterministic via mulberry32; themes bundle frame+pattern+decor in one selection; ink-tinted alpha keeps text legible
- **Pre-rendered PNG textures for patterns** _(rejected)_ - pros: exact control over look; cons: asset explosion per frame color; no ink tinting; harder to maintain consistency across colors
- **CSS-only swatches for pattern previews** _(rejected)_ - pros: no canvas needed; cons: hand-crafted CSS approximations are brittle and hard to match actual render; canvas-based PatternSwatch is more reliable

## Decision
Add a `lib/patterns.ts` registry of procedural draw functions (dots, stripes, checker, grid, confetti, stars, hearts) and a `lib/themes.ts` registry bundling frameId + patternId + stickerStyle + fixed decor positions. The composer draws frame fill → pattern → cells → footer → theme decor → user stickers, keeping user stickers interactive on top.

## Consequences
Editor gains two new controls (Pattern swatches and Theme cards). Asset preloading must also preload theme decor stickers so exports never fall back to placeholders. Patterns use low alpha ink tinting so caption/datestamp remain readable. Themes intentionally overlap cell corners slightly for a decorated-booth aesthetic.