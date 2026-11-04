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
/**
 * How many contexts are made in one frame. Making one costs a few milliseconds, and a band change attaches every
 * workspace on screen at once: the rest draw with the DOM renderer for the frames they wait.
 */
export const GL_PER_FRAME = 2;
/** The UI preview lowers the cap to check what happens past it. */
const glMax = () => (globalThis as { __mbGlMax?: number }).__mbGlMax ?? GL_MAX;

interface Live {
  addon: WebglAddon;
  /** The canvases the addon put in the terminal's screen: its WebGL context is one of theirs. */
  canvases: HTMLCanvasElement[];
}
const live = new Map<Terminal, Live>();
/** Attached terminals waiting for a context, in the order they asked: those past the cap wait for one to be given up. */
const waiting = new Map<Terminal, string>();
/** Terminals whose WebGL context couldn't be made: they keep the DOM renderer. */
const failed = new WeakSet<Terminal>();
const said = new Set<string>();
let frame = 0;

/** Why a session's terminal draws with the DOM renderer, said once per session and reason. */
function domBecause(id: string, why: string): void {
  const key = `${id}\n${why}`;
  if (said.has(key)) return;
  said.add(key);
  console.warn(`[mockingbird] terminal ${id} draws with the DOM renderer: ${why}`);
}

/**
 * Draw an open terminal with WebGL once a context can be had for it: within GL_PER_FRAME a frame, and only while
 * fewer than the cap draw with it. Meanwhile, and for good when no context can be made, it draws with the DOM.
 */
export function webglOn(term: Terminal, id: string): void {
  if (live.has(term) || waiting.has(term) || !term.element || failed.has(term)) return;
  if (live.size + waiting.size >= glMax()) domBecause(id, `${glMax()} terminals already draw with WebGL, the most at once (Chromium drops WebGL contexts past about 16); it takes the next one given up`);
  waiting.set(term, id);
  schedule();
}

function schedule(): void {
  if (!frame && waiting.size && live.size < glMax()) frame = requestAnimationFrame(pump);
}

function pump(): void {
  frame = 0;
  let made = 0;
  for (const [term, id] of waiting) {
    if (made >= GL_PER_FRAME || live.size >= glMax()) break;
    waiting.delete(term);
    // webglOff takes a terminal that leaves the page out of the queue: one still here but not in the page was disposed
    if (!term.element?.isConnected) continue;
    made++;
    make(term, id);
  }
  schedule();
}

function make(term: Terminal, id: string): void {
  const addon = new WebglAddon();
  const screen = term.element?.querySelector(".xterm-screen");
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
    return;
  }
  live.set(term, { addon, canvases: [...(screen?.querySelectorAll("canvas") ?? [])].filter((c) => !had.has(c)) });
  addon.onContextLoss(() => {
    if (live.get(term)?.addon !== addon) return;
    console.warn(`[mockingbird] terminal ${id} lost its WebGL context; it draws with the DOM renderer until it's attached again`);
    webglOff(term, id);
  });
}

/**
 * Back to the DOM renderer, giving the WebGL context up: a terminal leaving the screen, disposed, or whose context
 * was lost. The context goes to the attached terminal that has waited longest for one.
 */
export function webglOff(term: Terminal, id: string): void {
  waiting.delete(term);
  const gl = live.get(term);
  if (!gl) return;
  live.delete(term);
  loseContexts(gl.canvases);
  disposeAddon(gl.addon, id);
  schedule();
}

let noLoseContext = false;
/**
 * Free a given-up context now. The addon's dispose leaves it to the garbage collector, and until then Chromium
 * counts it against its limit, so the cap alone wouldn't keep a live terminal's context from being dropped.
 */
function loseContexts(canvases: HTMLCanvasElement[]): void {
  for (const c of canvases) {
    // null for the link layer's 2D canvas
    const gl = c.getContext("webgl2") as WebGL2RenderingContext | null;
    if (!gl || gl.isContextLost()) continue;
    const lose = gl.getExtension("WEBGL_lose_context");
    if (lose) lose.loseContext();
    else if (!noLoseContext) {
      noLoseContext = true;
      console.warn("[mockingbird] WEBGL_lose_context isn't there: a terminal's WebGL context, given up, is freed only when it's garbage collected");
    }
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
