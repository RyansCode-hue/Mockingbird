/**
 * Shapes of what a terminal sends without anyone typing. The window uses them
 * to keep such sequences out of a pane (src/renderer/inputGuard.ts), and the
 * main process to refuse them as a teammate's typing (team rooms).
 */

// Sequences a terminal legitimately sends on its own: answers to queries the
// program asked for (cursor position, device attributes, colours) and focus
// reporting.
const TERM_REPLY = new RegExp(
  "^(?:" +
    "\\x1b\\[[?>]?[0-9;]*[Rcn]" + // cursor position / primary and secondary device attributes / device status
    "|\\x1b\\[\\??[0-9;]*\\$y" + // mode report (DECRQM)
    "|\\x1b\\[[IO]" + // focus in / focus out reporting
    "|\\x1b\\][0-9]+;[^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)" + // OSC colour answers
    "|\\x1bP[^\\x1b]*\\x1b\\\\" + // DCS answers (XTGETTCAP, DECRQSS)
    ")$"
);

/** One complete SGR mouse report. */
const SGR_MOUSE_REPORT = /^\x1b\[<\d+;\d+;\d+[Mm]$/;

/** A terminal's automatic answer to a program's query (or a focus report), whole. */
export const isTermReply = (data: string): boolean => TERM_REPLY.test(data);

// PageUp and PageDown as a terminal sends them unmodified (Shift+PageUp scrolls xterm itself).
const VIEW_CONTROL = /^(?:\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[[56]~)+$/;

/**
 * Input that only moves or points at a program's view, and nothing else: SGR
 * mouse reports (a click, a drag, the wheel) and PageUp/PageDown. Typing never
 * takes this shape: no key sends `ESC [ <`, and a paste the program asked to
 * have bracketed starts with `ESC [ 200 ~`. Arrow keys are not in it although
 * xterm turns the wheel into them on the alternate screen: they are exactly
 * what the arrow keys send, so only the pane the wheel turned in can tell.
 */
export const isViewControl = (data: string): boolean => VIEW_CONTROL.test(data);

/** Exactly one SGR mouse report. */
export const isMouseReport = (data: string): boolean => SGR_MOUSE_REPORT.test(data);
