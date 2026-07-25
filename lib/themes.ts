// Theme presets: frame + pattern + a baked-in decor layer drawn by the
// composer (not interactive). Decor positions are relative to strip size
// (0..1) so themes work across layouts; pieces hug the corners, side edges,
// and footer flanks to stay clear of faces and the centered caption.
import { StickerStyle } from "./decor";

export interface ThemeDecor {
  /** Fluent asset slug from STICKER_PACKS; emoji is the fallback glyph */
  slug: string;
  emoji: string;
  x: number;
  y: number;
  scale: number;
  /** radians */
  rotation: number;
}

export interface ThemeDef {
  id: string;
  name: string;
  frameId: string;
  patternId: string;
  stickerStyle: StickerStyle;
  caption?: string;
  decor: ThemeDecor[];
}

const D = 0.26; // ~15deg, max tilt for organic placement

export const THEMES: ThemeDef[] = [
  {
    id: "birthday",
    name: "Birthday",
    frameId: "butter",
    patternId: "confetti",
    stickerStyle: "3d",
    caption: "Happy birthday!",
    decor: [
      { slug: "party_popper", emoji: "🎉", x: 0.08, y: 0.05, scale: 0.8, rotation: -D },
      { slug: "balloon", emoji: "🎈", x: 0.92, y: 0.045, scale: 0.8, rotation: 0.18 },
      { slug: "confetti_ball", emoji: "🎊", x: 0.06, y: 0.38, scale: 0.65, rotation: -0.15 },
      { slug: "partying_face", emoji: "🥳", x: 0.94, y: 0.55, scale: 0.65, rotation: 0.12 },
      { slug: "birthday_cake", emoji: "🎂", x: 0.13, y: 0.93, scale: 0.78, rotation: -0.08 },
      { slug: "sparkles", emoji: "✨", x: 0.87, y: 0.925, scale: 0.7, rotation: 0.1 },
    ],
  },
  {
    id: "love",
    name: "Love",
    frameId: "rose",
    patternId: "hearts",
    stickerStyle: "flat",
    caption: "you & me",
    decor: [
      { slug: "red_heart", emoji: "❤️", x: 0.08, y: 0.05, scale: 0.78, rotation: -0.2 },
      { slug: "two_hearts", emoji: "💕", x: 0.92, y: 0.045, scale: 0.8, rotation: 0.16 },
      { slug: "heart_with_arrow", emoji: "💘", x: 0.06, y: 0.38, scale: 0.65, rotation: -0.12 },
      { slug: "rose", emoji: "🌹", x: 0.94, y: 0.55, scale: 0.65, rotation: 0.14 },
      { slug: "love_letter", emoji: "💌", x: 0.13, y: 0.93, scale: 0.75, rotation: -0.1 },
      { slug: "heart_hands", emoji: "🫶", x: 0.87, y: 0.925, scale: 0.72, rotation: 0.08 },
    ],
  },
  {
    id: "party",
    name: "Party",
    frameId: "lavender",
    patternId: "stars",
    stickerStyle: "3d",
    caption: "good times",
    decor: [
      { slug: "mirror_ball", emoji: "🪩", x: 0.08, y: 0.05, scale: 0.8, rotation: 0 },
      { slug: "party_popper", emoji: "🎉", x: 0.92, y: 0.045, scale: 0.8, rotation: D },
      { slug: "sparkles", emoji: "✨", x: 0.06, y: 0.38, scale: 0.62, rotation: -0.1 },
      { slug: "balloon", emoji: "🎈", x: 0.94, y: 0.55, scale: 0.65, rotation: 0.15 },
      { slug: "bottle_with_popping_cork", emoji: "🍾", x: 0.13, y: 0.93, scale: 0.75, rotation: -0.35 },
      { slug: "confetti_ball", emoji: "🎊", x: 0.87, y: 0.925, scale: 0.72, rotation: 0.12 },
    ],
  },
  {
    id: "cinema",
    name: "Cinema",
    frameId: "noir",
    patternId: "none",
    stickerStyle: "noto",
    caption: "at the movies",
    decor: [
      { slug: "film_frames", emoji: "🎞️", x: 0.08, y: 0.05, scale: 0.78, rotation: -0.14 },
      { slug: "camera_with_flash", emoji: "📸", x: 0.92, y: 0.045, scale: 0.78, rotation: 0.14 },
      { slug: "clapper_board", emoji: "🎬", x: 0.06, y: 0.38, scale: 0.62, rotation: -0.1 },
      { slug: "sunglasses", emoji: "🕶️", x: 0.94, y: 0.55, scale: 0.62, rotation: 0.1 },
      { slug: "framed_picture", emoji: "🖼️", x: 0.13, y: 0.93, scale: 0.72, rotation: -0.08 },
      { slug: "camera", emoji: "📷", x: 0.87, y: 0.925, scale: 0.7, rotation: 0.08 },
    ],
  },
  {
    id: "cute",
    name: "Cute",
    frameId: "sky",
    patternId: "dots",
    stickerStyle: "flat",
    caption: "cuties",
    decor: [
      { slug: "teddy_bear", emoji: "🧸", x: 0.08, y: 0.05, scale: 0.8, rotation: -0.12 },
      { slug: "ribbon", emoji: "🎀", x: 0.92, y: 0.045, scale: 0.78, rotation: 0.16 },
      { slug: "rabbit_face", emoji: "🐰", x: 0.06, y: 0.38, scale: 0.65, rotation: -0.1 },
      { slug: "cherry_blossom", emoji: "🌸", x: 0.94, y: 0.55, scale: 0.65, rotation: 0.12 },
      { slug: "strawberry", emoji: "🍓", x: 0.13, y: 0.93, scale: 0.72, rotation: -0.08 },
      { slug: "star", emoji: "⭐", x: 0.87, y: 0.925, scale: 0.7, rotation: 0.1 },
    ],
  },
  {
    id: "garden",
    name: "Garden",
    frameId: "sage",
    patternId: "grid",
    stickerStyle: "flat",
    caption: "fresh air",
    decor: [
      { slug: "butterfly", emoji: "🦋", x: 0.08, y: 0.05, scale: 0.78, rotation: -0.16 },
      { slug: "sunflower", emoji: "🌻", x: 0.92, y: 0.045, scale: 0.78, rotation: 0.12 },
      { slug: "leaf_fluttering_in_wind", emoji: "🍃", x: 0.06, y: 0.38, scale: 0.62, rotation: -0.2 },
      { slug: "rainbow", emoji: "🌈", x: 0.94, y: 0.55, scale: 0.65, rotation: 0.08 },
      { slug: "tulip", emoji: "🌷", x: 0.13, y: 0.93, scale: 0.72, rotation: -0.08 },
      { slug: "spiral_shell", emoji: "🐚", x: 0.87, y: 0.925, scale: 0.7, rotation: 0.1 },
    ],
  },
];

export function getTheme(id: string | null | undefined): ThemeDef | null {
  return THEMES.find((t) => t.id === id) ?? null;
}
