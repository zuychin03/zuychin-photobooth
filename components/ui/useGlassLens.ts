"use client";

import { type RefObject, useEffect } from "react";

const SVG_NS = "http://www.w3.org/2000/svg";
// Edge band depth and peak displacement, in CSS px.
const BAND = 16;
const SHIFT = 9;

let host: SVGSVGElement | null = null;
let serial = 0;

// Only Chromium renders SVG filters inside backdrop-filter; elsewhere the plain glass stays.
function lensSupported() {
  const brands = (navigator as Navigator & { userAgentData?: { brands: { brand: string }[] } }).userAgentData?.brands;
  return Boolean(brands?.some(entry => entry.brand === "Chromium")) && !matchMedia("(prefers-reduced-transparency: reduce)").matches;
}

/** R/G encode an inward push that peaks at the rim and fades out over BAND, like the curved edge of a lens. */
function displacementMap(width: number, height: number, radius: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  const image = context.createImageData(width, height);
  const r = Math.min(radius, width / 2, height / 2), band = Math.min(BAND, r);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = x + 0.5, py = y + 0.5;
      const dx = px - Math.min(Math.max(px, r), width - r), dy = py - Math.min(Math.max(py, r), height - r);
      const length = Math.hypot(dx, dy), depth = r - length;
      let nx = 0, ny = 0;
      if (length > 0 && depth < band) {
        const strength = (1 - Math.max(depth, 0) / band) ** 2;
        nx = (-dx / length) * strength;
        ny = (-dy / length) * strength;
      }
      const index = (y * width + x) * 4;
      image.data[index] = 128 + nx * 127;
      image.data[index + 1] = 128 + ny * 127;
      image.data[index + 2] = 128;
      image.data[index + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  return canvas.toDataURL();
}

/** Bends the backdrop at the element's rim. `active` lets callers skip hidden bars. */
export function useGlassLens(target: RefObject<HTMLElement | null>, active = true) {
  useEffect(() => {
    const element = target.current;
    if (!element || !active || !lensSupported()) return;
    if (!host) {
      host = document.createElementNS(SVG_NS, "svg");
      host.setAttribute("aria-hidden", "true");
      host.setAttribute("width", "0");
      host.setAttribute("height", "0");
      host.style.position = "absolute";
      document.body.append(host);
    }
    const id = `glass-lens-${++serial}`;
    const filter = document.createElementNS(SVG_NS, "filter");
    filter.id = id;
    filter.setAttribute("filterUnits", "userSpaceOnUse");
    filter.setAttribute("color-interpolation-filters", "sRGB");
    const map = document.createElementNS(SVG_NS, "feImage");
    map.setAttribute("preserveAspectRatio", "none");
    map.setAttribute("result", "map");
    const displace = document.createElementNS(SVG_NS, "feDisplacementMap");
    displace.setAttribute("in", "SourceGraphic");
    displace.setAttribute("in2", "map");
    displace.setAttribute("scale", String(SHIFT * 2));
    displace.setAttribute("xChannelSelector", "R");
    displace.setAttribute("yChannelSelector", "G");
    filter.append(map, displace);
    host.append(filter);

    let frame = 0, size = "";
    const render = () => {
      frame = 0;
      const width = Math.round(element.offsetWidth), height = Math.round(element.offsetHeight);
      if (!width || !height || `${width}x${height}` === size) return;
      size = `${width}x${height}`;
      const url = displacementMap(width, height, parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0);
      if (!url) return;
      for (const node of [filter, map]) {
        node.setAttribute("x", "0");
        node.setAttribute("y", "0");
        node.setAttribute("width", String(width));
        node.setAttribute("height", String(height));
      }
      map.setAttribute("href", url);
      element.style.setProperty("backdrop-filter", `url(#${id}) var(--glass-filter)`);
    };
    const observer = new ResizeObserver(() => { if (!frame) frame = requestAnimationFrame(render); });
    observer.observe(element);
    render();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      filter.remove();
      element.style.removeProperty("backdrop-filter");
    };
  }, [target, active]);
}
