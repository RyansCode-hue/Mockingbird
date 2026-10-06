/** Paths as the app shows them: "/"-separated, macOS homes under /Users. */

/** The last segment: "src/app.ts" → "app.ts". */
export const baseName = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

/** Everything before the last segment: "src/app.ts" → "src", "app.ts" → "". */
export function dirName(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

/** A path with the user's home folder shown as "~": "/Users/ann/Code" → "~/Code". */
export const tildePath = (p: string): string => p.replace(/^\/Users\/[^/]+/, "~");
