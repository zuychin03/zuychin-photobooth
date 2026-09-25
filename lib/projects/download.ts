export function projectDownloadName(name: string, extension: string): string {
  const stem = name.normalize("NFKC").replace(/[^\p{L}\p{N} _-]/gu, "").trim().slice(0, 80) || "photobooth-project";
  return `${stem}.${extension}`;
}

export function downloadProjectBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob), anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
