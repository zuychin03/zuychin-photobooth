/** The UI no longer renders these faces, so canvas would fall back unless something loads them. */
export async function ensureStripFonts(): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return;
  const faces = [["--font-fraunces", "400"], ["--font-fraunces", "600"], ["--font-geist-sans", "400"], ["--font-geist-sans", "500"], ["--font-geist-mono", "400"], ["--font-geist-mono", "italic 700"]];
  await Promise.all(faces.map(([variable, weight]) => {
    const family = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
    return family ? document.fonts.load(`${weight} 32px ${family}`).catch(() => []) : [];
  }));
}
