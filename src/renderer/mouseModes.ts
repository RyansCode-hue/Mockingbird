/** What a pane tracks about its CLI's mouse mode. */
export interface MouseModeState {
  stripMouse: boolean; // agent panes: the CLI never gets the mouse
  carry: string; // trailing partial escape sequence held until the next chunk
  wantsMouse: boolean; // the CLI asked for mouse tracking (we stripped it)
}

// The moment a program enables mouse tracking, xterm clears any selection and
// disables its selection service entirely (protocol change → selectionService.
// disable() — which is clearSelection() + enabled=false, in xterm's source).
// Claude Code's newer TUI latches mouse tracking (and the alt screen) on for
// whole generations, so selection in a claude pane froze or died mid-drag —
// while shell panes, which never enable it, selected fine.
//
// Claude panes therefore never hand the CLI the mouse: tracking-enable
// sequences are stripped from the display stream. Selection then behaves like
// a normal terminal, and the wheel still scrolls the CLI's alt-screen UI —
// with no mouse protocol active, xterm converts wheel to arrow keys there
// (the same thing iTerm does by default). Shell panes are untouched, so vim
// and htop keep full mouse support.
const MOUSE_ENABLE_RE = /\x1b\[\?((?:\d+;)*\d+)h/g;
const MOUSE_MODE_PARAMS = new Set(["1000", "1001", "1002", "1003", "1005", "1006", "1015", "1016"]);
// a chunk can end mid-sequence; hold the unfinished tail for the next chunk
const PARTIAL_CSI_RE = /\x1b(?:\[[?0-9;]*)?$/;

const MOUSE_DISABLE_RE = /\x1b\[\?((?:\d+;)*\d+)l/g;

export function stripMouseEnables(e: MouseModeState, data: string): string {
  if (!e.stripMouse) return data;
  let chunk = e.carry + data;
  e.carry = "";
  const tail = chunk.match(PARTIAL_CSI_RE);
  if (tail) {
    e.carry = tail[0];
    chunk = chunk.slice(0, -tail[0].length);
  }
  if (!chunk.includes("\x1b[?")) return chunk;
  // remember what the CLI wanted: the wheel handler answers on its behalf
  for (const m of chunk.matchAll(MOUSE_DISABLE_RE)) {
    if (m[1].split(";").some((p) => MOUSE_MODE_PARAMS.has(p))) e.wantsMouse = false;
  }
  return chunk.replace(MOUSE_ENABLE_RE, (m, params: string) => {
    if (!params.split(";").some((p) => MOUSE_MODE_PARAMS.has(p))) return m;
    e.wantsMouse = true;
    return "";
  });
}
