// Stand-in for the electron module under Vitest. Nothing tested here reaches it
// at runtime; a test that does fails loudly instead of silently no-oping.
const unavailable = new Proxy(
  {},
  {
    get(_t, prop) {
      throw new Error(`electron.${String(prop)} is not available in tests`);
    },
  }
);
export const app = unavailable;
export const BrowserWindow = unavailable;
export type WebContents = { send(channel: string, ...args: unknown[]): void };
