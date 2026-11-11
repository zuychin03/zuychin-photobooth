// Frame palette: film-white classic plus pastel Life4Cuts-style colors.
// inkColor is the caption color that reads on that frame.
export interface FrameOption {
  id: string;
  name: string;
  color: string;
  ink: string;
  /** painted top-left to bottom-right over `color` */
  gradient?: readonly [string, string];
  /** V3 frame that older clients can't parse */
  v3?: boolean;
}

export const FRAMES: FrameOption[] = [
  { id: "film", name: "Film white", color: "#faf7f2", ink: "#292524" },
  { id: "noir", name: "Noir", color: "#181512", ink: "#faf7f2" },
  { id: "rose", name: "Rose", color: "#fecdd3", ink: "#881337" },
  { id: "butter", name: "Butter", color: "#fef3c7", ink: "#78350f" },
  { id: "sage", name: "Sage", color: "#d1fae5", ink: "#064e3b" },
  { id: "sky", name: "Sky", color: "#e0f2fe", ink: "#0c4a6e" },
  { id: "lavender", name: "Lavender", color: "#ede9fe", ink: "#4c1d95" },
  { id: "cherry", name: "Cherry", color: "#be123c", ink: "#fff1f2", v3: true },
  { id: "midnight", name: "Midnight", color: "#1e293b", ink: "#e2e8f0", v3: true },
  { id: "kraft", name: "Kraft", color: "#c8a27a", ink: "#3b2a1a", v3: true },
  { id: "peach", name: "Peach sunset", color: "#fecaca", ink: "#7c2d12", gradient: ["#fecaca", "#fde68a"], v3: true },
  { id: "lilac", name: "Lilac haze", color: "#ddd6fe", ink: "#4c1d95", gradient: ["#ddd6fe", "#fbcfe8"], v3: true },
  { id: "seaglass", name: "Sea glass", color: "#a7f3d0", ink: "#134e4a", gradient: ["#a7f3d0", "#bae6fd"], v3: true },
];

// Sticker rendering styles: Fluent Emoji (MIT) flat SVGs and 3D PNGs are
// bundled under public/stickers/<style>/<slug>.*; "noto" draws the glyph
// with the monochrome Noto Emoji font tinted to the frame's ink color.
export type StickerStyle = "flat" | "3d" | "noto";

export const STICKER_STYLES: { id: StickerStyle; name: string }[] = [
  { id: "flat", name: "Flat" },
  { id: "3d", name: "3D" },
  { id: "noto", name: "Ink" },
];

export interface StickerDef {
  emoji: string;
  slug: string;
}

export interface StickerPack {
  id: string;
  name: string;
  stickers: StickerDef[];
}

export const STICKER_PACKS: StickerPack[] = [
  {
    id: "love",
    name: "Love",
    stickers: [
      { emoji: "❤️", slug: "red_heart" },
      { emoji: "💕", slug: "two_hearts" },
      { emoji: "💌", slug: "love_letter" },
      { emoji: "💘", slug: "heart_with_arrow" },
      { emoji: "🌹", slug: "rose" },
      { emoji: "😘", slug: "face_blowing_a_kiss" },
      { emoji: "🫶", slug: "heart_hands" },
      { emoji: "💍", slug: "ring" },
    ],
  },
  {
    id: "cute",
    name: "Cute",
    stickers: [
      { emoji: "🐰", slug: "rabbit_face" },
      { emoji: "🐻", slug: "bear" },
      { emoji: "🎀", slug: "ribbon" },
      { emoji: "🌸", slug: "cherry_blossom" },
      { emoji: "⭐", slug: "star" },
      { emoji: "🍓", slug: "strawberry" },
      { emoji: "🧸", slug: "teddy_bear" },
      { emoji: "🌷", slug: "tulip" },
    ],
  },
  {
    id: "party",
    name: "Party",
    stickers: [
      { emoji: "🎉", slug: "party_popper" },
      { emoji: "🥳", slug: "partying_face" },
      { emoji: "🎈", slug: "balloon" },
      { emoji: "✨", slug: "sparkles" },
      { emoji: "🍾", slug: "bottle_with_popping_cork" },
      { emoji: "🎂", slug: "birthday_cake" },
      { emoji: "🪩", slug: "mirror_ball" },
      { emoji: "🎊", slug: "confetti_ball" },
    ],
  },
  {
    id: "film",
    name: "Film",
    stickers: [
      { emoji: "📸", slug: "camera_with_flash" },
      { emoji: "🎞️", slug: "film_frames" },
      { emoji: "📷", slug: "camera" },
      { emoji: "🎬", slug: "clapper_board" },
      { emoji: "🕶️", slug: "sunglasses" },
      { emoji: "💡", slug: "light_bulb" },
      { emoji: "🖼️", slug: "framed_picture" },
      { emoji: "⏱️", slug: "stopwatch" },
    ],
  },
  {
    id: "cool",
    name: "Cool",
    stickers: [
      { emoji: "😎", slug: "smiling_face_with_sunglasses" },
      { emoji: "🤙", slug: "call_me_hand" },
      { emoji: "🔥", slug: "fire" },
      { emoji: "⚡", slug: "high_voltage" },
      { emoji: "🛹", slug: "skateboard" },
      { emoji: "💀", slug: "skull" },
      { emoji: "🤘", slug: "sign_of_the_horns" },
      { emoji: "👑", slug: "crown" },
    ],
  },
  {
    id: "mood",
    name: "Mood",
    stickers: [
      { emoji: "😂", slug: "face_with_tears_of_joy" },
      { emoji: "🥹", slug: "face_holding_back_tears" },
      { emoji: "😭", slug: "loudly_crying_face" },
      { emoji: "😴", slug: "sleeping_face" },
      { emoji: "🤯", slug: "exploding_head" },
      { emoji: "🥰", slug: "smiling_face_with_hearts" },
      { emoji: "😤", slug: "face_with_steam_from_nose" },
      { emoji: "🙃", slug: "upside_down_face" },
    ],
  },
  {
    id: "nature",
    name: "Nature",
    stickers: [
      { emoji: "🌈", slug: "rainbow" },
      { emoji: "☀️", slug: "sun" },
      { emoji: "🌙", slug: "crescent_moon" },
      { emoji: "🌊", slug: "water_wave" },
      { emoji: "🍃", slug: "leaf_fluttering_in_wind" },
      { emoji: "🦋", slug: "butterfly" },
      { emoji: "🌻", slug: "sunflower" },
      { emoji: "🐚", slug: "spiral_shell" },
    ],
  },
  {
    id: "food",
    name: "Food",
    stickers: [
      { emoji: "🍕", slug: "pizza" },
      { emoji: "🍦", slug: "soft_ice_cream" },
      { emoji: "🧋", slug: "bubble_tea" },
      { emoji: "🍩", slug: "doughnut" },
      { emoji: "🍜", slug: "steaming_bowl" },
      { emoji: "🍰", slug: "shortcake" },
      { emoji: "🍒", slug: "cherries" },
      { emoji: "🥐", slug: "croissant" },
    ],
  },
];

export const ALL_STICKER_SLUGS = STICKER_PACKS.flatMap((p) =>
  p.stickers.map((s) => s.slug),
);

export function stickerAssetUrl(style: "flat" | "3d", slug: string): string {
  return `/stickers/${style}/${slug}.${style === "flat" ? "svg" : "png"}`;
}

/**
 * U+FE0F requests color-emoji presentation, which makes renderers skip the
 * monochrome Noto face entirely; strip it so the glyph takes the tint.
 */
export function monochromeGlyph(emoji: string): string {
  return emoji.replace(/[\uFE0E\uFE0F]/g, "");
}
