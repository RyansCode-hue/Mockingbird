import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openLink } from "./uiUtil";
import { beginDrag, dragging } from "./drag";
import { CloseIcon, ExpandIcon, HandoffIcon, MinusIcon, PanelRightIcon, PinIcon, PlusIcon, RepaintIcon, ShrinkIcon, UndoIcon } from "./Icons";
import { ActionBar, tidyMenu, useContextMenu, type Action, type MenuEntry } from "./ContextMenu";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { tokenBreakdown } from "./usageFormat";
import { formatShare, formatTokens, isErr, totalTokens, AGENT_NAME, otherAgent, ticketIdOf, type AgentKind, type FileOverlap, type PrState, type PrStatus, type SessionInfo, type SessionMeter, type TokenCounts, type WorktreeStateInfo, type IpcResult } from "../shared/types";
import { mousePolicyFor, selectsNatively, stripMouseEnables, type MouseModeState } from "./mouseModes";
import { classifyTermInput, forwardTermInput, pasteRoute } from "./inputGuard";
import { agentSelection, trackPrintWidths } from "./agentWraps";
import { anchorLine, pageKey, scrollCopy, viewAnchor, wheelLines } from "./paneScroll";
import { isViewControl } from "../shared/termInput";
import { shortReason } from "../shared/phoneAlerts";
import { terminalLines } from "../shared/terminalText";
import { useFolderRefresh } from "./folderWatch";
import { anchorToContent, attachTerm, dataPump, fitTerm, followFixedSize, followPlacement, followSize, followsBottom, jumpToLatest, makeTerm, measuredCell, noteUserScroll, onFollowChange, repaintTerm, replay, syncViewport, termThemeListeners, trackUserInput, type CachedTerm, type SizedTerm } from "./cachedTerm";
import { Lookers, OwnerTag } from "./team/RoomLive";
import { TypingAsks, TypingChip, TypingRefused, Typists, typingOn } from "./team/Typing";
import { localOverlapTitle, overlapChips } from "./overlapChips";
import { BackupFreshness, TakeOverButton } from "./team/TakeOver";
import type { RoomSessionBackupView } from "../shared/team/takeover";
import { CODEX_ROOM_GUARD_SINCE, codexGuardsSecrets, isRemotePaneId } from "../shared/team/livePanes";
import { CopyToast, useCopyNote } from "./copyNote";
import { ChangeCount } from "./changeCount";
import { ago, fmtElapsed, plural } from "../shared/format";
import { baseName } from "../shared/paths";
import { settled } from "./settled";
import { StatusDot } from "./StatusDot";
import { useHandover } from "./motion";
import { LANDSCAPE_FONT, colsRows } from "../shared/landscape";
import { webglOff, webglOn } from "./termGl";

export { applyTermTheme } from "./cachedTerm";

// Replay (cachedTerm.ts) gates both directions. Live output waits until the
// history is queued, and input until xterm has parsed it: xterm auto-answers
// the query sequences it finds in the replayed history (cursor position, DA,
// OSC colour), and forwarding those answers to the pty types garbage into the
// live prompt — that is how a reload could end up submitting a stray slash
// command like /clear.
interface TermEntry extends CachedTerm, MouseModeState, SizedTerm {
  fit: FitAddon;
  /** The `createdAt` of the session process this terminal was made for: a relaunch under the same id starts a new one. */
  startedAt: number;
  /** Told when the CLI's side-panel close glyph appears or goes, while a pane shows this terminal. */
  onPanel: ((cell: { col: number; row: number } | null) => void) | null;
  /** A teammate's session: told when scrolling found no history here to move (its program is full screen), while a pane shows this terminal. */
  onFullScreen: (() => void) | null;
  lastInput: number; // ms of the last real keystroke/paste/mouse press in this pane
  inputWired?: boolean; // DOM input listeners attached to xterm's textarea
  lastReply: string; // loop detector: the same answer repeating means the
  lastReplyCount: number; // answer itself is provoking the next question
  lastReplyStart: number;
  dragging: boolean; // native (xterm) selection drag in progress
  hold: string[] | null; // output parked during a native selection drag
  holdStart: number;
  wheelAcc: number; // accumulated wheel pixels not yet emitted as scroll lines
  /** The agent CLI whose own line wrapping a copy undoes (agentWraps.ts); null in a terminal. */
  wrapAgent: AgentKind | null;
  printWidth: (line: number) => number;
  columnSelect: boolean; // the last press started a column (rectangular) selection
  /** Fit again: a teammate's session to its owner's size (it or the largest font changed), a landscape workspace to its size. */
  refit?: () => void;
  /** Lent to a landscape peek (lendTerm): it takes no keyboard, and a request for it goes here instead. */
  lent?: () => void;
}
const terms = new Map<string, TermEntry>();
(window as any).__mbTerms = terms; // diagnostics: inspect a pane's terminal from devtools
termThemeListeners.add((theme) => {
  for (const { term } of terms.values()) term.options.theme = theme;
});

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

/**
 * What copying the selection puts on the clipboard: in an agent's pane, with the agent's own line
 * wrapping undone. Copy-on-select runs this before the pane resumes its parked output, so a fault
 * in it falls back to the rows as drawn rather than leaving the pane frozen.
 */
function selectionText(e: TermEntry, id: string): string {
  if (e.wrapAgent && !e.columnSelect) {
    try {
      const joined = agentSelection(e.term, e.wrapAgent, e.printWidth);
      if (joined !== null) return joined;
    } catch (err) {
      console.error(`[mockingbird] undoing ${e.wrapAgent}'s line wrapping in pane ${id}'s selection failed; copying the rows as drawn`, err);
    }
  }
  return e.term.getSelection();
}

function flushHold(e: TermEntry): void {
  if (!e.hold) return;
  const parked = e.hold;
  e.hold = null;
  for (const c of parked) e.term.write(c);
}

function pumpWrite(e: TermEntry, data: string): void {
  // a teammate's copy redrawn from its owner's scrollback starts with a reset: keep a scrolled-up view where it was
  const keep = e.mousePolicy === "remote" && data.startsWith("\x1bc") ? viewAnchor(e.term) : null;
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
  if (!keep) return void e.term.write(chunk);
  e.term.write(chunk, () => {
    const y = anchorLine(e.term, keep);
    if (y === null) return;
    noteUserScroll(e.term); // where the viewer had put it: not a view to send back to the bottom
    e.term.scrollToLine(y);
  });
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
  if (!terms.get(id)?.ready) return;
  // a teammate's session: mouse reports and PageUp/PageDown would move its owner's view (paneScroll.ts)
  if (isRemotePaneId(id) && isViewControl(data)) return void window.mb.auditWrite(id, "dropped-remote-view-input", data);
  window.mb.sessionWrite(id, data);
}

// session output reaches every cached terminal, even while its pane is
// unmounted (hidden group / inactive workspace tab)
const ensureDataPump = dataPump((cb) => window.mb.onSessionData(cb), terms, pumpWrite);

/**
 * Repaint a glitched terminal. Replaying the byte history can't fix TUI
 * corruption (old frames were rendered at other sizes — replay reproduces the
 * garbage). Instead the CLI is asked to redraw its screen (repaintTerm); the
 * scrollback and the CLI's terminal modes stay as they are.
 */
export async function resyncTerm(id: string): Promise<void> {
  const entry = terms.get(id);
  if (!entry) return;
  // a teammate's session isn't resized from here: its owner sends the scrollback again, which redraws the pane
  if (isRemotePaneId(id)) {
    const r = await window.mb.teamPaneResync(id);
    if (isErr(r)) console.error(`[mockingbird] couldn't redraw ${id} from its owner:`, r.error);
    return;
  }
  repaintTerm(entry, (cols, rows) => window.mb.sessionResize(id, cols, rows));
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

export type PaneDensity = "min" | "std" | "max";

const fontSizeFor = (density: PaneDensity) => (density === "max" ? 11.5 : 11);

/** Window-style resize handlers on a pane's own edges; absent axes hide their handle. */
export interface PaneResize {
  x?: (e: React.PointerEvent) => void; // right edge
  y?: (e: React.PointerEvent) => void; // bottom edge
  xy?: (e: React.PointerEvent) => void; // the corner, when the pane has both edges
  reset?: () => void; // double-click a handle → even the grid back out
}

/** Shorten hook Notification messages to banner-sized reasons (phone alerts say them the same way). */
export { shortReason };

/**
 * A room session of this Mac's that teammates see but that runs without the
 * room's protections: a terminal (it can read anything), a Codex too old for
 * the room's permission profile, or a session that joined the room while
 * running.
 */
function GuardChip({ session, guards, inline, onRestart }: { session: SessionInfo; guards: { secrets: boolean; coauthors: boolean }; inline?: boolean; onRestart?: () => void }) {
  if (guards.secrets && guards.coauthors) return null;
  if (guards.secrets) {
    return (
      <span className="chip warn" title="Commits in this session won't get Co-authored-by trailers for teammates who type into it: the git hooks that add them couldn't be set up (the reason is above the session list).">
        no co-author trailers
      </span>
    );
  }
  const credit = guards.coauthors ? "" : " It started outside the room, so its commits don't credit teammates who type into it until it restarts.";
  if (session.shell) {
    return (
      <span className="chip warn" title={`Teammates in this room see this terminal, and can type into it once you let them. A terminal can read any file you can, .env files included.${credit}`}>
        shared terminal
      </span>
    );
  }
  if (session.agent === "codex" && !codexGuardsSecrets(session.agentVersion)) {
    const which = session.agentVersion ? `Codex ${session.agentVersion} is older than` : "Mockingbird couldn't read this Codex's version, so it can't tell whether it's at least";
    return (
      <span
        className="chip warn"
        title={`Teammates in this room see what this session prints, and Codex can read .env files and keys: ${which} ${CODEX_ROOM_GUARD_SINCE}, the first release whose permission profiles keep a room session from reading them. Update Codex (Settings → Agents → Update), then restart this session.${credit}`}
      >
        codex: secrets unguarded
      </span>
    );
  }
  return (
    <button
      className="chip warn"
      title={`This session joined the room while it was running, so it started without the room's rules: it can read .env files and keys, teammates see what it prints, and its commits don't credit teammates who type into it.${inline ? " It also keeps the screen it started with: if that's full screen, teammates see one screen of it and can't scroll its history." : ""} Click to restart it with them (its conversation resumes${inline ? ", inline" : ""}).`}
      onClick={(e) => {
        e.stopPropagation();
        onRestart?.();
      }}
    >
      secrets unguarded · restart
    </button>
  );
}

/** True until `ms` after the last flash. */
function useFlash(ms: number): [boolean, () => void] {
  const [on, setOn] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );
  const flash = useCallback(() => {
    setOn(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOn(false), ms);
  }, [ms]);
  return [on, flash];
}

/** Distinct files across a pane's overlaps. */
const overlapCount = (list: FileOverlap[]) => new Set(list.flatMap((o) => o.files)).size;

const PR_LABEL: Record<PrState["state"], string> = { draft: "draft", open: "open", approved: "approved", changes: "changes requested", merged: "merged", closed: "closed" };

/** A pane's folder's git state (its header's change count and its rail's Git), read again when the folder changes; panes in one folder share one read in main. */
export function usePaneGit(session: SessionInfo, on: boolean) {
  const [gitState, setGit] = useState<WorktreeStateInfo | { error: string } | null>(null);
  const dead = session.status === "dead";
  const remote = session.room?.remote ? session.room : null;
  const gitRoot = on && session.repoPath && !dead ? session.cwd : null;
  const gitSeq = useRef(0);
  const readGit = () => {
    const n = ++gitSeq.current;
    if (!gitRoot) return setGit(null);
    settled<IpcResult<WorktreeStateInfo>>(window.mb.worktreeState(gitRoot), "Couldn't read git").then((r) => n === gitSeq.current && setGit(r ?? { error: "no answer" }));
  };
  useEffect(readGit, [gitRoot]);
  useFolderRefresh(gitRoot, readGit, 30_000);
  // a teammate's session shows its owner's git state, as they last published it
  const git: WorktreeStateInfo | null = remote ? (remote.git && !dead ? { ...remote.git, dirty: remote.git.dirtyFiles > 0 } : null) : gitState && !isErr(gitState) ? gitState : null;
  const gitErr = gitState && isErr(gitState) ? gitState.error : null;
  return { git, gitErr, gitRoot };
}

/** The pull request of the branch checked out at `root` (main caches lookups for 2 minutes), read again every 3 minutes while shown; `readPr(true)` asks afresh. */
export function usePanePr(root: string | null, branch: string | null | undefined) {
  const [pr, setPr] = useState<PrStatus | null>(null);
  const prSeq = useRef(0);
  const readPr = (fresh = false) => {
    const n = ++prSeq.current;
    if (!root) return setPr(null);
    const failed = (error: string): PrStatus => ({ branch: null, pr: null, error, at: Date.now() });
    window.mb.prStatus(root, fresh).then(
      (r: PrStatus | { error: string }) => n === prSeq.current && setPr(isErr(r) && !("at" in r) ? failed(r.error) : (r as PrStatus)),
      (err: unknown) => n === prSeq.current && setPr(failed(String(err)))
    );
  };
  useEffect(() => {
    readPr();
    if (!root) return;
    const t = setInterval(() => !document.hidden && readPr(), 180_000);
    return () => clearInterval(t);
  }, [root, branch]);
  return { pr, readPr };
}

/** What a pane's header chips say, and what pressing them opens (TerminalPane's header, and a landscape workspace's). */
export interface PaneChipProps {
  session: SessionInfo;
  density: PaneDensity;
  git: WorktreeStateInfo | null;
  gitErr: string | null;
  overlaps?: FileOverlap[];
  runCount?: number;
  onOpenRun?: () => void;
  onOpenChanges?: () => void;
  onJump?: (sessionId: string) => void;
  onOpenBoard?: (roomId: string) => void;
  backup?: RoomSessionBackupView | null;
  onTakeOver?: (view: RoomSessionBackupView) => void;
  /** The context warning (ContextWarning.tsx), first: a narrow header cuts the other chips before it. */
  contextChip?: React.ReactNode;
  pinNote?: string;
  onRestart?: () => void;
}

/**
 * A pane's chips: the context warning, whose session it is and who's looking or typing, its backup and Take over,
 * its branch, ▶ runs (opens Run), Δ changes (opens Source Control), overlaps (the other worktree, or the room's
 * Board), model and effort, ticket, kind, muted and the guard chip.
 */
export function PaneChips({ session, density, git, gitErr, overlaps, runCount, onOpenRun, onOpenChanges, onJump, onOpenBoard, backup, onTakeOver, contextChip, pinNote, onRestart }: PaneChipProps) {
  const chips = useMemo(() => overlapChips(overlaps), [overlaps]);
  const dead = session.status === "dead";
  const room = session.room ?? null;
  const remote = room?.remote ? room : null;
  const assistant = session.kind === "assistant" && !session.shell;
  return (
    <>
      {contextChip}
      {room && <OwnerTag room={room} />}
      {room && <Lookers room={room} />}
      {room && <Typists session={session} room={room} />}
      {room && <TypingChip session={session} room={room} />}
      {backup && density !== "min" && <BackupFreshness view={backup} />}
      {backup && remote && onTakeOver && <TakeOverButton view={backup} onOpen={onTakeOver} />}
      {density !== "min" && session.branch && <span className="chip">{session.branch}</span>}
      {!!runCount && density !== "min" && (
        <button
          className="chip running"
          title={`${plural(runCount, "service")} of this worktree running — open Run and Debug`}
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
          title={`${plural(git.dirtyFiles, "uncommitted file")}: +${git.insertions} −${git.deletions} lines in tracked files${remote ? ` on ${remote.ownerName}'s laptop` : " — open Source Control"}`}
          onClick={(e) => {
            e.stopPropagation();
            if (!remote) onOpenChanges?.();
          }}
        >
          <ChangeCount files={git.dirtyFiles} insertions={git.insertions} deletions={git.deletions} />
        </button>
      )}
      {gitErr && density !== "min" && (
        <span className="chip" title={`Couldn't read this folder's git state: ${gitErr}`}>
          git: couldn't read
        </span>
      )}
      {chips.local.length > 0 && density !== "min" && (
        <button
          className="chip overlap"
          title={localOverlapTitle(chips.local)}
          onClick={(e) => {
            e.stopPropagation();
            onJump?.(chips.local[0].other);
          }}
        >
          ⚠ {overlapCount(chips.local)} overlap
        </button>
      )}
      {/* team rooms: a teammate's pushed branch changes the same files — the room's House board shows who has which ticket */}
      {density !== "min" &&
        chips.teammates.map((c) => (
          <button
            key={c.key}
            className="chip overlap"
            title={c.title}
            onClick={(e) => {
              e.stopPropagation();
              onOpenBoard?.(c.roomId);
            }}
          >
            ⚠ {c.label}
          </button>
        ))}
      {density === "max" && (session.model || session.effort) && (
        <span className="chip" title="model · effort for this session">
          {[session.model, session.effort].filter(Boolean).join(" · ")}
        </span>
      )}
      {density === "max" && session.ticketId && (
        <span className={`chip ${dead ? "" : "teal"}`}>
          #{ticketIdOf(session.ticketId)}{dead ? "" : " · Active"}
        </span>
      )}
      {assistant && density !== "min" && <span className="chip teal">assistant</span>}
      {session.shell && density !== "min" && <span className="chip">shell</span>}
      {session.agent === "codex" && density !== "min" && <span className="chip">codex</span>}
      {pinNote && density !== "min" && <span className="chip" title="Pinned here from another group">{pinNote}</span>}
      {session.muted && density !== "min" && <span className="chip" title="This session's notifications are muted (unmute from its sidebar row, its ⋯ or ⌘K)">muted</span>}
      {room && !remote && !room.takenOver && !dead && density !== "min" && <GuardChip session={session} guards={room.guards} inline={room.inlineOnStart} onRestart={onRestart} />}
    </>
  );
}

/** What a pane's rail shows beyond its git state: messages and their log, usage, and what its cells open. */
export interface PaneRailProps {
  session: SessionInfo;
  git: WorktreeStateInfo | null;
  gitErr: string | null;
  pr: PrStatus | null;
  readPr: (fresh?: boolean) => void;
  messages?: { in: number; out: number };
  onShowMessages?: () => void;
  meter?: SessionMeter;
  onOpenChanges?: () => void;
  onOpenFiles?: () => void;
  className?: string;
}

/** A pane's rail (design 1b): elapsed, git, its PR, messages, repo, folder (opens Files), queued messages and tokens. */
export function PaneRail({ session, git, gitErr, pr, readPr, messages, onShowMessages, meter, onOpenChanges, onOpenFiles, className = "rail" }: PaneRailProps) {
  const remote = session.room?.remote ? session.room : null;
  const gitStr = git ? `${git.upstream ? `↑${git.ahead} ↓${git.behind}` : "not on origin"} · ${git.dirty ? `${git.dirtyFiles} uncommitted` : "clean"}` : null;
  const gitTitle = git
    ? [
        git.upstream
          ? `Compared with ${git.upstream} as of the last fetch: ↑ ${plural(git.ahead, "commit")} here it doesn't have (to push), ↓ ${plural(git.behind, "commit")} there this branch doesn't have (to pull).`
          : "This branch doesn't track a remote branch yet.",
        git.dirty ? `${plural(git.dirtyFiles, "file")} with uncommitted changes (edited or new).` : "No uncommitted changes.",
        "Click for Source Control — Pull, Push, the graph.",
      ].join("\n")
    : "";
  return (
    <div className={className}>
      <div className="cell">
        <span className="k">Elapsed</span>
        <span className="v">{fmtElapsed(session.createdAt, true)}</span>
      </div>
      {gitStr && (
        <div className={`cell ${onOpenChanges && !remote ? "click" : ""}`} title={remote ? `On ${remote.ownerName}'s laptop, as they last published it.\n${gitTitle}` : gitTitle} onClick={remote ? undefined : onOpenChanges}>
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
          onClick={() => (pr.pr ? openLink(pr.pr.url) : readPr(true))}
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
          <span className="v">{baseName(session.repoPath)}</span>
        </div>
      )}
      {remote ? (
        <div className="cell" title={`${remote.ownerName}'s session: it runs on their laptop, in their clone${remote.repo ? ` of ${remote.repo}` : ""}`}>
          <span className="k">Runs on</span>
          <span className="v">
            {remote.ownerName}'s Mockingbird{remote.repoName ? ` · ${remote.repoName}` : ""}
          </span>
        </div>
      ) : (
        <div className="cell folder" title={session.cwd}>
          <span className="k">Folder</span>
          <span className="v">
            <span className="fn">{baseName(session.cwd)}</span>
            {onOpenFiles && (
              <button className="mini" title={`Browse ${session.cwd} — files, viewer, diffs (⌘B)`} onClick={onOpenFiles}>
                Files
              </button>
            )}
          </span>
        </div>
      )}
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
  );
}

/** Where the agent CLI's diff side panel shows its close glyph in this session's terminal, or null when it isn't open. */
export function agentPanelOf(id: string): { col: number; row: number } | null {
  const t = terms.get(id);
  return t?.wantsMouse ? findPanelClose(t.term) : null;
}

/** Close the agent CLI's diff side panel, as its × would; false when it isn't open. */
export function hideAgentPanel(id: string): boolean {
  const at = agentPanelOf(id);
  if (at) clickCell(id, at);
  return !!at;
}

/**
 * A session's cached terminal, made the first time it's asked for (its saved output replayed, and from then on
 * fed by the data pump whether or not a pane shows it) and made again when the session was relaunched under its
 * id. Opened only when a pane attaches it, so a landscape card can read a terminal nothing shows.
 */
function termFor(session: SessionInfo, fontSize: number): TermEntry {
  ensureDataPump();
  let entry = terms.get(session.id);
  const remoteEntry = isRemotePaneId(session.id);
  // relaunched in place (Restore all, a dead pane's Relaunch): the cached terminal holds the old
  // process's screen and modes, and fits only when its own size changes, so the new pty would keep
  // the size it started at. A teammate's copy is redrawn from its owner's scrollback instead.
  if (entry && !remoteEntry && entry.startedAt !== session.createdAt) {
    disposeTerm(session.id);
    entry = undefined;
  }
  if (!entry) {
    // a session id keeps its agent and shell flag through restarts, and a
    // resumed pane gets a fresh entry, so the policy is fixed per entry
    const mousePolicy = mousePolicyFor(session, remoteEntry);
    // a teammate's session prints for its owner's terminal, from its first byte: parsed at another width, its
    // redraws land in the wrong cells for good (followOwners keeps it there)
    const owner = remoteEntry && session.room ? { cols: session.room.cols, rows: session.room.rows } : {};
    const { term, fit } = makeTerm({
      fontSize,
      ...owner,
      lineHeight: 1.4,
      scrollback: 8000,
      allowProposedApi: true,
      // Option-drag selects natively while Claude has the mouse. Option-click
      // must not also move the prompt cursor: a short native gesture would
      // otherwise type arrow keys into the prompt.
      ...(mousePolicy === "claude" ? { macOptionClickForcesSelection: true, altClickMovesCursor: false } : {}),
    });
    // an agent's inline frame leaves blank rows below it (bottomLine); a shell's cleared screen keeps its prompt at the top
    if (!session.shell) anchorToContent(term);
    const e: TermEntry = {
      term,
      fit,
      startedAt: session.createdAt,
      replayed: false,
      ready: false,
      onPanel: null,
      onFullScreen: null,
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
      wrapAgent: session.shell ? null : (session.agent ?? "claude"),
      printWidth: trackPrintWidths(term),
      columnSelect: false,
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
      const action = forwardTermInput(source, remoteEntry);
      if (action === "send" && source !== "reply") return writeSession(session.id, d);
      // no user input behind this: it is either an answer to a query the
      // program asked for, or something that has no business being typed
      if (action === "audit") {
        window.mb.auditWrite(session.id, "dropped-unattributed", d);
        return;
      }
      if (action === "drop") return;
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
      // a teammate's session: PageUp/PageDown page this copy, never the owner's view
      const page = remoteEntry ? pageKey(ev) : 0;
      if (page) {
        ev.preventDefault();
        if (ev.type !== "keydown") return false;
        noteUserScroll(term);
        if (scrollCopy(term, page * Math.max(1, term.rows - 1)) === "full-screen") e.onFullScreen?.();
        return false;
      }
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
    terms.set(session.id, e);
    void replay(e, window.mb.sessionBuffer(session.id), () => terms.get(session.id) === e, (buf) => stripMouseEnables(e, buf));
  }
  return entry;
}

/** One xterm attached to a PTY session. Terminals are cached so re-layout keeps scrollback. */
export function TerminalPane({
  session,
  focused,
  zoomed,
  density,
  paneIndex,
  area,
  onFocus,
  onClose,
  onOpenFiles,
  onOpenChanges,
  runCount,
  onOpenRun,
  meter,
  onZoom,
  cell,
  onAddTab,
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
  onOpenBoard,
  backup,
  onTakeOver,
  tookOverAt,
  leftCopy,
  teamNotice,
  contextChip,
  onRestart,
  messages,
  onShowMessages,
  menuExtras,
  landscape,
}: {
  session: SessionInfo;
  focused: boolean;
  zoomed: boolean;
  density: PaneDensity;
  paneIndex: number;
  /** Its place in the grid ("row-start/col-start/row-end/col-end"). */
  area?: string;
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
  /** The grid cell this pane is (a pane of its own, not a workspace tab): grid animations find it by this. */
  cell?: string;
  onAddTab?: () => void; // "+" — start a workspace here and add a tab to it
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
  /** A session dropped on the header joins this pane as a tab (the grid handles drops on the body). */
  tabDrop?: { over: (e: React.DragEvent) => void; drop: (e: React.DragEvent) => void; cue?: string };
  /** Continue this session's task in the other agent. */
  onHandoff?: () => void;
  /** Put the files back as they were before one of the agent's turns. */
  onUndoTurn?: () => void;
  /** Files another worktree of this repository has also changed. */
  overlaps?: FileOverlap[];
  onJump?: (sessionId: string) => void;
  /** Open a team room's House board (a teammate's branch overlaps this worktree). */
  onOpenBoard?: (roomId: string) => void;
  /** A room session's backup (team rooms), and taking a teammate's over. */
  backup?: RoomSessionBackupView | null;
  onTakeOver?: (view: RoomSessionBackupView) => void;
  /** When this Mac took this session over from a teammate (it continues one of theirs), if it did. */
  tookOverAt?: number | null;
  /** A teammate continues this session (team rooms): what its stopped copy shows instead of the dead pane's Resume. */
  leftCopy?: React.ReactNode;
  /** A line over the terminal from team rooms (changes a teammate sent, to review). */
  teamNotice?: React.ReactNode;
  /** The pane's context warning (ContextWarning.tsx): a chip in the header. */
  contextChip?: React.ReactNode;
  /** Restart this pane, resuming its conversation (for a stuck one). */
  onRestart?: () => void;
  /** Agent messages this pane received and sent, and opening their log. */
  messages?: { in: number; out: number };
  onShowMessages?: () => void;
  /** The session's own actions (rename, notifications, move, close…), after the pane's in its header's right-click menu. */
  menuExtras?: MenuEntry[];
  /**
   * The terminal of a landscape workspace (WorkspaceNode), which draws the header: no header or rail here. The
   * workspace is `w` × `h` at 100%, and its terminal as many cells of the measured cell at `font` as that holds
   * (colsRows); the pty is told only when that changes, never by fitting the holder. A teammate's session keeps
   * its owner's size instead, scaled to fit at up to `font`. In focus, filling the window, `home` is the
   * workspace's own size: the terminal goes back to it when it leaves the window.
   */
  landscape?: { w: number; h: number; font: number; home?: { w: number; h: number } };
}) {
  const holder = useRef<HTMLDivElement>(null);
  const dead = session.status === "dead";
  const waiting = session.status === "waiting";
  // team rooms: a teammate's session runs on their Mockingbird; this pane is its copy, at its owner's size
  const room = session.room ?? null;
  const remote = room?.remote ? room : null;
  // a session that just changed hands — handed over to a teammate, or taken over here — marks its pane once
  const paneEl = useRef<HTMLDivElement>(null);
  useHandover(paneEl, room?.takenOver?.at ?? tookOverAt);
  const ownerSize = useRef({ cols: room?.cols ?? 120, rows: room?.rows ?? 32 });
  ownerSize.current = { cols: room?.cols ?? 120, rows: room?.rows ?? 32 };
  const densityNow = useRef(density);
  densityNow.current = density;
  const landscapeNow = useRef(landscape);
  landscapeNow.current = landscape;
  const [editTitle, setEditTitle] = useState<string | null>(null);
  const [copyNote, copy] = useCopyNote();
  const [fullScreenNote, flashFullScreen] = useFlash(2500);
  // the user scrolled this pane's terminal up: it stays there, and Jump to latest brings it back to its output
  const [scrolledUp, setScrolledUp] = useState(false);
  const [panelClose, setPanelClose] = useState<{ col: number; row: number } | null>(null);
  const [exitTail, setExitTail] = useState<string | null>(null);
  useEffect(() => {
    if (!dead || remote) {
      setExitTail(null);
      return;
    }
    let alive = true;
    window.mb.sessionBuffer(session.id).then((buf: string) => {
      if (!alive) return;
      const text = terminalLines(buf || "").filter((l) => l.trim().length > 0);
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

  // git state for the header's change count and the rail; a landscape workspace reads its own (WorkspaceNode)
  const { git, gitErr, gitRoot } = usePaneGit(session, density !== "min" && !landscape);
  // the branch's pull request, for the rail
  const { pr, readPr } = usePanePr(density === "max" ? gitRoot : null, git?.branch);

  useEffect(() => {
    if (dead) return; // dead panes show the resume body instead of the terminal
    const entry = termFor(session, fontSizeFor(density));
    const remoteEntry = isRemotePaneId(session.id);
    const { term } = entry;
    // the header's "hide diff" button follows the panel for whichever pane shows this terminal now
    const onPanel = (found: { col: number; row: number } | null) =>
      setPanelClose((prev) => (prev?.col === found?.col && prev?.row === found?.row ? prev : found));
    entry.onPanel = onPanel;
    entry.onFullScreen = flashFullScreen;
    onPanel(entry.wantsMouse ? findPanelClose(term) : null);
    attachTerm(term, holder.current);
    trackUserInput(entry);
    setScrolledUp(!followsBottom(term));
    const stopFollowNote = onFollowChange(term, (atBottom) => setScrolledUp(!atBottom));
    let stopFollowing: () => void;
    const sized = entry;
    if (remoteEntry) {
      const fixed = followFixedSize(entry, holder.current, () => ownerSize.current, () => landscapeNow.current?.font ?? fontSizeFor(densityNow.current));
      entry.refit = fixed.refit;
      stopFollowing = () => {
        fixed.stop();
        // unattached, followOwners keeps it at its owner's size
        if (sized.refit === fixed.refit) sized.refit = undefined;
      };
    } else if (landscapeNow.current) {
      // the terminal is cached across the grid and the landscape, each with its own font
      if (term.options.fontSize !== landscapeNow.current.font) term.options.fontSize = landscapeNow.current.font;
      const placed = followPlacement(
        entry,
        (cell) => {
          const l = landscapeNow.current ?? { w: 0, h: 0, font: 0 };
          if (l.font === LANDSCAPE_FONT) landscapeCell = cell;
          return colsRows(l.w, l.h, cell.w, cell.h);
        },
        (cols, rows) => window.mb.sessionResize(session.id, cols, rows),
        (cell) => {
          const h = landscapeNow.current?.home;
          return h && terms.get(session.id) === sized ? colsRows(h.w, h.h, cell.w, cell.h) : null;
        }
      );
      entry.refit = placed.refit;
      stopFollowing = () => {
        placed.stop();
        if (sized.refit === placed.refit) sized.refit = undefined;
      };
    } else {
      if (term.options.fontSize !== fontSizeFor(densityNow.current)) term.options.fontSize = fontSizeFor(densityNow.current);
      stopFollowing = followSize(entry, holder.current, (cols, rows) => window.mb.sessionResize(session.id, cols, rows));
    }
    // a landscape workspace's terminal draws with WebGL while it's attached (termGl.ts); the grid's keep the DOM renderer
    const gl = !!landscapeNow.current;
    if (gl) webglOn(term, session.id);

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
      // xterm's own test for a column selection
      t.columnSelect = ev.altKey && !(IS_MAC && !!t.term.options.macOptionClickForcesSelection);
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
      const text = selectionText(t, session.id);
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
    // ⌘C (Edit ▸ Copy) copies what copy-on-select did, rather than xterm's rows as drawn
    const onCopy = (ev: ClipboardEvent) => {
      const t = terms.get(session.id);
      if (!t?.wrapAgent || !t.term.hasSelection() || !ev.clipboardData || !t.term.element?.contains(ev.target as Node)) return;
      ev.clipboardData.setData("text/plain", selectionText(t, session.id));
      ev.preventDefault();
      ev.stopPropagation();
    };
    const el = holder.current;
    el?.addEventListener("paste", onPaste, true);
    el?.addEventListener("copy", onCopy, true);
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
      if (remoteEntry) {
        // a teammate's session: xterm never sees the wheel (paneScroll.ts), so it scrolls this copy and nothing reaches the owner
        ev.stopPropagation();
        const t = terms.get(session.id);
        const screen = t?.term.element?.querySelector(".xterm-screen");
        if (!t || !screen) return;
        const r = screen.getBoundingClientRect();
        const lines = wheelLines(t, ev, r.height / t.term.rows, r.height);
        noteUserScroll(t.term);
        // full screen: no default kept, so a holder the owner's size overflows still scrolls
        if (scrollCopy(t.term, lines) === "full-screen") return void t.onFullScreen?.();
        ev.preventDefault();
        return;
      }
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
      // trackpads stream dozens of tiny pixel deltas per second — emitting a
      // report per event scrolls wildly fast. Accumulate to whole lines (cell
      // heights), the same conversion xterm applies to its own native mouse handling.
      const lines = wheelLines(t, ev, r.height / t.term.rows, r.height);
      if (!lines) return; // not a full line yet — swallowed, never arrow-key fallback
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
      stopFollowing();
      stopFollowNote();
      if (gl) webglOff(term, session.id);
      el?.removeEventListener("paste", onPaste, true);
      el?.removeEventListener("copy", onCopy, true);
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
        if (t.onFullScreen === flashFullScreen) t.onFullScreen = null;
      }
    };
  }, [session.id, dead, session.createdAt]);

  // a teammate's session follows its owner's terminal size, its font fitting it to the pane; a landscape
  // workspace's terminal follows the workspace's size
  useEffect(() => {
    const entry = terms.get(session.id);
    if (!entry || (!remote && !landscape)) return;
    if (landscape && !remote && entry.term.options.fontSize !== landscape.font) entry.term.options.fontSize = landscape.font;
    entry.refit?.();
  }, [remote?.cols, remote?.rows, density, session.id, landscape?.w, landscape?.h, landscape?.font]);

  // terminal body steps up in the instrumented tier (design 1b); a landscape workspace's font stays as it is
  useEffect(() => {
    const entry = terms.get(session.id);
    if (!entry || remote || landscapeNow.current || entry.term.options.fontSize === fontSizeFor(density)) return;
    entry.term.options.fontSize = fontSizeFor(density);
    fitTerm(entry, (cols, rows) => window.mb.sessionResize(session.id, cols, rows));
    syncViewport(entry.term);
  }, [density, session.id]);

  const assistant = session.kind === "assistant" && !session.shell; // repo-less shells aren't assistants
  const shortcut = paneIndex < 9 ? `⌘${paneIndex + 1}` : "";
  const meta = fmtElapsed(session.createdAt);

  // the header's labelled controls, and its right-click menu: the same actions, then the session's own
  const headerMenu = useContextMenu(session.ticketTitle ?? session.title);
  const controls = tidyMenu([
    !dead && { key: "repaint", label: "Repaint", icon: <RepaintIcon />, title: "Repaint — have the session redraw its screen (its scrollback stays)", onPick: () => resyncTerm(session.id) },
    !!panelClose && !dead && { key: "diff", label: "Hide diff", menuLabel: "Hide the diff panel", icon: <PanelRightIcon open />, title: "Hide the CLI's diff side panel (same as its × or /diff)", onPick: () => panelClose && clickCell(session.id, panelClose) },
    !!onAddTab && !dead && !remote && { key: "tab", label: "Tab", menuLabel: "New tab…", icon: <PlusIcon />, title: "New tab — turn this pane into a workspace and open another session in it", onPick: () => onAddTab?.() },
    !!onUndoTurn && { key: "undo", label: "Undo", menuLabel: "Undo a turn…", icon: <UndoIcon />, title: "Undo a turn — put the files back as they were before one of the agent's recent turns", onPick: () => onUndoTurn?.() },
    !!onHandoff && !remote && {
      key: "handoff",
      label: AGENT_NAME[otherAgent(session.agent)],
      menuLabel: `Continue in ${AGENT_NAME[otherAgent(session.agent)]}…`,
      icon: <HandoffIcon />,
      title: `Continue in ${AGENT_NAME[otherAgent(session.agent)]} — hand this task over with a summary of what's done and what's next`,
      onPick: () => onHandoff?.(),
    },
    !!onPin && {
      key: "pin",
      label: pinned ? "Pinned" : "Pin",
      menuLabel: pinned ? "Unpin" : "Pin to the screen",
      icon: <PinIcon />,
      pressed: !!pinned,
      title: pinned ? "Unpin — this pane goes back to following its group" : "Pin — keep this pane on screen when you switch groups",
      onPick: () => onPin?.(),
    },
    !!onZoom &&
      (zoomed
        ? { key: "zoom", label: "Grid", menuLabel: "Back to the grid", icon: <ShrinkIcon />, title: "Back to the grid (⌘E or esc)", onPick: () => onZoom?.() }
        : { key: "zoom", label: "Full", menuLabel: "Fullscreen", icon: <ExpandIcon />, title: "Fullscreen — fill the whole grid with this pane (⌘E)", onPick: () => onZoom?.() }),
    closeTitle
      ? { key: "close", label: "Close", icon: <CloseIcon />, title: closeTitle, onPick: onClose }
      : { key: "close", label: "Hide", menuLabel: "Hide from the grid", icon: <MinusIcon />, title: "Hide from grid (session keeps running)", onPick: onClose },
  ]) as Action[];

  return (
    <div
      ref={paneEl}
      className={[
        "pane",
        `density-${density}`,
        embedded ? "embedded" : "",
        landscape ? "ls-body" : "",
        focused ? "focused" : "",
        waiting ? "st-waiting" : "",
        dead ? "st-dead" : "",
        assistant ? "kind-assistant" : "",
        typingOn(room) ? "typing-on" : "",
      ].join(" ")}
      style={area ? { gridArea: area } : undefined}
      data-cell={cell}
      onMouseDown={onFocus}
    >
      {!landscape && (
      <div
        className="pane-header"
        draggable={editTitle === null}
        onDragStart={(e) => beginDrag(e, "text/mb-session", session.id, `Moving ${session.ticketTitle ?? session.title}`, "pane")}
        title="drag onto another pane's edge to put it beside that pane, onto its middle to swap, or onto its header to make it a tab there · double-click the name to rename · right-click for more"
        data-drop={tabDrop?.cue}
        {...headerMenu.bind(() => tidyMenu([...controls, "-", ...(menuExtras ?? [])]))}
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
        <StatusDot status={session.status} className={density === "max" ? "lg" : ""} />
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
            title={remote ? `${remote.ownerName}'s session` : "double-click to rename"}
            onDoubleClick={(e) => {
              e.stopPropagation();
              if (!remote) setEditTitle(session.ticketTitle ?? session.title);
            }}
          >
            {session.ticketTitle ?? session.title}
          </span>
        )}
        {/* the context warning sits by the title: a narrow pane cuts its other chips first */}
        <PaneChips
          session={session}
          density={density}
          git={git}
          gitErr={density === "std" ? gitErr : null}
          overlaps={overlaps}
          runCount={runCount}
          onOpenRun={onOpenRun}
          onOpenChanges={onOpenChanges}
          onJump={onJump}
          onOpenBoard={onOpenBoard}
          backup={backup}
          onTakeOver={onTakeOver}
          contextChip={contextChip}
          pinNote={pinNote}
          onRestart={onRestart}
        />
        <span className="meta">{density === "min" ? shortcut : meta}</span>
        <ActionBar className="controls" actions={controls} />
        {headerMenu.menu}
      </div>
      )}

      {density === "max" && !dead && !landscape && (
        <PaneRail session={session} git={git} gitErr={gitErr} pr={pr} readPr={readPr} messages={messages} onShowMessages={onShowMessages} meter={meter} onOpenChanges={onOpenChanges} onOpenFiles={onOpenFiles} />
      )}

      {dead && remote ? (
        <div className="dead-body">
          <div>
            {remote.ownerName} closed this session{remote.online ? "" : ", and their Mockingbird is offline"} · they can resume it
          </div>
        </div>
      ) : dead && leftCopy ? (
        <div className="dead-body">{leftCopy}</div>
      ) : dead ? (
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
        <div className="term-area">
          <div
            className={`term-holder ${remote ? "fixed" : ""}`}
            ref={holder}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes("Files")) e.preventDefault();
            }}
            onDrop={(e) => {
              // drop files (screenshots etc.) onto a pane → their paths go into the prompt
              if (!e.dataTransfer.files.length) return;
              e.preventDefault();
              e.stopPropagation();
              if (remote) return; // this Mac's paths mean nothing on the teammate's
              const paths = [...e.dataTransfer.files]
                .map((f) => window.mb.getFilePath(f))
                .filter((p): p is string => !!p);
              if (paths.length) {
                writeSession(session.id, paths.map((p) => `"${p}"`).join(" "));
              }
            }}
          />
          <CopyToast note={copyNote} failed="Couldn't copy selection" />
          {remote && fullScreenNote && <span className="scroll-toast">{remote.ownerName}'s session is full screen: only they can scroll it</span>}
          {scrolledUp && !(remote && fullScreenNote) && (
            <button
              className="scroll-toast jump"
              title="Back to the newest output; the pane follows it again"
              onClick={() => {
                const t = terms.get(session.id)?.term;
                if (!t) return;
                jumpToLatest(t);
                t.focus();
              }}
            >
              ↓ Jump to latest
            </button>
          )}
          <div className="pane-notes">
            {room && <TypingAsks session={session} room={room} />}
            {room && <TypingRefused session={session} room={room} />}
            {room?.takenOver && !remote && (
              <div className="team-pane-note" data-handover title="A teammate continued this session on their laptop. This copy has left the room: teammates no longer see it or type into it, and it's no longer backed up.">
                Continued on {room.takenOver.byName}'s laptop {ago(room.takenOver.at)} — this copy is stopping; its files stay as they are
              </div>
            )}
            {teamNotice}
            {session.phoneNote && !remote && (
              <div className="team-pane-note phone-note" title="A reply to a phone alert (Settings → Notifications → Phone alerts). Each one is in Settings → Team → Recent remote activity.">
                <span className="reason">
                  {session.phoneNote.text} · {ago(session.phoneNote.at)}
                </span>
                <button
                  className="icon"
                  aria-label="Dismiss"
                  onClick={(e) => {
                    e.stopPropagation();
                    void settled(window.mb.clearPhoneNote(session.id)).then((r) => isErr(r) && console.error("[mockingbird] couldn't dismiss the phone note:", r.error));
                  }}
                >
                  ✕
                </button>
              </div>
            )}
            {remote && (!remote.online || remote.problem) && (
              <div className="team-pane-note" title={remote.problem ?? undefined}>
                {!remote.online ? `${remote.ownerName}'s Mockingbird is offline — this is what it last sent` : remote.problem}
              </div>
            )}
            {session.stalledSince && session.status === "working" && (
              <div
                className="stall-banner"
                title={
                  session.hooksSilent
                    ? "Mockingbird learns a session's status from its agent's hooks, and none has reported since this pane started. Check the hooks in Settings; Mark idle if the agent is at its prompt (queued messages are then delivered)."
                    : "An agent's screen keeps changing while it works; this one hasn't for a while. Repaint redraws it; Restart stops it and resumes the conversation in a fresh process."
                }
              >
                <span className="reason">
                  {session.hooksSilent
                    ? `No status from its agent's hooks since it started, and no output for ${fmtElapsed(session.stalledSince, true)} — "working" may be wrong`
                    : `No output for ${fmtElapsed(session.stalledSince, true)} while working — it may be stuck`}
                </span>
                {session.hooksSilent && !remote && (
                  <button
                    className="outline"
                    onClick={(e) => {
                      e.stopPropagation();
                      window.mb.clearWaiting(session.id);
                    }}
                  >
                    Mark idle
                  </button>
                )}
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
                {!remote && (
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
                )}
              </div>
            )}
          </div>
        </div>
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
          onPointerDown={(e) => (resize.xy ?? resize.x ?? resize.y)?.(e)}
          onDoubleClick={resize.reset}
        />
      )}
    </div>
  );
}

export function disposeTerm(id: string): void {
  const e = terms.get(id);
  if (e) webglOff(e.term, id);
  e?.term.dispose();
  terms.delete(id);
}

/**
 * Keep each teammate's cached terminal at its owner's size, whatever shows it: a pane follows it itself (its
 * refit), and a card, a peek or nothing at all is resized here. Their output is drawn for that size; parsed at
 * another, its cursor-relative redraws stay mangled in the buffer. Their pty is never resized from here.
 */
export function followOwners(sessions: readonly SessionInfo[]): void {
  for (const s of sessions) {
    const room = s.room?.remote ? s.room : null;
    const e = room ? terms.get(s.id) : undefined;
    if (!room || !e || e.refit || (e.term.cols === room.cols && e.term.rows === room.rows)) continue;
    e.term.resize(room.cols, room.rows);
  }
}

type Cell = { w: number; h: number };
/** The cell landscape terminals measure at LANDSCAPE_FONT: by the first one attached, or by landscapeCellReady's probe. */
let landscapeCell: Cell | null = null;
let cellProbe: Promise<Cell | null> | null = null;
(window as { __mbLandscapeCell?: () => Cell | null }).__mbLandscapeCell = () => landscapeCell; // the UI preview's checks

/**
 * The cell for sizing the pty of a workspace nothing has attached yet. Before any landscape terminal has been
 * attached it's measured in one opened off screen for the purpose, at the same font, once the fonts are in: a
 * guess would cost the pty a resize when its terminal is attached and measures the real one.
 */
function landscapeCellReady(): Promise<Cell | null> {
  if (landscapeCell) return Promise.resolve(landscapeCell);
  cellProbe ??= (document.fonts?.ready ?? Promise.resolve()).then(() => {
    if (landscapeCell) return landscapeCell;
    const host = document.createElement("div");
    host.style.cssText = "position: fixed; left: -10000px; top: 0; width: 400px; height: 200px; visibility: hidden; pointer-events: none";
    document.body.appendChild(host);
    const { term } = makeTerm({ fontSize: LANDSCAPE_FONT, lineHeight: 1.4 });
    try {
      term.open(host);
      landscapeCell ??= measuredCell(term);
    } finally {
      term.dispose();
      host.remove();
    }
    if (!landscapeCell) console.warn("[mockingbird] couldn't measure the landscape's terminal cell off screen: a workspace's pty keeps its size until its terminal is attached");
    return landscapeCell;
  });
  return cellProbe;
}

/** A session's cached terminal for a landscape card to read: made, and its saved output replayed, if it isn't yet. */
export function landscapeTerm(session: SessionInfo): Terminal {
  return termFor(session, LANDSCAPE_FONT).term;
}

/**
 * Keep the terminal of a workspace nothing shows (a card, or off screen) at the size its workspace gives it, as
 * followPlacement does for one that's attached: colsRows of `size` at the cell landscape terminals measure, the
 * pty told only when that differs from what it has. So a card's buffer is the width the agent draws for, and
 * attaching it again (zooming in, panning back) finds its pty at that size already: a band change never resizes
 * one. A teammate's session keeps its owner's size (followOwners), and a terminal a pane follows is left to the
 * pane. Returns the stop, for a hold still waiting for the cell to be measured.
 */
export function holdSize(session: SessionInfo, size: { w: number; h: number }): () => void {
  if (session.status === "dead" || isRemotePaneId(session.id)) return () => undefined;
  const e = termFor(session, LANDSCAPE_FONT);
  let on = true;
  const hold = (cell: Cell | null) => {
    if (!on || !cell || e.refit || terms.get(session.id) !== e) return;
    const { cols, rows } = colsRows(size.w, size.h, cell.w, cell.h);
    if (e.term.cols !== cols || e.term.rows !== rows) e.term.resize(cols, rows);
    if (e.ptySize?.cols === cols && e.ptySize.rows === rows) return;
    e.ptySize = { cols, rows };
    window.mb.sessionResize(session.id, cols, rows);
  };
  if (landscapeCell) hold(landscapeCell);
  else void landscapeCellReady().then(hold);
  return () => void (on = false);
}

/** A session's cached terminal's screen as plain text, its rows as they show now: a peeked workspace's stand-in. */
export function screenText(id: string): string | null {
  const term = terms.get(id)?.term;
  if (!term) return null;
  const b = term.buffer.active;
  const rows: string[] = [];
  for (let y = 0; y < term.rows; y++) rows.push(b.getLine(b.viewportY + y)?.translateToString(true) ?? "");
  return rows.join("\n");
}

/** What a scroll left short of a whole row, per terminal, so small wheel steps (a trackpad's) still add up. */
const scrollRest = new WeakMap<object, number>();

/**
 * Scroll a session's cached terminal's view through its history by `px` on screen, as the user (a kept-open peek's
 * wheel): its view only, so nothing reaches the program, whatever mouse or scroll modes it asked for.
 */
export function scrollTerm(id: string, px: number): void {
  const term = terms.get(id)?.term;
  const cell = term && measuredCell(term);
  if (!term || !cell?.h) return;
  const rows = (scrollRest.get(term) ?? 0) + px / cell.h;
  const n = Math.trunc(rows);
  scrollRest.set(term, rows - n);
  if (!n) return;
  noteUserScroll(term);
  term.scrollLines(n);
}

/**
 * Show a session's cached terminal in `holder` (a landscape peek) at its own size, its font fitted to the holder
 * up to `maxFont` (followFixedSize), and fitted again when its size changes (its owner's, for a teammate's): its
 * pty is never resized. It never takes the keyboard while lent: focusTerm sends a request for it to `onKeys`, it
 * can't be tabbed to, and a focus that reaches it anyway goes to `onKeys` before xterm sees it (xterm would tell a
 * program that asked for focus reports). Returns the hand-back, which puts its font back while it's still in the
 * page (xterm measures a font only in the page, and the next pane sizes its pty by that measure) and gives its
 * WebGL context up; null when the session has no cached terminal.
 */
export function lendTerm(id: string, holder: HTMLElement, maxFont: number, onKeys: () => void): (() => void) | null {
  const e = terms.get(id);
  if (!e) return null;
  const { term } = e;
  const font = term.options.fontSize;
  const area = term.textarea;
  if (area && document.activeElement === area) onKeys();
  e.lent = onKeys;
  const tab = area?.tabIndex;
  if (area) area.tabIndex = -1;
  const refuse = (ev: FocusEvent) => {
    if (ev.target !== area) return;
    ev.stopPropagation();
    if (ev.type === "focus") onKeys();
  };
  holder.addEventListener("focus", refuse, true);
  holder.addEventListener("blur", refuse, true);
  attachTerm(term, holder);
  const fixed = followFixedSize(e, holder, () => ({ cols: term.cols, rows: term.rows }), () => maxFont);
  const resized = term.onResize(() => fixed.refit());
  webglOn(term, id);
  return () => {
    resized.dispose();
    fixed.stop();
    holder.removeEventListener("focus", refuse, true);
    holder.removeEventListener("blur", refuse, true);
    if (area && tab !== undefined) area.tabIndex = tab;
    if (e.lent === onKeys) e.lent = undefined;
    if (term.options.fontSize !== font) term.options.fontSize = font;
    webglOff(term, id);
  };
}

/** Give a session's terminal the keyboard; one lent to a peek sends the request on instead (lendTerm). */
export function focusTerm(id: string): void {
  const e = terms.get(id);
  if (e?.lent) return e.lent();
  e?.term.focus();
}
