import { isMouseReport, isTermReply } from "../shared/termInput";

// Sequences a terminal legitimately sends on its own are answers to queries the
// program asked for and focus reporting (shared/termInput.ts). Everything else
// that xterm emits without the user touching the pane is suspect — that is how
// a session ends up running a command nobody typed — so it is dropped and
// written to ~/.mockingbird/pty-audit.log.
const USER_INPUT_WINDOW_MS = 400;

export type InputSource = "user" | "mouse" | "reply" | "unattributed";

/** Where data xterm wants to send to the pty came from, as far as can be told. */
export function classifyTermInput(data: string, msSinceUserInput: number, mouseTrackingMode: string): InputSource {
  if (msSinceUserInput <= USER_INPUT_WINDOW_MS) return "user";
  // One complete SGR mouse report. Program output can't make xterm emit one:
  // reports come from DOM mouse and wheel events while tracking is on (bindMouse →
  // CoreMouseService.triggerMouseEvent), one per onData call. Paste, synthetic DOM
  // events and Terminal.input() could also produce this shape, but those are the
  // user or renderer code, which can write to the pty anyway. A held button keeps
  // reporting drag motion and the release long after the press that opened the
  // input window, so reports are exempt from it — only in this exact shape, and
  // only while tracking is live. Writes still wait for scrollback replay.
  if (mouseTrackingMode !== "none" && isMouseReport(data)) return "mouse";
  if (isTermReply(data)) return "reply";
  return "unattributed";
}

/**
 * What a pane does with input from its terminal. A local pane forwards the
 * terminal's automatic answers to the program that asked. A teammate's
 * session (team rooms) never does: its owner's terminal answers, and an
 * answer arriving from here would land in the owner's prompt as typing.
 */
export function forwardTermInput(source: InputSource, remote: boolean): "send" | "drop" | "audit" {
  if (source === "user" || source === "mouse") return "send";
  if (source === "unattributed") return "audit";
  return remote ? "drop" : "send";
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
