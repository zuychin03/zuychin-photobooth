import sharp from "sharp";
import { fileURLToPath } from "node:url";

const tiles = ["#ca2e59", "#e3ae35", "#3279b7", "#388d67"];
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="1000"><rect width="400" height="1000" fill="#f4f1e9"/>${tiles.map((colour, index) => `<rect x="20" y="${20 + index * 240}" width="360" height="220" fill="${colour}"/><circle cx="${index % 2 ? 285 : 115}" cy="${85 + index * 240}" r="30" fill="#f4f1e9"/>`).join("")}</svg>`;
await sharp(Buffer.from(svg)).png().toFile(fileURLToPath(new URL("strip.png", import.meta.url)));
