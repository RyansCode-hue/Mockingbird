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
const terms = new Map<string, { term: Terminal; fit: FitAddon; ready: boolean }>();

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
    if (e?.ready) e.term.write(data);
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
    selectionBackground: "#3a372f",
  },
  light: {
    background: "#fbf9f5",
    foreground: "#4f4a3f",
    cursor: "#a06a12",
    cursorAccent: "#fbf9f5",
    selectionBackground: "#e6dcc2",
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
      const e = { term, fit, ready: false };
      term.onData((d) => {
        writeSession(session.id, d);
      });
      // Shift+Enter = newline in the Claude prompt. Terminals send plain CR for
      // both Enter and Shift+Enter, so we translate to ESC+CR (what Option+Enter
      // sends), which the Claude CLI treats as "insert newline, don't submit".
      term.attachCustomKeyEventHandler((ev) => {
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
          if (buf) term.write(buf, () => (e.ready = true));
          else e.ready = true;
        })
        .catch((err: unknown) => {
          console.error("[mockingbird] scrollback replay failed", session.id, err);
          e.ready = true; // never leave the pane unable to type
        });
    }
    const { term, fit } = entry;
    if (holder.current && !term.element) term.open(holder.current);
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
    const onPaste = (e: ClipboardEvent) => {
      const items = [...(e.clipboardData?.items ?? [])];
      if (items.some((it) => it.type.startsWith("image/"))) {
        e.preventDefault();
        e.stopPropagation();
        writeSession(session.id, "\x16");
      }
    };
    const el = holder.current;
    el?.addEventListener("paste", onPaste, true);
    return () => {
      ro.disconnect();
      el?.removeEventListener("paste", onPaste, true);
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
