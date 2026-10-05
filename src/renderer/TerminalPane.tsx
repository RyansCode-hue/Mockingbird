import { useEffect, useRef, useState } from "react";
import { beginDrag, dragging } from "./drag";
import { PinIcon } from "./Icons";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { formatShare, formatTokens, totalTokens, type FileOverlap, type PrState, type PrStatus, type SessionInfo, type SessionMeter, type TokenCounts, type WorktreeStateInfo } from "../shared/types";
import { mousePolicyFor, selectsNatively, stripMouseEnables, type MousePolicy } from "./mouseModes";
import { classifyTermInput, pasteRoute } from "./inputGuard";
import { useFolderRefresh } from "./folderWatch";
import { dataPump, replay, type CachedTerm } from "./cachedTerm";
import { CopyToast, useCopyNote } from "./copyNote";

declare global {
  interface Window {
    mb: any;
  }
}

// Replay (cachedTerm.ts) gates both directions. Live output waits until the
// history is queued, and input until xterm has parsed it: xterm auto-answers
// the query sequences it finds in the replayed history (cursor position, DA,
// OSC colour), and forwarding those answers to the pty types garbage into the
// live prompt — that is how a reload could end up submitting a stray slash
// command like /clear.
interface TermEntry extends CachedTerm {
  fit: FitAddon;
  /** Told when the CLI's side-panel close glyph appears or goes, while a pane shows this terminal. */
  onPanel: ((cell: { col: number; row: number } | null) => void) | null;
  lastInput: number; // ms of the last real keystroke/paste/mouse press in this pane
  inputWired?: boolean; // DOM input listeners attached to xterm's textarea
  lastReply: string; // loop detector: the same answer repeating means the
  lastReplyCount: number; // answer itself is provoking the next question
  lastReplyStart: number;
  mousePolicy: MousePolicy; // which of the CLI's mouse requests reach xterm (mouseModes.ts)
  carry: string; // trailing partial escape sequence held until the next chunk
  dragging: boolean; // native (xterm) selection drag in progress
  hold: string[] | null; // output parked during a native selection drag
  holdStart: number;
  wantsMouse: boolean; // the CLI has mouse reporting on (xterm may not have been given it)
  tracking: number; // tracking mode xterm was last given (mouseModes.ts)
  buttonHeld: boolean; // a gesture the CLI owns is in progress
  wheelAcc: number; // accumulated wheel pixels not yet emitted as scroll lines
}
const terms = new Map<string, TermEntry>();
(window as any).__mbTerms = terms; // diagnostics: inspect a pane's terminal from devtools

// the platform test xterm uses to pick its force-selection modifier (Option, else Shift)
const IS_MAC = ["Macintosh", "MacIntel", "MacPPC", "Mac68K"].includes(navigator.platform);

// Loop detector for automatic query answers. A program starting up asks a
// varied handful of questions (device attributes, cursor position, colours —
// including the background-colour probe the claude TUI uses to pick light or
// dark, so answers must flow even for hidden panes). A feedback loop looks
// different: the SAME answer repeating on a short period, indefinitely. Only
// that is suppressed.
const REPLY_LOOP_COUNT = 8;
const REPLY_LOOP_WINDOW_MS = 5000;

// xterm clears a selection the moment a write touches the selected rows, and
// an agent TUI redraws its frame continuously while generating — so a native
// selection inside it died within a second. While a native selection drag is
// in progress, output is parked and the pane freezes at the moment of
// selection; everything parked is written on release, once the text has been
// captured, with a time/size cap so a pane can never stall. Selections the
// CLI draws itself (Claude with mouse reporting on) never park output.
const HOLD_MAX_MS = 15_000;
const HOLD_MAX_BYTES = 400_000;

function flushHold(e: TermEntry): void {
  if (!e.hold) return;
  const parked = e.hold;
  e.hold = null;
  for (const c of parked) e.term.write(c);
}

function pumpWrite(e: TermEntry, data: string): void {
  const chunk = stripMouseEnables(e, data);
  if (!chunk) return;
  // park only while the drag is in progress — once released the text is
  // already on the clipboard, so live redraws may reflow the highlight away
  // exactly as they would in any terminal. An idle pane keeps it indefinitely.
  if (e.dragging) {
    if (!e.hold) {
      e.hold = [];
      e.holdStart = Date.now();
    }
    e.hold.push(chunk);
    const bytes = e.hold.reduce((n, c) => n + c.length, 0);
    if (Date.now() - e.holdStart > HOLD_MAX_MS || bytes > HOLD_MAX_BYTES) flushHold(e);
    return;
  }
  if (e.hold) flushHold(e);
  e.term.write(chunk);
}

/**
 * The claude TUI's side panel (its /diff view) draws a literal "×" in the top
 * rows of the right half of the screen. Its cell — 1-based, as mouse reports
 * count — is how a close click can be delivered to the CLI without ever
 * typing into the prompt.
 */
// The panel is a background-filled box, so its top row is usually spaces
// ending in the close glyph; a dedicated multiplication-sign glyph is proof
// enough on its own, a plain "x" only alongside a drawn border.
const PANEL_CLOSE_GLYPHS = new Set(["×", "✕", "✖", "⨯"]);
const PANEL_BORDER_RE = /[─━╌┄┈╭┌╮┐]/;
function findPanelClose(term: Terminal): { col: number; row: number } | null {
  const buf = term.buffer.active;
  const rows = Math.min(6, term.rows);
  for (let y = 0; y < rows; y++) {
    const line = buf.getLine(buf.viewportY + y)?.translateToString(true) ?? "";
    const trimmed = line.trimEnd();
    if (!trimmed) continue;
    const x = trimmed.length - 1;
    const glyph = trimmed[x];
    if (x < term.cols / 2) continue;
    const right = trimmed.slice(Math.floor(term.cols / 2));
    const isClose =
      PANEL_CLOSE_GLYPHS.has(glyph) || ((glyph === "x" || glyph === "X") && PANEL_BORDER_RE.test(right));
    if (isClose) return { col: x + 1, row: y + 1 };
  }
  return null;
}

/** Press and release at a cell, in the SGR mouse encoding the CLI asked for. */
function clickCell(id: string, cell: { col: number; row: number }): void {
  writeSession(id, `\x1b[<0;${cell.col};${cell.row}M\x1b[<0;${cell.col};${cell.row}m`);
}

/** The only path from the UI to a pty: silently no-ops until replay is done. */
function writeSession(id: string, data: string): void {
  if (terms.get(id)?.ready) window.mb.sessionWrite(id, data);
}

// session output reaches every cached terminal, even while its pane is
// unmounted (hidden group / inactive workspace tab)
const ensureDataPump = dataPump((cb) => window.mb.onSessionData(cb), terms, pumpWrite);

/**
 * Repaint a glitched terminal. Replaying the byte history can't fix TUI
 * corruption (old frames were rendered at other sizes — replay reproduces the
 * garbage). Instead: clear the terminal, then nudge the pty size so the CLI
 * redraws its current frame cleanly, like a fresh SIGWINCH.
 */
export async function resyncTerm(id: string): Promise<void> {
  const entry = terms.get(id);
  if (!entry) return;
  const { term } = entry;
  // RIS rather than term.reset(): it applies after output already queued, so a
  // queued mode change can't land after the reset. The CLI still believes its
  // mouse modes are on (wantsMouse stays), so the wheel is forwarded for it.
  term.write("\x1bc");
  entry.tracking = 0;
  const { cols, rows } = term;
  window.mb.sessionResize(id, Math.max(2, cols - 1), rows);
  setTimeout(() => window.mb.sessionResize(id, cols, rows), 80);
}

const TERM_THEMES = {
  dark: {
    background: "#201f1c",
    foreground: "#c9c3b8",
    cursor: "#e0a34a",
    cursorAccent: "#201f1c",
    // translucent white, like stock xterm — the old #3a372f was near-invisible
    // against the pane background, so selections looked broken even when live
    selectionBackground: "rgba(255, 255, 255, 0.35)",
    selectionInactiveBackground: "rgba(255, 255, 255, 0.22)",
  },
  light: {
    background: "#fbf9f5",
    foreground: "#4f4a3f",
    cursor: "#a06a12",
    cursorAccent: "#fbf9f5",
    selectionBackground: "rgba(30, 60, 110, 0.25)",
    selectionInactiveBackground: "rgba(30, 60, 110, 0.15)",
  },
};

export function currentTermTheme() {
  return document.documentElement.dataset.theme === "light" ? TERM_THEMES.light : TERM_THEMES.dark;
}

/** Restyle every live terminal when the app theme flips. */
/** Other terminals (run logs) that follow the app theme. */
export const termThemeListeners = new Set<(theme: ReturnType<typeof currentTermTheme>) => void>();

/** "52k new input · 12k output · 1.1M read from cache · 30k written to cache · 41 replies". */
export function tokenBreakdown(t: TokenCounts): string {
  return [
    `${formatTokens(t.input)} new input`,
    `${formatTokens(t.output)} output`,
    `${formatTokens(t.cacheRead)} read from cache`,
    ...(t.cacheWrite ? [`${formatTokens(t.cacheWrite)} written to cache`] : []),
    `${t.replies.toLocaleString()} replies`,
  ].join(" · ");
}

function meterTitle(m: SessionMeter): string {
  const lines = [`All of this pane's conversations: ${formatTokens(totalTokens(m.tokens))} tokens`, tokenBreakdown(m.tokens)];
  if (m.window) {
    lines.push(
      "",
      `This 5-hour window: ${formatTokens(m.window.tokens)} tokens${m.window.sharePct != null ? ` ≈ ${formatShare(m.window.sharePct)} of the limit` : ""} (the window is at ${Math.round(m.window.usedPct)}%)`,
      "An estimate: this pane's share of what this Mac's sessions used in the window, weighted by model. Use elsewhere (claude.ai, another computer) isn't counted, so it can read high."
    );
  }
  return lines.join("\n");
}

export function applyTermTheme(light: boolean): void {
  const theme = light ? TERM_THEMES.light : TERM_THEMES.dark;
  for (const { term } of terms.values()) term.options.theme = theme;
  for (const l of termThemeListeners) l(theme);
}

export type PaneDensity = "min" | "std" | "max";

/** Window-style resize handlers on a pane's own edges; absent axes hide their handle. */
export interface PaneResize {
  x?: (e: React.PointerEvent) => void; // right edge
  y?: (e: React.PointerEvent) => void; // bottom edge
  reset?: () => void; // double-click a handle → even the grid back out
}

export function fmtElapsed(fromMs: number, seconds = false): string {
  const s = Math.max(0, Math.floor((Date.now() - fromMs) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return seconds ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Shorten hook Notification messages to banner-sized reasons. */
export function shortReason(reason: string | null): string {
  if (!reason) return "waiting for you";
  const perm = reason.match(/needs your permission to (?:use )?(.+)/i);
  if (perm) return `permission: ${perm[1]}`;
  if (/waiting for your input/i.test(reason)) return "waiting for you";
  return reason;
}

/** Distinct files across a pane's overlaps. */
const overlapCount = (list: FileOverlap[]) => new Set(list.flatMap((o) => o.files)).size;

const PR_LABEL: Record<PrState["state"], string> = { draft: "draft", open: "open", approved: "approved", changes: "changes requested", merged: "merged", closed: "closed" };

/** One xterm attached to a PTY session. Terminals are cached so re-layout keeps scrollback. */
export function TerminalPane({
  session,
  focused,
  zoomed,
  density,
  paneIndex,
  onFocus,
  onClose,
  onOpenFiles,
  onOpenChanges,
  runCount,
  onOpenRun,
  meter,
  onZoom,
  onAddTab,
  onReorder,
  drop,
  onResume,
  onCleanup,
  closeTitle,
  resize,
  embedded,
  pinned,
  onPin,
  pinNote,
  tabDrop,
  onHandoff,
  onUndoTurn,
  overlaps,
  onJump,
  onRestart,
  messages,
  onShowMessages,
}: {
  session: SessionInfo;
  focused: boolean;
  zoomed: boolean;
  density: PaneDensity;
  paneIndex: number;
  onFocus: () => void;
  onClose: () => void;
  /** Show this session's folder in the explorer dock. */
  onOpenFiles?: () => void;
  /** Open Source Control for this pane's folder. */
  onOpenChanges?: () => void;
  /** How many of this worktree's services are running (Run and Debug), and opening that view. */
  runCount?: number;
  /** Tokens this pane's conversations used, and its estimated share of the 5-hour limit. */
  meter?: SessionMeter;
  onOpenRun?: () => void;
  onZoom?: () => void; // omit to hide the fullscreen control (WorkTracker tab)
  onAddTab?: () => void; // "+" — start a workspace here and add a tab to it
  onReorder?: (srcId: string, targetId: string) => void;
  /** Drag-and-drop onto this pane (the grid decides what a drop means); without it, a drop reorders. */
  drop?: { over: (e: React.DragEvent) => void; drop: (e: React.DragEvent) => void; cue?: string };
  onResume: () => void;
  onCleanup: () => void;
  closeTitle?: string;
  resize?: PaneResize;
  embedded?: boolean; // inside a workspace pane — the wrapper owns border/radius
  /** Pinned panes stay on screen when the grid switches groups. */
  pinned?: boolean;
  onPin?: () => void;
  /** Shown on a pinned pane visiting from another group: which group it belongs to. */
  pinNote?: string;
  /** A session dropped on the header joins this pane as a tab (a drop on the body moves panes). */
  tabDrop?: { over: (e: React.DragEvent) => void; drop: (e: React.DragEvent) => void; cue?: string };
  /** Continue this session's task in the other agent. */
  onHandoff?: () => void;
  /** Put the files back as they were before one of the agent's turns. */
  onUndoTurn?: () => void;
  /** Files another worktree of this repository has also changed. */
  overlaps?: FileOverlap[];
  onJump?: (sessionId: string) => void;
  /** Restart this pane, resuming its conversation (for a stuck one). */
  onRestart?: () => void;
  /** Agent messages this pane received and sent, and opening their log. */
  messages?: { in: number; out: number };
  onShowMessages?: () => void;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const dead = session.status === "dead";
  const waiting = session.status === "waiting";
  const [editTitle, setEditTitle] = useState<string | null>(null);
  const [copyNote, copy] = useCopyNote();
  const [panelClose, setPanelClose] = useState<{ col: number; row: number } | null>(null);
  const [exitTail, setExitTail] = useState<string | null>(null);
  useEffect(() => {
    if (!dead) {
      setExitTail(null);
      return;
    }
    let alive = true;
    window.mb.sessionBuffer(session.id).then((buf: string) => {
      if (!alive) return;
      const text = (buf || "")
        .replace(/\x1b\[[0-9;?<>=]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\|\x1b[()=>][A-Za-z0-9]?|\x1b[78]|\r/g, "")
        .split("\n")
        .map((l) => l.trimEnd())
        .filter((l) => l.trim().length > 0);
      setExitTail(text.slice(-12).join("\n"));
    });
    return () => {
      alive = false;
    };
  }, [dead, session.id]);

  const commitTitle = async () => {
    const v = editTitle?.trim();
    if (v && v !== (session.ticketTitle ?? session.title)) await window.mb.renameSession(session.id, v);
    setEditTitle(null);
  };

  // ticker: 1s while waiting (banner shows seconds), 30s otherwise (elapsed meta)
  const [, setTick] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => setTick((t) => t + 1), waiting ? 1000 : 30000);
    return () => clearInterval(iv);
  }, [waiting]);

  // git state for the header's change count and the rail, read when the folder
  // changes (panes in one folder share one read in the main process)
  const [gitState, setGit] = useState<WorktreeStateInfo | { error: string } | null>(null);
  const gitRoot = density !== "min" && session.repoPath && !dead ? session.cwd : null;
  const gitSeq = useRef(0);
  const readGit = () => {
    const n = ++gitSeq.current;
    if (!gitRoot) return setGit(null);
    window.mb.worktreeState(gitRoot).then(
      (r: WorktreeStateInfo | { error: string }) => n === gitSeq.current && setGit(r ?? { error: "no answer" }),
      (err: unknown) => n === gitSeq.current && setGit({ error: String(err) })
    );
  };
  useEffect(readGit, [gitRoot]);
  useFolderRefresh(gitRoot, readGit, 30_000);
  const git = gitState && !("error" in gitState) ? gitState : null;
  const gitErr = gitState && "error" in gitState ? gitState.error : null;

  // the branch's pull request, for the rail (the main process caches lookups for 2 minutes)
  const [pr, setPr] = useState<PrStatus | null>(null);
  const prRoot = density === "max" && gitRoot ? gitRoot : null;
  const prSeq = useRef(0);
  const readPr = (fresh = false) => {
    const n = ++prSeq.current;
    if (!prRoot) return setPr(null);
    const failed = (error: string): PrStatus => ({ branch: null, pr: null, error, at: Date.now() });
    window.mb.prStatus(prRoot, fresh).then(
      (r: PrStatus | { error: string }) => n === prSeq.current && setPr("error" in r && !("at" in r) ? failed(r.error) : (r as PrStatus)),
      (err: unknown) => n === prSeq.current && setPr(failed(String(err)))
    );
  };
  useEffect(() => {
    readPr();
    if (!prRoot) return;
    const t = setInterval(() => !document.hidden && readPr(), 180_000);
    return () => clearInterval(t);
  }, [prRoot, git?.branch]);

  useEffect(() => {
    if (dead) return; // dead panes show the resume body instead of the terminal
    ensureDataPump();
    let entry = terms.get(session.id);
    if (!entry) {
      // a session id keeps its agent and shell flag through restarts, and a
      // resumed pane gets a fresh entry, so the policy is fixed per entry
      const mousePolicy = mousePolicyFor(session);
      const term = new Terminal({
        fontFamily: '"JetBrains Mono", "SF Mono", Menlo, monospace',
        fontSize: density === "max" ? 11.5 : 11,
        lineHeight: 1.4,
        theme: currentTermTheme(),
        scrollback: 8000,
        allowProposedApi: true,
        // Option-drag selects natively while Claude has the mouse. Option-click
        // must not also move the prompt cursor: a short native gesture would
        // otherwise type arrow keys into the prompt.
        ...(mousePolicy === "claude" ? { macOptionClickForcesSelection: true, altClickMovesCursor: false } : {}),
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      const e: TermEntry = {
        term,
        fit,
        replayed: false,
        ready: false,
        onPanel: null,
        lastInput: 0,
        lastReply: "",
        lastReplyCount: 0,
        lastReplyStart: 0,
        mousePolicy,
        carry: "",
        dragging: false,
        hold: null,
        holdStart: 0,
        // Only the CLI's own mode sequences turn this on. An inline CLI keeps its
        // history in the terminal's scrollback, so the wheel must scroll that
        // and selection can span it (click, scroll, shift-click). Assuming mouse
        // mode sent wheel reports to a CLI that never asked, leaving the pane
        // unscrollable.
        wantsMouse: false,
        tracking: 0,
        buttonHeld: false,
        wheelAcc: 0,
      };
      // the side panel appears and disappears with output; recheck at most
      // twice a second so the header's "hide diff" button tracks it
      let panelCheck: ReturnType<typeof setTimeout> | null = null;
      term.onWriteParsed(() => {
        if (panelCheck) return;
        panelCheck = setTimeout(() => {
          panelCheck = null;
          e.onPanel?.(e.wantsMouse ? findPanelClose(term) : null);
        }, 500);
      });
      term.onData((d) => {
        const now = Date.now();
        const source = classifyTermInput(d, now - e.lastInput, term.modes.mouseTrackingMode);
        if (source === "user" || source === "mouse") return writeSession(session.id, d);
        // no user input behind this: it is either an answer to a query the
        // program asked for, or something that has no business being typed
        if (source === "unattributed") {
          window.mb.auditWrite(session.id, "dropped-unattributed", d);
          return;
        }
        if (d === e.lastReply && now - e.lastReplyStart < REPLY_LOOP_WINDOW_MS) {
          e.lastReplyCount++;
          if (e.lastReplyCount > REPLY_LOOP_COUNT) {
            window.mb.auditWrite(session.id, "suppressed-reply-loop", d);
            return;
          }
        } else {
          e.lastReply = d;
          e.lastReplyCount = 1;
          e.lastReplyStart = now;
        }
        writeSession(session.id, d);
      });
      // Shift+Enter = newline in the Claude prompt. Terminals send plain CR for
      // both Enter and Shift+Enter, so we translate to ESC+CR (what Option+Enter
      // sends), which the Claude CLI treats as "insert newline, don't submit".
      term.attachCustomKeyEventHandler((ev) => {
        if (ev.type === "keydown" || ev.type === "keypress") e.lastInput = Date.now();
        if (
          ev.type === "keydown" &&
          ev.key === "Enter" &&
          ev.shiftKey &&
          !ev.metaKey &&
          !ev.ctrlKey &&
          !ev.altKey
        ) {
          ev.preventDefault();
          ev.stopPropagation();
          writeSession(session.id, "\x1b\r");
          return false;
        }
        return true;
      });
      entry = e;
      terms.set(session.id, entry);
      void replay(e, window.mb.sessionBuffer(session.id), () => terms.get(session.id) === e, (buf) => stripMouseEnables(e, buf));
    }
    const { term, fit } = entry;
    // the header's "hide diff" button follows the panel for whichever pane shows this terminal now
    const onPanel = (found: { col: number; row: number } | null) =>
      setPanelClose((prev) => (prev?.col === found?.col && prev?.row === found?.row ? prev : found));
    entry.onPanel = onPanel;
    onPanel(entry.wantsMouse ? findPanelClose(term) : null);
    if (holder.current && !term.element) term.open(holder.current);
    if (!entry.inputWired && term.textarea) {
      entry.inputWired = true;
      const mark = () => {
        const t = terms.get(session.id);
        if (t) t.lastInput = Date.now();
      };
      // every path a human's input can take into xterm: physical keys, IME
      // composition, dictation/autofill (input events), and paste
      for (const ev of ["keydown", "beforeinput", "input", "compositionstart", "compositionupdate", "compositionend", "paste"]) {
        term.textarea.addEventListener(ev, mark, true);
      }
    }
    else if (holder.current && term.element && term.element.parentElement !== holder.current) {
      holder.current.appendChild(term.element);
    }

    const doFit = () => {
      try {
        // only resize when the geometry actually changed — every needless pty
        // resize makes the CLI redraw its frame, which is what leaves stale
        // duplicated lines behind when xterm has reflowed the old frame
        const dims = fit.proposeDimensions();
        if (!dims || !dims.cols || !dims.rows) return;
        if (dims.cols === term.cols && dims.rows === term.rows) return;
        fit.fit();
        window.mb.sessionResize(session.id, term.cols, term.rows);
      } catch {
        /* not visible yet */
      }
    };
    doFit();
    const ro = new ResizeObserver(doFit);
    if (holder.current) ro.observe(holder.current);

    const stamp = () => {
      const t = terms.get(session.id);
      if (t) t.lastInput = Date.now(); // mouse/paste count as user input too
    };
    // Who owns a left-button gesture is settled at the press, exactly as xterm
    // settles it on the mousedown that follows, and holds until release even
    // if the modifier is let go first. A gesture the CLI owns is reported to
    // it live, so output keeps flowing; only a native one parks output.
    const onDown = (ev: PointerEvent) => {
      stamp();
      if (ev.button !== 0) return;
      const t = terms.get(session.id);
      if (!t) return;
      const native = selectsNatively(t.term.modes.mouseTrackingMode, ev, IS_MAC, !!t.term.options.macOptionClickForcesSelection);
      t.dragging = native;
      t.buttonHeld = !native;
    };
    const endDrag = () => {
      const t = terms.get(session.id);
      if (!t) return;
      t.buttonHeld = false;
      if (!t.dragging) return;
      t.dragging = false;
      if (!t.term.hasSelection()) return flushHold(t); // just a click — resume instantly
      // copy-on-select, cmux-style: release puts the text on the clipboard and
      // the pane resumes immediately. The highlight is never cleared by us —
      // it stays until a click elsewhere or the CLI redraws over it.
      // A failed copy leaves the selection standing for ⌘C.
      const text = t.term.getSelection();
      if (text) copy(text, `pane ${session.id}'s selection`);
      flushHold(t);
    };
    const cancelDrag = () => {
      const t = terms.get(session.id);
      if (!t) return;
      t.buttonHeld = false;
      if (!t.dragging) return;
      t.dragging = false;
      flushHold(t);
    };
    // ⌘V with only an image on the clipboard: forward Ctrl+V (\x16) to the CLI —
    // Claude Code reads the image from the macOS pasteboard itself and shows
    // "[Image #1]". Anything with text falls through to xterm's normal paste.
    const onPaste = (e: ClipboardEvent) => {
      stamp();
      const data = e.clipboardData;
      if (!data) return;
      if (pasteRoute([...data.types, ...[...data.items].map((it) => it.type)]) !== "image") return;
      e.preventDefault();
      e.stopPropagation();
      writeSession(session.id, "\x16");
    };
    const el = holder.current;
    el?.addEventListener("paste", onPaste, true);
    const onClick = (ev: MouseEvent) => {
      const t = terms.get(session.id);
      // xterm reporting the mouse delivers the click itself; Option (a native
      // selection then) must not bring the synthesized one back either
      if (!t?.wantsMouse || !t.ready || t.term.hasSelection() || t.term.modes.mouseTrackingMode !== "none") return;
      const target = findPanelClose(t.term);
      if (!target) return;
      const screen = t.term.element?.querySelector(".xterm-screen");
      if (!screen) return;
      const r = screen.getBoundingClientRect();
      const col = Math.floor(((ev.clientX - r.left) / r.width) * t.term.cols) + 1;
      const row = Math.floor(((ev.clientY - r.top) / r.height) * t.term.rows) + 1;
      if (Math.abs(col - target.col) <= 1 && row === target.row) {
        ev.preventDefault();
        ev.stopPropagation();
        clickCell(session.id, target);
      }
    };
    const onWheel = (ev: WheelEvent) => {
      stamp();
      const t = terms.get(session.id);
      if (!t?.ready) return;
      // While xterm is tracking, it reports the wheel itself — except during a
      // native selection, whose frame is frozen: the CLI would scroll unseen.
      if (t.term.modes.mouseTrackingMode !== "none") {
        if (t.dragging) {
          ev.preventDefault();
          ev.stopPropagation();
        }
        return;
      }
      // the CLI asked for the mouse but xterm wasn't given it: deliver wheel as
      // the SGR reports it expects, so scrolling scrolls the transcript —
      // xterm's fallback would send arrow keys, which the CLI reads as history
      if (!t.wantsMouse) return;
      if (t.hold || t.dragging) return; // mid-drag the frame is frozen
      const screen = t.term.element?.querySelector(".xterm-screen");
      if (!screen) return;
      ev.preventDefault();
      ev.stopPropagation();
      const r = screen.getBoundingClientRect();
      const cellH = r.height / t.term.rows;
      // trackpads stream dozens of tiny pixel deltas per second — emitting a
      // report per event scrolls wildly fast. Accumulate to whole lines (cell
      // heights) and carry the remainder, the same conversion xterm applies to
      // its own native mouse handling. deltaMode: 0=pixels, 1=lines, 2=pages.
      const px = ev.deltaMode === 1 ? ev.deltaY * cellH : ev.deltaMode === 2 ? ev.deltaY * r.height : ev.deltaY;
      if (Math.sign(px) !== Math.sign(t.wheelAcc)) t.wheelAcc = 0; // direction flip
      t.wheelAcc += px;
      const lines = Math.trunc(t.wheelAcc / cellH);
      if (!lines) return; // not a full line yet — swallowed, never arrow-key fallback
      t.wheelAcc -= lines * cellH;
      const col = Math.min(t.term.cols, Math.max(1, Math.floor(((ev.clientX - r.left) / r.width) * t.term.cols) + 1));
      const row = Math.min(t.term.rows, Math.max(1, Math.floor(((ev.clientY - r.top) / r.height) * t.term.rows) + 1));
      const btn = lines < 0 ? 64 : 65;
      const n = Math.min(10, Math.abs(lines));
      writeSession(session.id, `\x1b[<${btn};${col};${row}M`.repeat(n));
    };
    el?.addEventListener("pointerdown", onDown, true);
    el?.addEventListener("wheel", onWheel, { capture: true, passive: false });
    el?.addEventListener("click", onClick, true);
    window.addEventListener("pointerup", endDrag, true);
    window.addEventListener("pointercancel", cancelDrag, true);
    return () => {
      ro.disconnect();
      el?.removeEventListener("paste", onPaste, true);
      el?.removeEventListener("pointerdown", onDown, true);
      el?.removeEventListener("wheel", onWheel, { capture: true } as EventListenerOptions);
      el?.removeEventListener("click", onClick, true);
      window.removeEventListener("pointerup", endDrag, true);
      window.removeEventListener("pointercancel", cancelDrag, true);
      const t = terms.get(session.id);
      if (t) {
        t.dragging = false;
        t.buttonHeld = false;
        flushHold(t); // never leave a hidden pane frozen
        if (t.onPanel === onPanel) t.onPanel = null;
      }
    };
  }, [session.id, dead]);

  // terminal body steps up in the instrumented tier (design 1b)
  useEffect(() => {
    const entry = terms.get(session.id);
    if (!entry || entry.term.options.fontSize === (density === "max" ? 11.5 : 11)) return;
    entry.term.options.fontSize = density === "max" ? 11.5 : 11;
    try {
      entry.fit.fit();
      window.mb.sessionResize(session.id, entry.term.cols, entry.term.rows);
    } catch {
      /* not visible */
    }
  }, [density, session.id]);

  const assistant = session.kind === "assistant" && !session.shell; // repo-less shells aren't assistants
  const shortcut = paneIndex < 9 ? `⌘${paneIndex + 1}` : "";
  const gitStr = git
    ? `${git.upstream ? `↑${git.ahead} ↓${git.behind}` : "not on origin"} · ${git.dirty ? `${git.dirtyFiles} uncommitted` : "clean"}`
    : null;
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const gitTitle = git
    ? [
        git.upstream
          ? `Compared with ${git.upstream} as of the last fetch: ↑ ${plural(git.ahead, "commit")} here it doesn't have (to push), ↓ ${plural(git.behind, "commit")} there this branch doesn't have (to pull).`
          : "This branch doesn't track a remote branch yet.",
        git.dirty ? `${plural(git.dirtyFiles, "file")} with uncommitted changes (edited or new).` : "No uncommitted changes.",
        "Click for Source Control — Pull, Push, the graph.",
      ].join("\n")
    : "";
  const meta = fmtElapsed(session.createdAt);

  return (
    <div
      className={[
        "pane",
        `density-${density}`,
        embedded ? "embedded" : "",
        focused ? "focused" : "",
        waiting ? "st-waiting" : "",
        dead ? "st-dead" : "",
        assistant ? "kind-assistant" : "",
      ].join(" ")}
      onMouseDown={onFocus}
      data-drop={drop?.cue}
      onDragOver={(e) => (drop ? drop.over(e) : e.preventDefault())}
      onDrop={(e) => {
        e.preventDefault();
        if (drop) return drop.drop(e);
        const src = e.dataTransfer.getData("text/mb-session");
        if (src && src !== session.id) onReorder?.(src, session.id);
      }}
    >
      <div
        className="pane-header"
        draggable={editTitle === null}
        onDragStart={(e) => beginDrag(e, "text/mb-session", session.id, `Moving ${session.ticketTitle ?? session.title}`, "pane")}
        title="drag onto another pane's header to make it a tab there, or onto its body to move it · double-click the name to rename"
        data-drop={tabDrop?.cue}
        onDragOver={(e) => {
          if (!tabDrop || !dragging("text/mb-session")) return;
          e.stopPropagation();
          tabDrop.over(e);
        }}
        onDrop={(e) => {
          if (!tabDrop || !dragging("text/mb-session")) return;
          e.preventDefault();
          e.stopPropagation();
          tabDrop.drop(e);
        }}
      >
        <span className={`dot ${density === "max" ? "lg" : ""} ${session.status}`} />
        {editTitle !== null ? (
          <input
            className="rename-input"
            autoFocus
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitTitle();
              if (e.key === "Escape") setEditTitle(null);
            }}
            onMouseDown={(e) => e.stopPropagation()}
          />
        ) : (
          <span
            className="title"
            title="double-click to rename"
            onDoubleClick={(e) => {
              e.stopPropagation();
              setEditTitle(session.ticketTitle ?? session.title);
            }}
          >
            {session.ticketTitle ?? session.title}
          </span>
        )}
        {density !== "min" && session.branch && <span className="chip">{session.branch}</span>}
        {!!runCount && density !== "min" && (
          <button
            className="chip running"
            title={`${runCount} service${runCount === 1 ? "" : "s"} of this worktree running — open Run and Debug`}
            onClick={(e) => {
              e.stopPropagation();
              onOpenRun?.();
            }}
          >
            ▶ {runCount}
          </button>
        )}
        {git?.dirty && (
          <button
            className="chip changes"
            title={`${git.dirtyFiles} uncommitted file${git.dirtyFiles === 1 ? "" : "s"}: +${git.insertions} −${git.deletions} lines in tracked files — open Source Control`}
            onClick={(e) => {
              e.stopPropagation();
              onOpenChanges?.();
            }}
          >
            {git.dirtyFiles} file{git.dirtyFiles === 1 ? "" : "s"}
            {(git.insertions > 0 || git.deletions > 0) && (
              <>
                {" · "}
                <span className="add">+{git.insertions}</span> <span className="del">−{git.deletions}</span>
              </>
            )}
          </button>
        )}
        {gitErr && density === "std" && (
          <span className="chip" title={`Couldn't read this folder's git state: ${gitErr}`}>
            git: couldn't read
          </span>
        )}
        {overlaps && overlaps.length > 0 && density !== "min" && (
          <button
            className="chip overlap"
            title={[
              "Changed here and in another worktree of this repository — a merge conflict waiting to happen:",
              ...overlaps.map((o) => `\n${o.otherTitle}${o.otherBranch ? ` (${o.otherBranch})` : ""}:\n${o.files.map((f) => `  ${f}`).join("\n")}`),
              "\nClick to go to that session.",
            ].join("\n")}
            onClick={(e) => {
              e.stopPropagation();
              onJump?.(overlaps[0].other);
            }}
          >
            ⚠ {overlapCount(overlaps)} overlap
          </button>
        )}
        {density === "max" && (session.model || session.effort) && (
          <span className="chip" title="model · effort for this session">
            {[session.model, session.effort].filter(Boolean).join(" · ")}
          </span>
        )}
        {density === "max" && session.ticketId && (
          <span className={`chip ${dead ? "" : "teal"}`}>
            #{session.ticketId.replace(/^#/, "")}{dead ? "" : " · Active"}
          </span>
        )}
        {assistant && density !== "min" && <span className="chip teal">assistant</span>}
        {session.shell && density !== "min" && <span className="chip">shell</span>}
        {session.agent === "codex" && density !== "min" && <span className="chip">codex</span>}
        {pinNote && density !== "min" && <span className="chip" title="Pinned here from another group">{pinNote}</span>}
        {session.muted && density !== "min" && <span className="chip" title="This session's notifications are muted (unmute from its sidebar row or ⌘K)">muted</span>}
        <span className="meta">{density === "min" ? shortcut : meta}</span>
        <span className="controls">
          {!dead && (
            <button
              className="icon"
              title="Repaint — clear glitched output and have the session redraw its screen"
              onClick={(e) => {
                e.stopPropagation();
                resyncTerm(session.id);
              }}
            >
              ⟳
            </button>
          )}
          {panelClose && !dead && (
            <button
              className="icon"
              title="Hide the CLI's diff side panel (same as its × or /diff)"
              onClick={(e) => {
                e.stopPropagation();
                clickCell(session.id, panelClose);
              }}
            >
              ⊟
            </button>
          )}
          {onAddTab && !dead && (
            <button
              className="icon"
              title="New tab — turn this pane into a workspace and open another session in it"
              onClick={(e) => {
                e.stopPropagation();
                onAddTab();
              }}
            >
              +
            </button>
          )}
          {onUndoTurn && (
            <button
              className="icon"
              title="Undo a turn — put the files back as they were before one of the agent's recent turns"
              onClick={(e) => {
                e.stopPropagation();
                onUndoTurn();
              }}
            >
              ↶
            </button>
          )}
          {onHandoff && (
            <button
              className="icon"
              title={`Continue in ${session.agent === "codex" ? "Claude Code" : "Codex"} — hand this task over with a summary of what's done and what's next`}
              onClick={(e) => {
                e.stopPropagation();
                onHandoff();
              }}
            >
              ⇄
            </button>
          )}
          {onPin && (
            <button
              className={`icon pin ${pinned ? "on" : ""}`}
              title={pinned ? "Unpin — this pane goes back to following its group" : "Pin — keep this pane on screen when you switch groups"}
              aria-pressed={!!pinned}
              onClick={(e) => {
                e.stopPropagation();
                onPin();
              }}
            >
              <PinIcon />
            </button>
          )}
          {onZoom && (
            <button
              className="icon"
              onClick={onZoom}
              title={zoomed ? "Back to the grid (⌘E or esc)" : "Fullscreen — fill the whole grid with this pane (⌘E)"}
            >
              ⛶
            </button>
          )}
          <button className="icon" onClick={onClose} title={closeTitle ?? "Hide from grid (session keeps running)"}>
            {closeTitle ? "✕" : "–"}
          </button>
        </span>
      </div>

      {density === "max" && !dead && (
        <div className="rail">
          <div className="cell">
            <span className="k">Elapsed</span>
            <span className="v">{fmtElapsed(session.createdAt, true)}</span>
          </div>
          {gitStr && (
            <div className={`cell ${onOpenChanges ? "click" : ""}`} title={gitTitle} onClick={onOpenChanges}>
              <span className="k">Git</span>
              <span className={`v ${git!.dirty ? "red" : "teal"}`}>{gitStr}</span>
            </div>
          )}
          {gitErr && (
            <div className="cell" title={`Couldn't read this folder's git state: ${gitErr}`}>
              <span className="k">Git</span>
              <span className="v red">couldn't read</span>
            </div>
          )}
          {pr && (pr.pr || pr.error) && (
            <div
              className="cell click"
              title={
                pr.pr
                  ? [`${pr.pr.title}`, `${pr.branch} → ${pr.pr.base}`, ...pr.pr.reviews, pr.pr.conflicts ? "It has merge conflicts with its base." : "", "Click to open it."].filter(Boolean).join("\n")
                  : `Couldn't check for a pull request: ${pr.error}\nClick to check again.`
              }
              onClick={() => (pr.pr ? window.mb.openExternal(pr.pr.url) : readPr(true))}
            >
              <span className="k">PR</span>
              {pr.pr ? (
                <span className={`v pr-${pr.pr.conflicts ? "changes" : pr.pr.state}`}>
                  #{pr.pr.id} · {PR_LABEL[pr.pr.state]}
                  {pr.pr.conflicts ? " · conflicts" : ""}
                </span>
              ) : (
                <span className="v dim">couldn't check</span>
              )}
            </div>
          )}
          {messages && (
            <div className="cell click" title="Messages from and to other agent sessions — click for the log" onClick={onShowMessages}>
              <span className="k">Msgs</span>
              <span className="v">
                {messages.in}↓ {messages.out}↑
              </span>
            </div>
          )}
          {session.repoPath && (
            <div className="cell">
              <span className="k">Repo</span>
              <span className="v">{session.repoPath.split("/").pop()}</span>
            </div>
          )}
          <div className="cell folder" title={session.cwd}>
            <span className="k">Folder</span>
            <span className="v">
              <span className="fn">{session.cwd.split("/").pop()}</span>
              {onOpenFiles && (
                <button
                  className="mini"
                  title={`Browse ${session.cwd} — files, viewer, diffs (⌘B)`}
                  onClick={onOpenFiles}
                >
                  Files
                </button>
              )}
            </span>
          </div>
          {session.queuedCount ? (
            <div className="cell">
              <span className="k">Queued</span>
              <span className="v">{session.queuedCount} msg</span>
            </div>
          ) : null}
          {/* the session's own usage, apart from where it runs: at the far right */}
          {meter && totalTokens(meter.tokens) > 0 && (
            <div className="cell meter" title={meterTitle(meter)}>
              <span className="k">Tokens</span>
              <span className="v">
                {formatTokens(totalTokens(meter.tokens))}
                {meter.window?.sharePct != null && <span className="share"> · ≈{formatShare(meter.window.sharePct)} of 5h</span>}
              </span>
            </div>
          )}
        </div>
      )}

      {dead ? (
        <div className="dead-body">
          <div>
            process exited
            {typeof session.exitCode === "number" ? ` · code ${session.exitCode}` : ""} · history preserved
          </div>
          {exitTail ? (
            <pre className="dead-tail" title="the last lines the process wrote before exiting">
              {exitTail}
            </pre>
          ) : (
            <div className="dead-tail-none">no output captured before it exited</div>
          )}
          <div className="row">
            <button className="outline strong" onClick={onResume}>Resume</button>
            <button className="outline" onClick={onCleanup}>Close &amp; clean up</button>
          </div>
        </div>
      ) : (
        <>
          <div
            className="term-holder"
            ref={holder}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes("Files")) e.preventDefault();
            }}
            onDrop={(e) => {
              // drop files (screenshots etc.) onto a pane → their paths go into the prompt
              if (!e.dataTransfer.files.length) return;
              e.preventDefault();
              e.stopPropagation();
              const paths = [...e.dataTransfer.files]
                .map((f) => window.mb.getFilePath(f))
                .filter((p): p is string => !!p);
              if (paths.length) {
                writeSession(session.id, paths.map((p) => `"${p}"`).join(" "));
              }
            }}
          />
          <CopyToast note={copyNote} failed="Couldn't copy selection" />
          {session.stalledSince && session.status === "working" && (
            <div className="stall-banner" title="An agent's screen keeps changing while it works; this one hasn't for a while. Repaint redraws it; Restart stops it and resumes the conversation in a fresh process.">
              <span className="reason">No output for {fmtElapsed(session.stalledSince, true)} while working — it may be stuck</span>
              <button
                className="outline"
                onClick={(e) => {
                  e.stopPropagation();
                  resyncTerm(session.id);
                }}
              >
                Repaint
              </button>
              {onRestart && (
                <button
                  className="outline"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRestart();
                  }}
                >
                  Restart
                </button>
              )}
            </div>
          )}
          {waiting && (
            <div className="wait-banner">
              <span className="dot sm waiting" />
              <span className="reason">
                {shortReason(session.waitingReason)}
                {session.waitingSince ? ` · ${fmtElapsed(session.waitingSince, true)}` : ""}
              </span>
              {shortcut && <span className="kbd">{shortcut}</span>}
              <button
                className="icon"
                title="Dismiss — mark this session idle (use if the status is stale)"
                onClick={(e) => {
                  e.stopPropagation();
                  window.mb.clearWaiting(session.id);
                }}
              >
                ✕
              </button>
            </div>
          )}
        </>
      )}

      {resize?.x && (
        <div
          className="rz rz-e"
          title="drag to resize · double-click to even out"
          onPointerDown={resize.x}
          onDoubleClick={resize.reset}
        />
      )}
      {resize?.y && (
        <div
          className="rz rz-s"
          title="drag to resize · double-click to even out"
          onPointerDown={resize.y}
          onDoubleClick={resize.reset}
        />
      )}
      {resize && (resize.x || resize.y) && (
        <div
          className="rz rz-se"
          title="drag to resize · double-click to even out"
          onPointerDown={(e) => {
            resize.x?.(e);
            resize.y?.(e);
          }}
          onDoubleClick={resize.reset}
        />
      )}
    </div>
  );
}

export function disposeTerm(id: string): void {
  terms.get(id)?.term.dispose();
  terms.delete(id);
}

export function focusTerm(id: string): void {
  terms.get(id)?.term.focus();
}
