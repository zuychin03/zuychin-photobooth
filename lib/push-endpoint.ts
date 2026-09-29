export function validPushEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return value.length <= 4096 && url.protocol === "https:" && !url.username && !url.password && !url.hash && !url.port
      && (url.hostname === "fcm.googleapis.com" || url.hostname === "android.googleapis.com" || url.hostname === "web.push.apple.com" || url.hostname === "updates.push.services.mozilla.com" || /^[a-z0-9-]+\.notify\.windows\.com$/.test(url.hostname));
  } catch { return false; }
}
