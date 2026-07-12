// Ambiguity-free alphabet (no 0/O, 1/I/L) for read-aloud room codes.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export function newRoomCode(length = 6): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

export function normalizeRoomCode(input: string): string {
  return input.toUpperCase().replace(/[^2-9A-Z]/g, "").slice(0, 6);
}

export function isValidRoomCode(code: string): boolean {
  return code.length === 6 && [...code].every((c) => ALPHABET.includes(c));
}
