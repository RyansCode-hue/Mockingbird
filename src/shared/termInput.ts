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

/** One or more SGR mouse reports and nothing else (a click, a drag, the wheel). */
export const isMouseReports = (data: string): boolean => /^(?:\x1b\[<\d+;\d+;\d+[Mm])+$/.test(data);

/** Exactly one SGR mouse report. */
export const isMouseReport = (data: string): boolean => SGR_MOUSE_REPORT.test(data);
