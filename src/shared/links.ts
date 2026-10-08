/**
 * Whether a link may leave the app for the default browser: https only. Every
 * way out goes by this — the window's "open in browser", a page's window.open
 * or navigation, a link in terminal output.
 */
export function externalUrlAllowed(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}
