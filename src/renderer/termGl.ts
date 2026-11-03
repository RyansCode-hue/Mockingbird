import { WebglAddon } from "@xterm/addon-webgl";
import type { Terminal } from "@xterm/xterm";

/**
 * WebGL for the terminals on the landscape (docs/landscape.md, performance): drawn by WebGL, a terminal costs
 * little to draw and nothing to re-raster as the landscape zooms. Only attached terminals hold a context, and at
 * most GL_MAX at once: Chromium keeps about 16 WebGL contexts a page and drops the oldest past that, so a terminal
 * past the cap (until one is given up), or whose context can't be made or is lost, draws with xterm's DOM renderer,
 * and says why. Which renderer draws a terminal never changes its pty's size (cachedTerm.ts, fontCell).
 */
export const GL_MAX = 12;
/** The UI preview lowers the cap to check what happens past it. */
const glMax = () => (globalThis as { __mbGlMax?: number }).__mbGlMax ?? GL_MAX;

export type Renderer = "webgl" | "dom";

const live = new Map<Terminal, WebglAddon>();
/** Attached terminals past the cap, in the order they came: the first gets the next context given up. */
const waiting = new Map<Terminal, string>();
/** Terminals whose WebGL context couldn't be made: they keep the DOM renderer. */
const failed = new WeakSet<Terminal>();
const said = new Set<string>();

/** Why a session's terminal draws with the DOM renderer, said once per session and reason. */
function domBecause(id: string, why: string): void {
  const key = `${id}\n${why}`;
  if (said.has(key)) return;
  said.add(key);
  console.warn(`[mockingbird] terminal ${id} draws with the DOM renderer: ${why}`);
}

/** Draw an open terminal with WebGL, unless the cap is reached or no context can be made: which renderer it got. */
export function webglOn(term: Terminal, id: string): Renderer {
  if (live.has(term)) return "webgl";
  if (!term.element || failed.has(term)) return "dom";
  if (live.size >= glMax()) {
    waiting.set(term, id);
    domBecause(id, `${glMax()} terminals already draw with WebGL, the most at once (Chromium drops WebGL contexts past about 16); it takes the next one given up`);
    return "dom";
  }
  waiting.delete(term);
  const addon = new WebglAddon();
  const screen = term.element.querySelector(".xterm-screen");
  const had = new Set(screen?.querySelectorAll("canvas"));
  try {
    term.loadAddon(addon);
  } catch (err) {
    // The addon throws from its renderer's constructor when the canvas gives no WebGL2 context, after it has put
    // its link layer's canvas in the screen; nothing disposes that, so every attempt would leave one behind.
    // Its listeners stay, too: a terminal that couldn't have a context isn't tried again.
    for (const c of screen?.querySelectorAll("canvas") ?? []) if (!had.has(c)) c.remove();
    failed.add(term);
    domBecause(id, `its WebGL context couldn't be made (${err instanceof Error ? err.message : String(err)})`);
    disposeAddon(addon, id);
    return "dom";
  }
  live.set(term, addon);
  addon.onContextLoss(() => {
    console.warn(`[mockingbird] terminal ${id} lost its WebGL context; it draws with the DOM renderer until it's attached again`);
    webglOff(term, id);
  });
  return "webgl";
}

/**
 * Back to the DOM renderer, giving the WebGL context up: a terminal leaving the screen, disposed, or whose context
 * was lost. The context goes to the attached terminal that has waited longest for one.
 */
export function webglOff(term: Terminal, id: string): void {
  waiting.delete(term);
  const addon = live.get(term);
  if (!addon) return;
  live.delete(term);
  disposeAddon(addon, id);
  for (const [next, nextId] of waiting) {
    waiting.delete(next);
    if (next.element?.isConnected && webglOn(next, nextId) === "webgl") break;
  }
}

function disposeAddon(addon: WebglAddon, id: string): void {
  try {
    addon.dispose();
  } catch (err) {
    console.error(`[mockingbird] terminal ${id}: giving its WebGL renderer up failed; it may keep a context until the window reloads`, err);
  }
}

/** How many terminals draw with WebGL now. */
export const webglCount = (): number => live.size;
(globalThis as { __mbWebglCount?: () => number }).__mbWebglCount = webglCount; // diagnostics, and the UI preview's checks
