import React, { useEffect, useRef, useSyncExternalStore } from "react";
import { EditorState, RangeSet, StateEffect, StateField, Transaction, type Extension, type RangeValue, type StateEffectType, type Text, type TransactionSpec } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, gutter, keymap, lineNumbers, type DecorationSet } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { getIndentUnit, indentUnit, StreamLanguage, HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { setDiagnostics } from "@codemirror/lint";
import { indentWithTab } from "@codemirror/commands";
import { tags as t } from "@lezer/highlight";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { json } from "@codemirror/lang-json";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { markdown } from "@codemirror/lang-markdown";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { sql } from "@codemirror/lang-sql";
import { csharp, java, kotlin, scala } from "@codemirror/legacy-modes/mode/clike";
import { go } from "@codemirror/legacy-modes/mode/go";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { rust } from "@codemirror/legacy-modes/mode/rust";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { isErr, type FileContent, type FileSave, type LspDiagnostic, type LspFileEdits, type LspFileState, type LspLocation, type IpcResult } from "../shared/types";
import type { LspPosition, LspTextEdit } from "../shared/textEdits";
import { NO_SERVER, fromLspPos, lspExtensions, toCmDiagnostics, type LspDocContext } from "./lspEditor";
import { guessIndent, lineBreakOf, splitBom, toEditorText, toFileText, type LineBreak } from "../shared/editorText";
import { fileLanguage, type FileLanguage } from "../shared/fileTypes";
import { settled } from "./settled";
import { plural } from "../shared/format";

const CM_LANGUAGE: Record<FileLanguage, (() => Extension) | null> = {
  typescript: () => javascript({ typescript: true }),
  tsx: () => javascript({ typescript: true, jsx: true }),
  javascript: () => javascript(),
  jsx: () => javascript({ jsx: true }),
  python: () => python(),
  json: () => json(),
  css: () => css(),
  scss: () => css(),
  less: () => css(),
  html: () => html(),
  xml: () => xml(),
  markdown: () => markdown(),
  yaml: () => yaml(),
  sql: () => sql(),
  csharp: () => StreamLanguage.define(csharp),
  java: () => StreamLanguage.define(java),
  kotlin: () => StreamLanguage.define(kotlin),
  scala: () => StreamLanguage.define(scala),
  go: () => StreamLanguage.define(go),
  shell: () => StreamLanguage.define(shell),
  toml: () => StreamLanguage.define(toml),
  rust: () => StreamLanguage.define(rust),
  ruby: () => StreamLanguage.define(ruby),
  swift: () => StreamLanguage.define(swift),
  php: null,
  properties: () => StreamLanguage.define(properties),
  dockerfile: () => StreamLanguage.define(dockerFile),
  makefile: () => StreamLanguage.define(shell),
};

/** The editor's language for a file, by its name. */
export function languageExtension(path: string): Extension | null {
  const lang = fileLanguage(path);
  return (lang && CM_LANGUAGE[lang]?.()) ?? null;
}

// colors from the theme's own palette, matching the diff view's highlighting
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword], color: "var(--m-2)" },
  { tag: [t.string, t.special(t.string), t.regexp, t.inserted], color: "var(--m-0)" },
  { tag: [t.number, t.bool, t.null, t.atom, t.literal], color: "var(--m-1)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--text-4)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.heading], color: "var(--m-3)" },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--m-5)" },
  { tag: [t.tagName, t.angleBracket], color: "var(--m-4)" },
  { tag: [t.attributeName, t.propertyName], color: "var(--text-1)" },
  { tag: [t.meta, t.processingInstruction, t.punctuation], color: "var(--text-3)" },
  { tag: t.strong, fontWeight: "600" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.link, color: "var(--m-3)", textDecoration: "underline" },
  { tag: [t.deleted, t.invalid], color: "var(--red)" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", color: "var(--text-2)", backgroundColor: "var(--bg-app)", fontSize: "11.5px" },
  ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.5" },
  ".cm-content": { caretColor: "var(--amber)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--amber)" },
  ".cm-gutters": { backgroundColor: "var(--bg-app)", color: "var(--text-4)", borderRight: "1px solid var(--line-soft)" },
  ".cm-activeLine": { backgroundColor: "var(--fill-subtle)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--fill-subtle)", color: "var(--text-2)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": { backgroundColor: "color-mix(in srgb, var(--teal) 28%, transparent) !important" },
  ".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--teal) 14%, transparent)" },
  ".cm-searchMatch": { backgroundColor: "var(--fill-waiting)", outline: "1px solid color-mix(in srgb, var(--amber) 50%, transparent)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "color-mix(in srgb, var(--amber) 35%, transparent)" },
  ".cm-matchingBracket": { backgroundColor: "color-mix(in srgb, var(--teal) 22%, transparent)", outline: "none" },
  ".cm-panels": { backgroundColor: "var(--bg-chrome)", color: "var(--text-2)" },
  ".cm-panels-bottom": { borderTop: "1px solid var(--line-med)" },
  ".cm-panel input, .cm-panel button": { fontSize: "11px" },
  ".cm-tooltip": { backgroundColor: "var(--bg-pane-header)", border: "1px solid var(--line-strong2)", color: "var(--text-1)" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--fill-selected)", border: "none", color: "var(--text-3)" },
});

// ---- breakpoints, the paused line and the revealed line ----

export const setBreakpoints = StateEffect.define<number[]>();
export const setPaused = StateEffect.define<number[]>();
const setFlash = StateEffect.define<number | null>();

const bpMarker = new (class extends GutterMarker {
  toDOM() {
    const d = document.createElement("span");
    d.className = "cm-bp";
    return d;
  }
})();

/**
 * Marks on the debugger's own line numbers (set by `effect`). They don't move
 * with edits: the debugger still stops at, and is stopped at, the lines it was
 * given — and a click on a breakpoint dot must remove that breakpoint rather
 * than add one beside it.
 */
function debuggerLines<T extends RangeValue>(effect: StateEffectType<number[]>, mark: T) {
  return StateField.define<{ lines: number[]; marks: RangeSet<T> }>({
    create: () => ({ lines: [], marks: RangeSet.empty }),
    update(v, tr) {
      let lines = v.lines;
      for (const e of tr.effects) if (e.is(effect)) lines = [...new Set(e.value)].sort((a, b) => a - b);
      if (lines === v.lines && !tr.docChanged) return v;
      const doc = tr.state.doc;
      return { lines, marks: RangeSet.of(lines.filter((l) => l >= 1 && l <= doc.lines).map((l) => mark.range(doc.line(l).from))) };
    },
  });
}
export const bpField = debuggerLines(setBreakpoints, bpMarker);
export const pausedField = debuggerLines(setPaused, Decoration.line({ class: "cm-paused" }));
const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(set, tr) {
    set = set.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setFlash)) {
        const l = e.value;
        set = l && l >= 1 && l <= tr.state.doc.lines ? Decoration.set([Decoration.line({ class: "cm-flash" }).range(tr.state.doc.line(l).from)]) : Decoration.none;
      }
    }
    return set;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ---- buffers: each open file's editor state, kept across tab switches ----
// One per file (editorTabs' fileKey), shared by every tab that shows the file.

export interface Buffer {
  state: EditorState;
  /** The text last read or saved, in the editor's "\n" form — what "unsaved" is measured against. */
  saved: string;
  mtimeMs: number;
  bom: boolean;
  lineBreak: LineBreak;
  readOnly: boolean;
  /** The file changed on disk while this buffer had unsaved edits: the disk version, once read (text null until then). */
  conflict: { text: string | null; mtimeMs: number; bom: boolean; lineBreak: LineBreak } | null;
  /** Its language server, when the file is open with one in reach. */
  lsp: LspBuffer | null;
}

interface LspBuffer {
  ctx: LspDocContext;
  root: string;
  state: LspFileState | null;
  /** The open request, once made: the file is closed with its server only after it's answered, and only if it opened. */
  opening: Promise<IpcResult<LspFileState>> | null;
  /** The text the server has, as last sent. Its answers are about this text, so its edits apply only while the buffer still holds it. */
  sentDoc: Text | null;
  /** Edits waiting to go to the server (sent 300 ms after typing stops, or before any question). */
  timer: ReturnType<typeof setTimeout> | null;
  sent: Promise<unknown>;
  /** The latest message for the user (a failed request, a rename's result, install progress). */
  note: string;
}

/** What the editor component does for a buffer, reached from inside CodeMirror (gutter clicks, ⌘S). */
interface Handlers {
  toggleBreakpoint: (line: number) => void;
  save: () => void;
  openLocation: (loc: LspLocation) => void;
}

const buffers = new Map<string, Buffer>();
const handlers = new Map<string, Handlers>();
const subs = new Set<() => void>();
let version = 0;
const notify = () => {
  version++;
  subs.forEach((s) => s());
};

const isDirty = (b: Buffer) => b.state.doc.toString() !== b.saved;
/** The mounted view of each buffer on screen. */
const views = new Map<string, EditorView>();
/** A request's answer, with a failed request (a rejected promise) as its error, so the caller reports it rather than stopping halfway. */

/** Change a buffer whether or not it's on screen: through its view when mounted, else its saved state. */
export function updateBuffer(key: string, spec: (s: EditorState) => TransactionSpec): void {
  const b = buffers.get(key);
  if (!b) return;
  const v = views.get(key);
  if (v) return v.dispatch(spec(v.state));
  const tr = b.state.update(spec(b.state));
  b.state = tr.state;
  // a mounted view tells the server through its update listener
  if (tr.docChanged) {
    notify();
    lspChanged(key);
  }
}

// ---- language servers (lspEditor.ts has the editor features) ----

let formatOnSave = (() => {
  try {
    return JSON.parse(localStorage.getItem("mb.formatOnSave") ?? "false") === true;
  } catch {
    return false;
  }
})();
/** Settings → General: format files with their language server when they're saved. */
export function setFormatOnSave(on: boolean): void {
  formatOnSave = on;
  try {
    localStorage.setItem("mb.formatOnSave", JSON.stringify(on));
  } catch {
    /* kept for this run only */
  }
}
export const getFormatOnSave = () => formatOnSave;

/** Servers the user said "Not now" to, until the app restarts. */
const lspDismissed = new Set<string>();
let lspListening = false;
function listenLsp(): void {
  if (lspListening) return;
  lspListening = true;
  window.mb.onLspDiagnostics((file: string, d: LspDiagnostic[]) => {
    for (const [key, b] of buffers) if (b.lsp?.ctx.abs === file) updateBuffer(key, (s) => setDiagnostics(s, toCmDiagnostics(s.doc, d)));
  });
  window.mb.onLspStatus((st: { server: string; root: string; state: string; message?: string }) => {
    for (const b of buffers.values()) {
      if (!b.lsp || b.lsp.state?.server?.id !== st.server) continue;
      if (st.state === "installing" && st.message) b.lsp.note = st.message;
      else if (st.state === "failed" && b.lsp.root === st.root) {
        b.lsp.state = { ...b.lsp.state, state: "failed", message: st.message };
      } else if (st.message && b.lsp.root === st.root) b.lsp.note = st.message;
    }
    notify();
  });
}

/** Show a note under the editor; it clears itself after a while unless replaced. */
function lspNote(key: string, note: string): void {
  const b = buffers.get(key);
  if (!b?.lsp) return;
  const lsp = b.lsp;
  lsp.note = note;
  notify();
  if (note)
    setTimeout(() => {
      if (lsp.note !== note) return;
      lsp.note = "";
      notify();
    }, 8000);
}

/** Open (or reopen) a buffer with its language server. */
async function openLsp(key: string): Promise<void> {
  const b = buffers.get(key);
  if (!b?.lsp) return;
  listenLsp();
  const lsp = b.lsp;
  const doc = b.state.doc;
  const opening = settled<IpcResult<LspFileState>>(window.mb.lspOpen(lsp.ctx.sessionId, lsp.ctx.rel, doc.toString()));
  lsp.opening = opening;
  lsp.sentDoc = doc;
  const r = await opening;
  if (buffers.get(key) !== b || lsp.opening !== opening) return; // closed, or opened again since
  lsp.state = isErr(r) ? { server: lsp.state?.server ?? null, state: "failed", message: r.error } : r;
  // edits made while the server was starting weren't sent (lspChanged waits for ready)
  if (lsp.state.state === "ready" && b.state.doc !== doc) void sendLspChange(key);
  notify();
}

function sendLspChange(key: string): Promise<unknown> {
  const b = buffers.get(key);
  if (!b?.lsp) return Promise.resolve();
  b.lsp.timer = null;
  b.lsp.sentDoc = b.state.doc;
  b.lsp.sent = settled<IpcResult<unknown>>(window.mb.lspChange(b.lsp.ctx.sessionId, b.lsp.ctx.rel, b.state.doc.toString())).then((r) => {
    if (isErr(r)) lspNote(key, `The language server didn't get your edits: ${r.error}`);
  });
  return b.lsp.sent;
}

function lspChanged(key: string): void {
  const b = buffers.get(key);
  if (!b?.lsp || b.lsp.state?.state !== "ready") return;
  if (b.lsp.timer) clearTimeout(b.lsp.timer);
  b.lsp.timer = setTimeout(() => void sendLspChange(key), 300);
}

/** Send pending edits now, so the server answers about the text on screen. */
async function flushLsp(key: string): Promise<void> {
  const b = buffers.get(key);
  if (!b?.lsp) return;
  if (b.lsp.timer) {
    clearTimeout(b.lsp.timer);
    await sendLspChange(key);
  } else await b.lsp.sent;
}

const toChanges = (s: EditorState, edits: LspTextEdit[]) => ({
  changes: edits.map((e) => ({ from: fromLspPos(s.doc, e.range.start), to: fromLspPos(s.doc, e.range.end), insert: e.newText })),
});

/** Format a buffer with its server. Asked for explicitly, a server that can't format says so. */
async function formatBuffer(key: string, explicit: boolean): Promise<void> {
  const b = buffers.get(key);
  if (!b?.lsp || b.lsp.state?.state !== "ready") return explicit ? lspNote(key, NO_SERVER) : undefined;
  await flushLsp(key);
  const asked = b.lsp.sentDoc;
  const unit = getIndentUnit(b.state);
  const tabs = b.state.facet(indentUnit).includes("\t");
  const r = await settled<IpcResult<LspTextEdit[] | null>>(window.mb.lspFormat(b.lsp.ctx.sessionId, b.lsp.ctx.rel, tabs ? b.state.tabSize : unit, !tabs));
  if (isErr(r)) return lspNote(key, `Formatting failed: ${r.error}`);
  if (r === null) return explicit ? lspNote(key, `${b.lsp.state?.server?.label ?? "This"} language server doesn't format files`) : undefined;
  if (!r.length) return;
  if (buffers.get(key) !== b || b.state.doc !== asked) return lspNote(key, "The file changed while it was being formatted, so it wasn't — format it again");
  updateBuffer(key, (s) => toChanges(s, r));
}

/** Rename the symbol at a position, across files, with the buffer's server. */
async function renameSymbol(key: string, at: LspPosition, name: string): Promise<IpcResult<string>> {
  const b = buffers.get(key);
  if (!b?.lsp || b.lsp.state?.state !== "ready") return { error: NO_SERVER };
  await flushLsp(key);
  // each open file as its server has it now, which is what the edits for it will be about
  const asked = new Map([...buffers.values()].flatMap((o) => (o.lsp ? [[o.lsp.ctx.abs, o.lsp.sentDoc] as const] : [])));
  const { sessionId, rel } = b.lsp.ctx;
  const r = await settled<IpcResult<LspFileEdits[]>>(window.mb.lspRename(sessionId, rel, at.line, at.character, name));
  if (isErr(r)) return r;
  return applyRename(r, sessionId, b.lsp.root, asked);
}

/**
 * Apply a rename across files: open ones change in their buffers (unsaved, for
 * review); the rest are written straight to disk, inside the session's folder.
 * An open file edited since the rename was asked for is left alone.
 */
async function applyRename(edits: LspFileEdits[], sessionId: string, root: string, asked: ReadonlyMap<string, Text | null>): Promise<string> {
  let open = 0;
  let saved = 0;
  const problems: string[] = [];
  for (const fe of edits) {
    const name = fe.path.split("/").pop();
    const hit = [...buffers].find(([, b]) => b.lsp?.ctx.abs === fe.path);
    if (hit) {
      const [key, b] = hit;
      if (b.state.doc !== asked.get(fe.path)) problems.push(`${name} changed while renaming — not changed`);
      else {
        updateBuffer(key, (s) => toChanges(s, fe.edits));
        open++;
      }
      continue;
    }
    if (!fe.path.startsWith(root + "/")) {
      problems.push(`${fe.path} is outside this session's folder — not changed`);
      continue;
    }
    const r = await settled<IpcResult<FileSave>>(window.mb.lspApplyEdits(sessionId, fe.path.slice(root.length + 1), fe.edits));
    if (isErr(r)) problems.push(`${name}: ${r.error}`);
    else if (!r.saved) problems.push(`${name} changed on disk meanwhile — not changed`);
    else saved++;
  }
  notify();
  return [`Renamed in ${plural(open + saved, "file")}`, open ? `${open} open with unsaved changes` : "", saved ? `${saved} saved` : "", ...problems]
    .filter(Boolean)
    .join(" · ");
}

const subscribe = (cb: () => void) => {
  subs.add(cb);
  return () => subs.delete(cb);
};
/** Redraw when any buffer changes: edits, saves, language-server state and notes. */
const useBufferChanges = () => useSyncExternalStore(subscribe, () => version);

/** Which open files have unsaved edits — the tab bar's dots, and the close prompts. */
export function useDirtyKeys(): Set<string> {
  useBufferChanges();
  return new Set(dirtyKeys());
}

export function dirtyKeys(): string[] {
  return [...buffers].filter(([, b]) => isDirty(b)).map(([k]) => k);
}

/** Forget a closed file's buffer (its unsaved edits go with it — the caller has asked). */
export function dropBuffer(key: string): void {
  const b = buffers.get(key);
  if (b?.lsp) {
    const { ctx, timer, opening } = b.lsp;
    if (timer) clearTimeout(timer);
    // a close sent while the server is still starting would find nothing to close, and the file would stay open with it
    void opening?.then((r) => {
      if (!isErr(r) && r.state === "ready") void window.mb.lspClose(ctx.sessionId, ctx.rel);
    });
  }
  buffers.delete(key);
  handlers.delete(key);
  notify();
}

/** Forget the buffers of files no tab shows any more (a tab closed to make room), except ones with unsaved edits. */
export function releaseBuffers(shown: ReadonlySet<string>): void {
  for (const [key, b] of [...buffers]) if (!shown.has(key) && !isDirty(b)) dropBuffer(key);
}

/**
 * Ask before closing files with unsaved edits, then forget their buffers.
 * True when they may close.
 */
export function confirmClose(items: { key: string; name: string }[]): boolean {
  const dirty = items.filter((i) => {
    const b = buffers.get(i.key);
    return b && isDirty(b);
  });
  if (dirty.length) {
    const what = dirty.length === 1 ? `${dirty[0].name} has unsaved changes` : `${dirty.length} files have unsaved changes (${dirty.map((d) => d.name).join(", ")})`;
    if (!window.confirm(`${what}. Close without saving?`)) return false;
  }
  for (const i of items) dropBuffer(i.key);
  return true;
}

function newState(key: string, text: string, path: string, readOnly: boolean, lsp: LspDocContext | null): EditorState {
  const lang = languageExtension(path);
  const gutterClick = {
    mousedown(view: EditorView, line: { from: number }) {
      handlers.get(key)?.toggleBreakpoint(view.state.doc.lineAt(line.from).number);
      return true;
    },
  };
  return EditorState.create({
    doc: text,
    extensions: [
      gutter({ class: "cm-bp-gutter", markers: (v) => v.state.field(bpField).marks, initialSpacer: () => bpMarker, domEventHandlers: gutterClick }),
      lineNumbers({ domEventHandlers: gutterClick }),
      basicSetup,
      keymap.of([
        {
          key: "Mod-s",
          run: () => {
            handlers.get(key)?.save();
            return true;
          },
          preventDefault: true,
        },
        indentWithTab,
      ]),
      indentUnit.of(guessIndent(text)),
      EditorState.tabSize.of(4),
      theme,
      syntaxHighlighting(highlight),
      bpField,
      pausedField,
      EditorView.decorations.from(pausedField, (v) => v.marks),
      flashField,
      ...(lang ? [lang] : []),
      ...(lsp ? lspExtensions(lsp) : []),
      ...(readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
      EditorView.updateListener.of((u) => {
        if (!u.docChanged) return;
        notify();
        lspChanged(key);
      }),
    ],
  });
}

/** A file's buffer, made from its first read (and opened with its language server) unless it's open already. */
export function openBuffer(key: string, file: FileContent, path: string, lsp?: { sessionId: string; root: string }): Buffer {
  const open = buffers.get(key);
  if (open) return open;
  const { bom, text } = splitBom(file.content);
  const lf = toEditorText(text);
  const ctx: LspDocContext | null =
    lsp && !file.truncated
      ? {
          sessionId: lsp.sessionId,
          rel: path,
          abs: `${lsp.root}/${path}`,
          ready: () => buffers.get(key)?.lsp?.state?.state === "ready",
          flush: () => flushLsp(key),
          openLocation: (loc) => handlers.get(key)?.openLocation(loc),
          rename: (at, name) => renameSymbol(key, at, name),
          format: () => formatBuffer(key, true),
          report: (m) => lspNote(key, m),
        }
      : null;
  const b: Buffer = {
    state: newState(key, lf, path, file.truncated, ctx),
    saved: lf,
    mtimeMs: file.mtimeMs,
    bom,
    lineBreak: lineBreakOf(text),
    readOnly: file.truncated,
    conflict: null,
    lsp: ctx && lsp ? { ctx, root: lsp.root, state: null, opening: null, sentDoc: null, timer: null, sent: Promise.resolve(), note: "" } : null,
  };
  buffers.set(key, b);
  if (b.lsp) void openLsp(key);
  return b;
}

/**
 * The file as just read from disk (an agent edited it): reload the buffer if
 * nothing's unsaved, else keep the disk version for the user to choose. A read
 * older than what the buffer has — it started before a save or a newer read
 * finished — changes nothing.
 */
export function diskRead(key: string, file: FileContent): void {
  const b = buffers.get(key);
  if (!b || file.mtimeMs < b.mtimeMs || (file.mtimeMs === b.mtimeMs && !b.conflict)) return;
  const { bom, text } = splitBom(file.content);
  const disk = { text: toEditorText(text), mtimeMs: file.mtimeMs, bom, lineBreak: lineBreakOf(text) };
  if (disk.text === b.saved) {
    // the disk holds what the buffer was measured against: nothing left to choose between
    b.mtimeMs = disk.mtimeMs;
    b.conflict = null;
  } else if (isDirty(b)) b.conflict = disk;
  else adoptDisk(key, b, disk);
  notify();
}

/** "Use theirs": throw away the unsaved edits for the disk version the conflict holds. */
export function takeDiskVersion(key: string): void {
  const b = buffers.get(key);
  const disk = b?.conflict;
  if (!b || !disk || disk.text === null) return;
  adoptDisk(key, b, { ...disk, text: disk.text });
  notify();
}

/** The disk version becomes the buffer's text and what it's measured against, byte-order mark and line breaks included. */
function adoptDisk(key: string, b: Buffer, disk: { text: string; mtimeMs: number; bom: boolean; lineBreak: LineBreak }): void {
  updateBuffer(key, (s) => ({ changes: { from: 0, to: s.doc.length, insert: disk.text }, annotations: Transaction.addToHistory.of(false) }));
  b.saved = disk.text;
  b.mtimeMs = disk.mtimeMs;
  b.bom = disk.bom;
  b.lineBreak = disk.lineBreak;
  b.conflict = null;
}

/**
 * Save a buffer through `write` (checked against the mtime it was read at
 * unless forced), formatting it first when that's on. A save that finds the
 * file changed on disk leaves a conflict for the user to settle.
 */
export async function saveBuffer(
  key: string,
  write: (text: string, expectedMtimeMs: number | null) => Promise<IpcResult<FileSave>>,
  force: boolean
): Promise<IpcResult<"saved" | "conflict">> {
  const b = buffers.get(key);
  if (!b || b.readOnly) return { error: "This file is read-only here" };
  if (formatOnSave) await formatBuffer(key, false);
  const text = b.state.doc.toString();
  const r = await settled(write(toFileText(text, b.lineBreak, b.bom), force ? null : b.mtimeMs));
  if (isErr(r)) return r;
  if (!r.saved) {
    // someone else saved first: the caller reads their version so "Use theirs" has it
    b.conflict = { text: null, mtimeMs: r.mtimeMs, bom: b.bom, lineBreak: b.lineBreak };
    notify();
    return "conflict";
  }
  b.saved = text;
  b.mtimeMs = r.mtimeMs;
  b.conflict = null;
  if (b.lsp?.state?.state === "ready") void window.mb.lspSaved(b.lsp.ctx.sessionId, b.lsp.ctx.rel);
  notify();
  return "saved";
}

/**
 * An editable file: VS Code-style editing (undo, find and replace, multiple
 * cursors, bracket matching, folding), ⌘S to save. A file an agent changes
 * while it's open reloads if you haven't edited it; if you have, you choose
 * whose version wins. Saving checks the file hasn't changed since it was
 * read, and keeps its line endings and byte-order mark.
 */
export function CodeEditor({
  bufferKey,
  file,
  path,
  onSave,
  onRefresh,
  saveRef,
  breakpoints,
  onToggleBreakpoint,
  pausedLines,
  reveal,
  lsp,
  onOpenLocation,
}: {
  bufferKey: string;
  file: FileContent;
  path: string;
  onSave: (text: string, expectedMtimeMs: number | null) => Promise<FileSave | { error: string }>;
  /** Read the file again (after a save found it changed on disk). */
  onRefresh: () => void;
  /** Set to this editor's save, for a Save button outside it. */
  saveRef?: React.MutableRefObject<(() => void) | null>;
  breakpoints: number[];
  onToggleBreakpoint: (line: number) => void;
  pausedLines: number[];
  reveal?: { line: number; at: number };
  /** The session folder the file is in, for its language server (go to definition, completions, problems…). */
  lsp?: { sessionId: string; root: string };
  /** Open a definition in another file; returns why it couldn't. */
  onOpenLocation?: (loc: LspLocation) => string | null;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const [status, setStatus] = React.useState("");
  // language-server state and notes live on the buffer
  useBufferChanges();

  const save = async (force = false) => {
    const b = buffers.get(bufferKey);
    if (!b || !view.current || b.readOnly) return;
    setStatus("Saving…");
    const r = await saveBuffer(bufferKey, onSave, force);
    if (isErr(r)) return setStatus(`Not saved: ${r.error}`);
    if (r === "conflict") {
      setStatus("");
      return onRefresh();
    }
    setStatus("Saved");
    setTimeout(() => setStatus((s) => (s === "Saved" ? "" : s)), 1500);
  };

  handlers.set(bufferKey, {
    toggleBreakpoint: onToggleBreakpoint,
    save: () => save(),
    openLocation: (loc) => {
      const why = onOpenLocation ? onOpenLocation(loc) : `The definition is in ${loc.path}:${loc.line}`;
      if (why) lspNote(bufferKey, why);
    },
  });
  if (saveRef) saveRef.current = () => save();

  // the editor view, made from (and saved back to) the buffer, so a tab switch keeps edits and undo
  useEffect(() => {
    const b = openBuffer(bufferKey, file, path, lsp);
    const v = new EditorView({
      state: b.state,
      parent: host.current!,
      // the buffer follows every change, so a tab switch or a remount loses nothing
      dispatchTransactions: (trs, view) => {
        view.update(trs);
        b.state = view.state;
      },
    });
    view.current = v;
    views.set(bufferKey, v);
    return () => {
      b.state = v.state;
      if (views.get(bufferKey) === v) views.delete(bufferKey);
      v.destroy();
      view.current = null;
    };
  }, [bufferKey]);

  useEffect(() => diskRead(bufferKey, file), [file.mtimeMs, file.content]);

  useEffect(() => {
    view.current?.dispatch({ effects: setBreakpoints.of(breakpoints) });
  }, [breakpoints.join(","), bufferKey]);

  useEffect(() => {
    view.current?.dispatch({ effects: setPaused.of(pausedLines) });
    const l = pausedLines[0];
    const v = view.current;
    if (v && l && l <= v.state.doc.lines) v.dispatch({ effects: EditorView.scrollIntoView(v.state.doc.line(l).from, { y: "center" }) });
  }, [pausedLines.join(","), bufferKey]);

  // a search hit or "name:line": scroll there, put the cursor on it, flash it
  useEffect(() => {
    const v = view.current;
    if (!v || !reveal || reveal.line > v.state.doc.lines) return;
    const pos = v.state.doc.line(reveal.line).from;
    v.dispatch({ selection: { anchor: pos }, effects: [EditorView.scrollIntoView(pos, { y: "center" }), setFlash.of(reveal.line)] });
    const t = setTimeout(() => view.current?.dispatch({ effects: setFlash.of(null) }), 2400);
    return () => clearTimeout(t);
  }, [reveal?.at, bufferKey]);

  const b = buffers.get(bufferKey);

  return (
    <div className="ce">
      {file.truncated && <div className="fp-note">Large file — showing the first part of {file.size.toLocaleString()} bytes, read-only</div>}
      {b?.conflict && (
        <div className="ce-conflict">
          <span>This file changed on disk{b.conflict.text !== null ? " while you had unsaved edits" : " after you opened it"}.</span>
          <button className="outline" data-tip="Write your version over the one on disk" onClick={() => save(true)}>
            Keep mine
          </button>
          <button
            className="outline"
            data-tip="Throw away your unsaved edits and show what's on disk"
            onClick={() => takeDiskVersion(bufferKey)}
            disabled={b.conflict.text === null}
          >
            Use theirs
          </button>
        </div>
      )}
      {b?.lsp && <LspBanner bufferKey={bufferKey} lsp={b.lsp} />}
      <div className="ce-host" ref={host} />
      {(status || b?.lsp?.note) && <div className="ce-status">{status || b?.lsp?.note}</div>}
    </div>
  );
}

/**
 * What the editor says about a file's language server: offer to install it,
 * say what's missing or why it stopped. Nothing shows while it's working.
 */
function LspBanner({ bufferKey, lsp }: { bufferKey: string; lsp: LspBuffer }) {
  const [busy, setBusy] = React.useState(false);
  const st = lsp.state;
  if (!st || st.state === "ready" || st.state === "none" || (st.server && lspDismissed.has(st.server.id))) return null;
  const server = st.server;
  // an open that failed before any server was known (the request itself) still says why
  if (!server)
    return (
      <div className="ce-lsp warn">
        <span>Language features are off: {st.message}</span>
        <button className="outline" onClick={() => void openLsp(bufferKey)}>
          Try again
        </button>
      </div>
    );
  const reopenAll = () => {
    for (const [key, b] of buffers) if (b.lsp?.state?.server?.id === server.id) void openLsp(key);
  };
  if (st.state === "install")
    return (
      <div className="ce-lsp">
        <span>
          Go to definition, hover, completions and problems for {server.label} need its language server ({st.message}, downloaded once and checked against its
          published checksum).
        </span>
        <button
          className="outline"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const r = await settled<IpcResult<unknown>>(window.mb.lspInstall(server.id));
            setBusy(false);
            if (isErr(r)) return lspNote(bufferKey, `Couldn't install it: ${r.error}`);
            lspNote(bufferKey, "");
            reopenAll();
          }}
        >
          {busy ? "Installing…" : "Install"}
        </button>
        <button
          className="outline"
          onClick={() => {
            lspDismissed.add(server.id);
            notify();
          }}
        >
          Not now
        </button>
      </div>
    );
  return (
    <div className="ce-lsp warn">
      <span>
        {server.label} language features are off: {st.message}
      </span>
      {st.state === "failed" && (
        <button className="outline" onClick={() => void openLsp(bufferKey)}>
          Try again
        </button>
      )}
    </div>
  );
}
