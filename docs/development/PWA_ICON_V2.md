# V2 PWA icon

Updated locally on 23/09/2026. The approved paths in `lib/code-z-master.json` and the `Logo` component are unchanged. Installed app tiles now place that mark inside a warm-white photo print with a rose backing print on the existing dark background. The tiny browser favicon keeps the plain, theme-aware master for clarity.

`scripts/generate-brand.cjs` deterministically creates the SVG sources and PNGs. Initial generation used Sharp 0.34.5; the reproducibility check also passed after the security update to Sharp 0.35.4:

```powershell
node scripts/generate-brand.cjs --sharp-module node_modules/sharp
node scripts/generate-brand.cjs --sharp-module node_modules/sharp --check
node scripts/brand-raster-evidence.cjs
```

No image-generation service, downloaded asset, new master artwork or sibling repository is involved. New URLs are `/icon-192-v2.png`, `/icon-512-v2.png`, `/icon-512-maskable-v2.png`, `/apple-touch-icon-v2.png` and `/favicon-v2.svg`. Original PNG filenames remain updated aliases for older consumers. The notification image uses the new 192 px tile; `/badge-v2.png` is a separate transparent white master silhouette, avoiding an opaque square notification badge.

The standard and Apple tiles are fully opaque. The maskable variant scales the entire print treatment into the central safe circle, rather than allowing the launcher to cut important artwork. Decoded 512 px maskable pixels have a maximum foreground radius of approximately 0.376 of the width, within the 0.4-width safe radius. No foreground pixels above the documented antialias tolerance fall outside that circle. The master paths remain intact in both variants.

Actual raster evidence is in [the crop sheet](evidence/pwa-icon-v2.png) and [pixel report](evidence/pwa-icon-v2.json). The sheet includes standard, rounded-square, circular and 80% safe-circle crops, plus actual 16/32/48/96 px reductions. These were visually inspected locally. The 16 px app tile is understandably small; browser tabs use the simpler master favicon. Brand tests independently decode every PNG and check dimensions, opacity, master path preservation, legacy aliases, safe-circle pixels and consumer URLs.

Manifest and root icon metadata, offline fallback artwork and notification references use the revisioned URLs. Service-worker static/page cache version is now `v4-photobooth-icons`; icon requests use only the current static cache so an older rollback cache cannot shadow them. The curated-image pack and private-route cache policies remain intact. Install no longer calls `skipWaiting()`: a replacement worker waits until existing controlled tabs close, preserving active capture/live-room sessions. Initial install uses the browser's normal activation behaviour. Existing static rollback resources are retained.

Local focused checks: 12 branding/service-worker tests passed and generator reproducibility check passed. Pixel/crop evidence is not a device installation result. iOS/Android launcher refresh, installed PWA appearance and browser-specific metadata refresh timing remain separate device checks. Icon refresh can require closing/reopening an installed app and is controlled by the platform; no forced mid-session reload or activation is introduced.

Post-security-update regression on 23/09/2026: all branding and service-worker tests passed within the 474-test run. The actual Next.js 16.3.6 development manifest references the three revisioned install PNGs with their expected any/maskable purposes. Those PNGs, Apple icon, favicon, notification badge and service worker all returned HTTP 200 with their expected MIME types. Installed-device acceptance remains deferred.

The later 600-test P6 checkpoint also passed the branding suite. The final local production build served all six revisioned icon URLs at HTTP 200 and its manifest retained the expected 192/512/maskable entries. Raster reproducibility passed again with Sharp 0.35.4. This confirms the compiled assets, not launcher refresh on a real phone.

Primary references: [Web App Manifest icon masks and safe zone](https://www.w3.org/TR/appmanifest/#icon-masks), [service-worker skipWaiting lifecycle](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerGlobalScope/skipWaiting). Installed Next.js manifest/app-icon documentation was checked before metadata edits.

At the 626-test challenge UI checkpoint, branding checks passed again. A fresh Sharp 0.35.4 reproducibility check and final production-mode manifest/icon requests passed: standard 192/512, maskable 512, Apple, favicon and badge assets all returned 200. Installed Android/iOS refresh remains explicitly deferred.

The later 671-test integration run retained passing brand/service-worker checks. Its fresh production build again served all six icon assets at 200 with expected MIME types and all three manifest entries. This remains local compiled-asset evidence; installed-phone refresh is still deferred.
