import type { AgentKind } from "../shared/types";

/**
 * Which of a CLI's mouse requests reach the terminal.
 *  - shell: everything; vim, htop and the like own the mouse.
 *  - claude: everything but any-motion tracking (1003). Claude Code's
 *    fullscreen TUI draws and copies its own transcript selection, so it needs
 *    presses, drags and releases; hover motion would only add traffic.
 *  - agent: nothing (other agent CLIs). With no mouse protocol active, xterm
 *    selects natively and the wheel handler answers on the CLI's behalf.
 */
export type MousePolicy = "shell" | "claude" | "agent";

export function mousePolicyFor(s: { shell?: boolean; agent?: AgentKind }): MousePolicy {
  if (s.shell) return "shell";
  return (s.agent ?? "claude") === "claude" ? "claude" : "agent";
}

/** What a pane tracks about its CLI's mouse mode. */
export interface MouseModeState {
  mousePolicy: MousePolicy;
  carry: string; // trailing partial escape sequence held until the next chunk
  wantsMouse: boolean; // the CLI has mouse reporting on, whether or not the terminal was given it
  tracking: number; // TRACKING_RANK of the tracking mode the terminal was last given; 0 = none
  buttonHeld: boolean; // a press the CLI owns is being reported, until its release
}

const MOUSE_MODE_PARAMS: ReadonlySet<string> = new Set(["9", "1000", "1001", "1002", "1003", "1005", "1006", "1015", "1016"]);
const WITHHELD: Record<MousePolicy, ReadonlySet<string>> = {
  shell: new Set(),
  claude: new Set(["1003"]),
  agent: MOUSE_MODE_PARAMS,
};
// xterm.js keeps one tracking protocol, the last one set, and attaches its drag
// listener only on a press. Setting a lower mode mid-gesture (1000 while 1002
// is on) detaches that listener, and setting 1002 again doesn't bring it back
// until the next press. Claude re-sends its whole set (1000, 1002, 1003) while
// a button is held, ending drag reports for the rest of the gesture. So while
// a button is held, a mode lower than the one on is dropped; otherwise the
// last mode set wins, as in xterm, and a reset clears the level.
const TRACKING_RANK: Readonly<Record<string, number>> = { "9": 1, "1000": 2, "1002": 3, "1003": 4 };
// DEC private mode set/reset, or a full reset (RIS), which turns tracking off
const DEC_MODE_RE = /\x1b\[\?((?:\d+;)*\d+)([hl])|\x1bc/g;
// a chunk can end mid-sequence; hold the unfinished tail for the next chunk
const PARTIAL_CSI_RE = /\x1b(?:\[[?0-9;]*)?$/;

/**
 * Removes the policy's withheld modes, and mid-gesture tracking downgrades, from
 * DEC private mode sets. A combined set (`CSI ? 1049 ; 1003 h`) keeps
 * its other parameters. Resets pass through untouched: they only ever turn
 * reporting off.
 */
export function stripMouseEnables(e: MouseModeState, data: string): string {
  if (e.mousePolicy === "shell") return data;
  let chunk = e.carry + data;
  e.carry = "";
  const tail = chunk.match(PARTIAL_CSI_RE);
  if (tail) {
    e.carry = tail[0];
    chunk = chunk.slice(0, -tail[0].length);
  }
  if (!chunk.includes("\x1b[?") && !chunk.includes("\x1bc")) return chunk;
  const withheld = WITHHELD[e.mousePolicy];
  return chunk.replace(DEC_MODE_RE, (m, list: string | undefined, op: string) => {
    if (list === undefined) {
      e.tracking = 0;
      e.wantsMouse = false;
      return m;
    }
    const params = list.split(";").map((p) => String(Number(p))); // xterm reads 01003 as 1003
    if (!params.some((p) => MOUSE_MODE_PARAMS.has(p))) return m;
    e.wantsMouse = op === "h";
    if (op === "l") {
      if (params.some((p) => TRACKING_RANK[p])) e.tracking = 0;
      return m;
    }
    const kept = params.filter((p) => {
      if (withheld.has(p)) return false;
      const rank = TRACKING_RANK[p];
      if (!rank) return true;
      if (e.buttonHeld && rank < e.tracking) return false;
      e.tracking = rank;
      return true;
    });
    if (kept.length === params.length) return m;
    return kept.length ? `\x1b[?${kept.join(";")}h` : "";
  });
}

/**
 * Whether a left-button press starts xterm's own selection instead of being
 * reported to the program: the test xterm's mousedown applies (mouse tracking
 * off, or the force-selection modifier held), made before xterm makes it.
 */
export function selectsNatively(
  mouseTrackingMode: string,
  ev: { altKey: boolean; shiftKey: boolean },
  mac: boolean,
  macOptionClickForcesSelection: boolean
): boolean {
  if (mouseTrackingMode === "none") return true;
  return mac ? ev.altKey && macOptionClickForcesSelection : ev.shiftKey;
}
