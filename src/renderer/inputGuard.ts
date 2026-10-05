// Sequences a terminal legitimately sends on its own: answers to queries the
// program asked for (cursor position, device attributes, colours) and focus
// reporting. Everything else that xterm emits without the user touching the
// pane is suspect — that is how a session ends up running a command nobody
// typed — so it is dropped and written to ~/.mockingbird/pty-audit.log.
const TERM_REPLY = new RegExp(
  "^(?:" +
    "\\x1b\\[[?>]?[0-9;]*[Rcn]" + // cursor position / primary and secondary device attributes / device status
    "|\\x1b\\[\\??[0-9;]*\\$y" + // mode report (DECRQM)
    "|\\x1b\\[[IO]" + // focus in / focus out reporting
    "|\\x1b\\][0-9]+;[^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)" + // OSC colour answers
    "|\\x1bP[^\\x1b]*\\x1b\\\\" + // DCS answers (XTGETTCAP, DECRQSS)
    ")$"
);
const USER_INPUT_WINDOW_MS = 400;

// One complete SGR mouse report. Program output can't make xterm emit one:
// reports come from DOM mouse and wheel events while tracking is on (bindMouse →
// CoreMouseService.triggerMouseEvent), one per onData call. Paste, synthetic DOM
// events and Terminal.input() could also produce this shape, but those are the
// user or renderer code, which can write to the pty anyway. A held button keeps
// reporting drag motion and the release long after the press that opened the
// input window, so reports are exempt from it — only in this exact shape, and
// only while tracking is live. Writes still wait for scrollback replay.
const SGR_MOUSE_REPORT = /^\x1b\[<\d+;\d+;\d+[Mm]$/;

export type InputSource = "user" | "mouse" | "reply" | "unattributed";

/** Where data xterm wants to send to the pty came from, as far as can be told. */
export function classifyTermInput(data: string, msSinceUserInput: number, mouseTrackingMode: string): InputSource {
  if (msSinceUserInput <= USER_INPUT_WINDOW_MS) return "user";
  if (mouseTrackingMode !== "none" && SGR_MOUSE_REPORT.test(data)) return "mouse";
  if (TERM_REPLY.test(data)) return "reply";
  return "unattributed";
}

/**
 * How a paste is delivered. Text wins whenever the clipboard has it — apps
 * often put an image rendition beside copied text — and goes through xterm's
 * own paste (bracketed when the program asked). Only an image-only clipboard
 * becomes Ctrl+V, for Claude Code to read the image from the pasteboard itself.
 */
export function pasteRoute(types: readonly string[]): "xterm" | "image" {
  if (types.includes("text/plain")) return "xterm";
  return types.some((t) => t.startsWith("image/")) ? "image" : "xterm";
}
