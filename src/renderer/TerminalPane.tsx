import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { SessionInfo, WorktreeStateInfo } from "../shared/types";

declare global {
  interface Window {
    mb: any;
  }
}

// ready=false until the scrollback replay has been written. Two things must
// not happen before then:
//  - xterm auto-answers query sequences it finds in the replayed history
//    (cursor position, DA, OSC colour). Forwarding those answers to the pty
//    types garbage into the live prompt — that is how a reload could end up
//    submitting a stray slash command like /clear.
//  - live output must not be written ahead of the history it belongs after.
//    Main appends to its buffer and sends session:data in the same handler, so
//    every chunk that arrives before the buffer reply is already inside that
//    reply: drop it rather than writing it twice, out of order.
interface TermEntry {
  term: Terminal;
  fit: FitAddon;
  ready: boolean;
  lastInput: number; // ms of the last real keystroke/paste/mouse press in this pane
  inputWired?: boolean; // DOM input listeners attached to xterm's textarea
  lastReply: string; // loop detector: the same answer repeating means the
  lastReplyCount: number; // answer itself is provoking the next question
  lastReplyStart: number;
  stripMouse: boolean; // claude panes: the CLI never gets the mouse (see below)
  carry: string; // trailing partial escape sequence held until the next chunk
  dragging: boolean; // selection drag in progress
  hold: string[] | null; // output parked while a selection stands
  holdStart: number;
  wantsMouse: boolean; // the CLI asked for mouse tracking (we stripped it)
  wheelAcc: number; // accumulated wheel pixels not yet emitted as scroll lines
}
const terms = new Map<string, TermEntry>();
(window as any).__mbTerms = terms; // diagnostics: inspect a pane's terminal from devtools

// Sequences a terminal legitimately sends on its own: answers to queries the
// program asked for (cursor position, device attributes, colours) and focus
// reporting. Everything else that xterm emits without the user touching the
// pane is suspect — that is how a session ends up running a command nobody
// typed — so it is dropped and written to ~/.mockingbird/pty-audit.log.
const TERM_REPLY = new RegExp(
  "^(?:" +
    "\\x1b\\[[0-9;?]*[Rcn]" + // cursor position / device attributes / device status
    "|\\x1b\\[[IO]" + // focus in / focus out reporting
    "|\\x1b\\][0-9]+;[^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)" + // OSC colour answers
    "|\\x1bP[^\\x1b]*\\x1b\\\\" + // DCS answers (XTGETTCAP, DECRQSS)
    ")$"
);
const USER_INPUT_WINDOW_MS = 400;
// Loop detector for automatic query answers. A program starting up asks a
// varied handful of questions (device attributes, cursor position, colours —
// including the background-colour probe the claude TUI uses to pick light or
// dark, so answers must flow even for hidden panes). A feedback loop looks
// different: the SAME answer repeating on a short period, indefinitely. Only
// that is suppressed.
const REPLY_LOOP_COUNT = 8;
const REPLY_LOOP_WINDOW_MS = 5000;

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

// xterm clears a selection the moment a write touches the selected rows, and
// the claude TUI redraws its whole frame continuously while generating — so a
// selection inside it died within a second. While a drag is in progress or a
// highlight stands, output is parked and the pane freezes at the moment of
// selection; everything parked is written the instant the selection is
// dropped, with a time/size cap so a pane can never stall.
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

const MOUSE_DISABLE_RE = /\x1b\[\?((?:\d+;)*\d+)l/g;

function stripMouseEnables(e: TermEntry, data: string): string {
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

/** The only path from the UI to a pty: silently no-ops until replay is done. */
function writeSession(id: string, data: string): void {
  if (terms.get(id)?.ready) window.mb.sessionWrite(id, data);
}

// ONE global data pump: session output reaches every cached terminal even
// while its pane is unmounted (hidden group / inactive workspace tab).
// Without this, hidden terminals miss output and look frozen on return.
let pumpWired = false;
function ensureDataPump(): void {
  if (pumpWired) return;
  pumpWired = true;
  window.mb.onSessionData((id: string, data: string) => {
    const e = terms.get(id);
    if (!e?.ready) return;
    pumpWrite(e, data);
  });
}

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
  term.reset();
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

function currentTermTheme() {
  return document.documentElement.dataset.theme === "light" ? TERM_THEMES.light : TERM_THEMES.dark;
}

/** Restyle every live terminal when the app theme flips. */
export function applyTermTheme(light: boolean): void {
  for (const { term } of terms.values()) {
    term.options.theme = light ? TERM_THEMES.light : TERM_THEMES.dark;
  }
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

/** One xterm attached to a PTY session. Terminals are cached so re-layout keeps scrollback. */
export function TerminalPane({
  session,
  focused,
  zoomed,
  density,
  paneIndex,
  onFocus,
  onClose,
  onZoom,
  onAddTab,
  onReorder,
  onResume,
  onCleanup,
  closeTitle,
  resize,
  embedded,
}: {
  session: SessionInfo;
  focused: boolean;
  zoomed: boolean;
  density: PaneDensity;
  paneIndex: number;
  onFocus: () => void;
  onClose: () => void;
  onZoom?: () => void; // omit to hide the fullscreen control (WorkTracker tab)
  onAddTab?: () => void; // "+" — start a workspace here and add a tab to it
  onReorder?: (srcId: string, targetId: string) => void;
  onResume: () => void;
  onCleanup: () => void;
  closeTitle?: string;
  resize?: PaneResize;
  embedded?: boolean; // inside a workspace pane — the wrapper owns border/radius
}) {
  const holder = useRef<HTMLDivElement>(null);
  const dead = session.status === "dead";
  const waiting = session.status === "waiting";
  const [editTitle, setEditTitle] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // git state for the instrumented rail, polled ~10s (design open question 2:
  // per visible pane, not centrally — only instrumented panes poll)
  const [git, setGit] = useState<WorktreeStateInfo | null>(null);
  useEffect(() => {
    if (density !== "max" || !session.repoPath || dead) {
      setGit(null);
      return;
    }
    let alive = true;
    const poll = () =>
      window.mb.worktreeState(session.cwd).then((r: WorktreeStateInfo | { error: string }) => {
        if (alive && r && !("error" in r)) setGit(r);
      });
    poll();
    const iv = setInterval(poll, 10000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [density, session.cwd, session.repoPath, dead]);

  useEffect(() => {
    if (dead) return; // dead panes show the resume body instead of the terminal
    ensureDataPump();
    let entry = terms.get(session.id);
    if (!entry) {
      const term = new Terminal({
        fontFamily: '"JetBrains Mono", "SF Mono", Menlo, monospace',
        fontSize: density === "max" ? 11.5 : 11,
        lineHeight: 1.4,
        theme: currentTermTheme(),
        scrollback: 8000,
        allowProposedApi: true,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      const e: TermEntry = {
        term,
        fit,
        ready: false,
        lastInput: 0,
        lastReply: "",
        lastReplyCount: 0,
        lastReplyStart: 0,
        stripMouse: !session.shell,
        carry: "",
        dragging: false,
        hold: null,
        holdStart: 0,
        wantsMouse: false,
        wheelAcc: 0,
      };
      term.onData((d) => {
        const now = Date.now();
        if (now - e.lastInput <= USER_INPUT_WINDOW_MS) return writeSession(session.id, d);
        // no user input behind this: it is either an answer to a query the
        // program asked for, or something that has no business being typed
        if (!TERM_REPLY.test(d)) {
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
      window.mb
        .sessionBuffer(session.id)
        .then((buf: string) => {
          if (terms.get(session.id) !== e) return; // disposed while in flight
          if (buf) term.write(stripMouseEnables(e, buf), () => (e.ready = true));
          else e.ready = true;
        })
        .catch((err: unknown) => {
          console.error("[mockingbird] scrollback replay failed", session.id, err);
          e.ready = true; // never leave the pane unable to type
        });
    }
    const { term, fit } = entry;
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

    // ⌘V with an image on the clipboard: forward Ctrl+V (\x16) to the CLI —
    // Claude Code reads the image from the macOS pasteboard itself and shows
    // "[Image #1]". Text pastes fall through to xterm's normal handling.
    const stamp = () => {
      const t = terms.get(session.id);
      if (t) t.lastInput = Date.now(); // mouse/paste count as user input too
    };
    const onDown = (ev: PointerEvent) => {
      stamp();
      if (ev.button === 0) {
        const t = terms.get(session.id);
        if (t) t.dragging = true;
      }
    };
    const endDrag = () => {
      const t = terms.get(session.id);
      if (!t?.dragging) return;
      t.dragging = false;
      if (!t.term.hasSelection()) return flushHold(t); // just a click — resume instantly
      // copy-on-select, cmux-style: release puts the text on the clipboard and
      // the pane resumes immediately. The highlight is never cleared by us —
      // it stays until a click elsewhere or the CLI redraws over it.
      const text = t.term.getSelection();
      if (text) {
        navigator.clipboard.writeText(text).then(
          () => {
            setCopied(true);
            if (copiedTimer.current) clearTimeout(copiedTimer.current);
            copiedTimer.current = setTimeout(() => setCopied(false), 1600);
          },
          () => {
            /* clipboard permission denied — the selection still stands for ⌘C */
          }
        );
      }
      flushHold(t);
    };
    const onPaste = (e: ClipboardEvent) => {
      stamp();
      const items = [...(e.clipboardData?.items ?? [])];
      if (items.some((it) => it.type.startsWith("image/"))) {
        e.preventDefault();
        e.stopPropagation();
        writeSession(session.id, "\x16");
      }
    };
    const el = holder.current;
    el?.addEventListener("paste", onPaste, true);
    const onWheel = (ev: WheelEvent) => {
      stamp();
      const t = terms.get(session.id);
      // the CLI asked for the mouse (we withheld it): deliver wheel as the SGR
      // reports it expects, so scrolling scrolls the transcript — xterm's
      // fallback would send arrow keys, which the CLI reads as history
      if (!t?.stripMouse || !t.wantsMouse || !t.ready) return;
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
    window.addEventListener("pointerup", endDrag, true);
    window.addEventListener("pointercancel", endDrag, true);
    return () => {
      ro.disconnect();
      el?.removeEventListener("paste", onPaste, true);
      el?.removeEventListener("pointerdown", onDown, true);
      el?.removeEventListener("wheel", onWheel, { capture: true } as EventListenerOptions);
      window.removeEventListener("pointerup", endDrag, true);
      window.removeEventListener("pointercancel", endDrag, true);
      const t = terms.get(session.id);
      if (t) {
        t.dragging = false;
        flushHold(t); // never leave a hidden pane frozen
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
  const gitStr = git ? `↑${git.ahead} ↓${git.behind} ${git.dirty ? `· ${git.dirtyFiles} dirty` : "· clean"}` : null;
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
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const src = e.dataTransfer.getData("text/mb-session");
        if (src && src !== session.id) onReorder?.(src, session.id);
      }}
    >
      <div
        className="pane-header"
        draggable={editTitle === null}
        onDragStart={(e) => {
          e.dataTransfer.setData("text/mb-session", session.id);
          e.dataTransfer.effectAllowed = "move";
        }}
        title="drag to rearrange · double-click the name to rename"
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
        {density === "max" && session.ticketId && (
          <span className={`chip ${dead ? "" : "teal"}`}>
            #{session.ticketId.replace(/^#/, "")}{dead ? "" : " · Active"}
          </span>
        )}
        {assistant && density !== "min" && <span className="chip teal">assistant</span>}
        {session.shell && density !== "min" && <span className="chip">shell</span>}
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
            <div className="cell">
              <span className="k">Git</span>
              <span className={`v ${git!.dirty ? "red" : "teal"}`}>{gitStr}</span>
            </div>
          )}
          {session.repoPath && (
            <div className="cell">
              <span className="k">Repo</span>
              <span className="v">{session.repoPath.split("/").pop()}</span>
            </div>
          )}
          {session.queuedCount ? (
            <div className="cell">
              <span className="k">Queued</span>
              <span className="v">{session.queuedCount} msg</span>
            </div>
          ) : null}
        </div>
      )}

      {dead ? (
        <div className="dead-body">
          <div>process exited · history preserved</div>
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
          {copied && <span className="copy-toast">Copied ✓</span>}
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
