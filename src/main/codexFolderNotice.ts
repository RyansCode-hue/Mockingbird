import { terminalLines } from "../shared/terminalText";

/**
 * Codex's "Folder access" notice, answered for a room launch. A room names its folders untrusted (codexOutsideOff), and an
 * interactive Codex (0.156.1, fresh or resumed) opens such a folder with a notice: "Open restricted" (it stays untrusted)
 * or "Quit". No setting skips it. Codex draws it as one synchronized frame (`ESC[?2026h` … `ESC[?2026l`) and holds
 * everything behind it: an initial prompt given as an argument isn't sent, and no hook fires, until it's answered.
 *
 * This reads the pane's output frame by frame, as terminalLines reads a screen, and presses Enter only while the latest
 * frame is exactly that notice with "Open restricted" the highlighted choice and no other option. Codex discards input
 * that arrives as the notice is drawn, so it presses once the pane has been quiet for `settleMs`, and again (at most
 * MAX_PRESSES in all) when the notice is still the latest frame and nothing has been drawn for `retryMs` after a press:
 * an Enter Codex takes is drawn at once, as the notice closing. Any other folder question (another default, wording or
 * option), a notice that outlasts its presses, or a Codex that doesn't open within `stallMs` is left for the user, who is
 * told once. Until Codex's composer is drawn after the notice (or its hooks report), the pane is `holding`: Mockingbird
 * types nothing into it. Without a notice within `waitMs` it stops holding.
 */

export type FolderNoticeState = "watching" | "answered" | "asking" | "clear";

const SYNC_START = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";
/** What's kept of a frame that hasn't ended: a notice is a few kilobytes. */
const MAX_PENDING = 256 * 1024;
export const FOLDER_NOTICE_WAIT_MS = 60_000;
export const FOLDER_NOTICE_SETTLE_MS = 300;
export const FOLDER_NOTICE_RETRY_MS = 2_000;
export const FOLDER_NOTICE_STALL_MS = 15_000;
export const MAX_PRESSES = 3;

/** A frame's text as one line, the way terminalLines reads it, spaces collapsed. */
export function frameText(frame: string): string {
  return terminalLines(frame).join(" ").replace(/\s+/g, " ").trim();
}

/** A folder question Codex asks before it opens, by its headline or choices: its untrusted notice, or its trust prompt. */
const FOLDER_QUESTION = /\bFolder access\b|\bTrust this folder\?|\bOpen restricted\b|\buntrusted folders?\b/;

/** Exactly Codex 0.156.1's notice for an untrusted folder, "Open restricted" highlighted (its `›`), "Quit" the only other choice. */
export function isOpenRestrictedNotice(text: string): boolean {
  return (
    /\bFolder access\b/.test(text) &&
    text.includes("Config, hooks, and exec policies from untrusted folders stay disabled.") &&
    text.includes("Opening will not change saved trust.") &&
    /› 1\. Open restricted\b/.test(text) &&
    /(?:^|\s)2\. Quit\b/.test(text) &&
    !/› 2\./.test(text) &&
    !/(?:^|\s)3\. /.test(text) &&
    !/\bTrust this folder\?|\bTrust and continue\b/.test(text) &&
    text.includes("enter continue · esc quit")
  );
}

/** A timer that doesn't keep the process up for a pane's sake. */
function later(f: () => void, ms: number): ReturnType<typeof setTimeout> {
  const t = setTimeout(f, ms);
  t.unref?.();
  return t;
}

/** Codex's composer drawn: its mark, then something that isn't a numbered choice. */
const COMPOSER = /(?:^|\s)› (?!\d+\. )\S/;

export class CodexFolderNotice {
  state: FolderNoticeState = "watching";
  /** Enters pressed on the notice. */
  presses = 0;
  private pending = "";
  /** The notice has been drawn: what follows is read against it. */
  private seen = false;
  /** The latest frame with text is exactly the notice to answer. */
  private up = false;
  private wait: ReturnType<typeof setTimeout> | null;
  private quiet: ReturnType<typeof setTimeout> | null = null;
  private stall: ReturnType<typeof setTimeout> | null = null;
  private readonly settleMs: number;
  private readonly retryMs: number;
  private readonly stallMs: number;

  constructor(
    private o: {
      /** Presses Enter in the pane. */
      press: () => void;
      /** Enter was pressed on the notice (the nth time): for the log. */
      answered: (press: number) => void;
      /** Left to the user, who is told once why. */
      asking: (why: string) => void;
      /** Holding ended: Codex drew its composer after the notice, its hooks reported, or no notice came in time. */
      cleared: (by: "drawn" | "hook" | "waited") => void;
      waitMs?: number;
      settleMs?: number;
      retryMs?: number;
      stallMs?: number;
    }
  ) {
    this.settleMs = o.settleMs ?? FOLDER_NOTICE_SETTLE_MS;
    this.retryMs = o.retryMs ?? FOLDER_NOTICE_RETRY_MS;
    this.stallMs = o.stallMs ?? FOLDER_NOTICE_STALL_MS;
    this.wait = later(() => {
      this.wait = null;
      if (!this.seen && this.state === "watching") this.clear("waited");
    }, o.waitMs ?? FOLDER_NOTICE_WAIT_MS);
  }

  /** While true, nothing is to be typed into the pane. */
  holding(): boolean {
    return this.state !== "clear";
  }

  /** The pane's output as it arrives. */
  output(data: string): void {
    if (!this.holding()) return;
    this.pending += data;
    for (let end = this.pending.indexOf(SYNC_END); end >= 0; end = this.pending.indexOf(SYNC_END)) {
      const frame = this.pending.slice(0, end);
      this.pending = this.pending.slice(end + SYNC_END.length);
      this.frame(frame.slice(Math.max(0, frame.lastIndexOf(SYNC_START))));
      if (!this.holding()) return;
    }
    // output outside a frame (a shell starting, a renderer that doesn't synchronize) is read as it comes
    const open = this.pending.lastIndexOf(SYNC_START);
    if (open < 0) {
      if (!this.pending.endsWith("\x1b") && !/\x1b\[[0-9;?]*$/.test(this.pending)) {
        this.frame(this.pending);
        this.pending = "";
      }
    } else if (open > 0) {
      this.frame(this.pending.slice(0, open));
      this.pending = this.pending.slice(open);
    }
    if (this.pending.length > MAX_PENDING) this.pending = this.pending.slice(-MAX_PENDING);
    if (!this.holding()) return;
    // anything drawn restarts the wait for quiet; Enter goes only into a still screen showing the notice
    this.armQuiet(this.presses ? this.retryMs : this.settleMs);
  }

  /** Its agent's hooks reported for the pane: Codex fires none until it's past the notice. */
  hookEvent(): void {
    if (this.seen) this.clear("hook");
  }

  /** The pane ended. */
  stop(): void {
    this.cancel();
    this.state = "clear";
  }

  private frame(raw: string): void {
    if (!raw) return;
    const text = frameText(raw);
    if (!text) return;
    if (isOpenRestrictedNotice(text)) {
      if (!this.seen) {
        this.seen = true;
        this.armStall("its Codex's folder notice changed before Mockingbird answered it");
      }
      this.up = true;
      return;
    }
    this.up = false;
    if (FOLDER_QUESTION.test(text)) {
      this.seen = true;
      this.ask("its Codex is asking a folder question Mockingbird doesn't answer for it");
      return;
    }
    if (this.seen && COMPOSER.test(text)) this.clear("drawn");
  }

  /** Enter, when the notice is the still screen; or, once it has had its presses, the user is told. */
  private armQuiet(ms: number): void {
    if (this.quiet) clearTimeout(this.quiet);
    this.quiet = null;
    if (!this.up || this.state === "asking") return;
    this.quiet = later(() => {
      this.quiet = null;
      if (!this.up || !this.holding() || this.state === "asking") return;
      if (this.presses >= MAX_PRESSES) {
        this.ask(`its Codex didn't take Mockingbird's Enter on its folder notice (${MAX_PRESSES} tries)`);
        return;
      }
      this.presses++;
      this.state = "answered";
      this.o.press();
      this.o.answered(this.presses);
      this.armStall("its Codex didn't open its folder after Mockingbird answered its folder notice");
      // an Enter Codex discarded draws nothing: no output for retryMs, the notice still up, means press again
      this.armQuiet(this.retryMs);
    }, ms);
  }

  private armStall(why: string): void {
    if (this.stall) clearTimeout(this.stall);
    this.stall = later(() => {
      this.stall = null;
      if (this.state === "watching" || this.state === "answered") this.ask(why);
    }, this.stallMs);
  }

  private ask(why: string): void {
    if (this.state === "asking" || this.state === "clear") return;
    if (this.quiet) clearTimeout(this.quiet);
    this.quiet = null;
    this.state = "asking";
    this.o.asking(why);
  }

  private cancel(): void {
    for (const t of [this.wait, this.quiet, this.stall]) if (t) clearTimeout(t);
    this.wait = this.quiet = this.stall = null;
  }

  private clear(by: "drawn" | "hook" | "waited"): void {
    this.cancel();
    if (this.state === "clear") return;
    this.state = "clear";
    this.pending = "";
    this.up = false;
    this.o.cleared(by);
  }
}
