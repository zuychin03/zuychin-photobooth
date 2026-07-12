export type PromptPack = "couple" | "group" | "solo";

const PACKS: Record<PromptPack, string[]> = {
  couple: [
    "Blow each other a kiss",
    "Mirror each other's pose",
    "Both make half a heart",
    "Pretend to hold hands across the screen",
    "Show your best 'I miss you' face",
    "Both point at each other",
    "Rest your head on their shoulder (pretend!)",
    "Recreate your first photo together",
    "Whisper a secret to the camera",
    "Both wink at the same time",
    "Make the face they always tease you about",
    "Cheek squish against the camera",
  ],
  group: [
    "Everyone point left",
    "Freeze mid-laugh",
    "Serious album-cover faces",
    "Everyone look at the tallest person",
    "Jazz hands!",
    "Pretend someone said something shocking",
    "Squeeze in like it's one tiny booth",
    "Everyone do a different decade",
  ],
  solo: [
    "Best surprised face",
    "Look over your shoulder",
    "Chin on fist, art-school pose",
    "Laugh at nothing",
    "Serve a magazine cover",
    "Close-up wink",
  ],
};

// Deterministic PRNG so both peers roll identical prompts from a shared seed.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function rollPrompts(pack: PromptPack, count: number, seed: number): string[] {
  const pool = [...PACKS[pack]];
  const rand = mulberry32(seed);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    if (pool.length === 0) pool.push(...PACKS[pack]);
    out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  }
  return out;
}

export function newPromptSeed(): number {
  return Math.floor(Math.random() * 0xffffffff);
}
