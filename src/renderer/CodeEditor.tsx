import React, { useEffect, useRef, useSyncExternalStore } from "react";
import { EditorState, RangeSet, StateEffect, StateField, Transaction, type Extension } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, gutter, keymap, lineNumbers, type DecorationSet } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { indentUnit, StreamLanguage, HighlightStyle, syntaxHighlighting } from "@codemirror/language";
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
import type { FileContent, FileSave } from "../shared/types";
import { guessIndent, lineBreakOf, splitBom, toFileText } from "./editorText";

/** The editor's language for a file, by its name. */
export function languageExtension(path: string): Extension | null {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (name === "dockerfile" || name.startsWith("dockerfile.")) return StreamLanguage.define(dockerFile);
  if (name === ".env" || name.startsWith(".env.")) return StreamLanguage.define(properties);
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  switch (ext) {
    case "ts": case "mts": case "cts": return javascript({ typescript: true });
    case "tsx": return javascript({ typescript: true, jsx: true });
    case "js": case "mjs": case "cjs": return javascript();
    case "jsx": return javascript({ jsx: true });
    case "py": return python();
    case "json": case "jsonc": return json();
    case "css": case "scss": case "less": return css();
    case "html": case "htm": case "vue": case "razor": case "cshtml": return html();
    case "xml": case "svg": case "csproj": case "props": case "targets": case "config": case "xaml": return xml();
    case "md": case "markdown": case "mdx": return markdown();
    case "yml": case "yaml": return yaml();
    case "sql": return sql();
    case "cs": return StreamLanguage.define(csharp);
    case "java": return StreamLanguage.define(java);
    case "kt": case "kts": return StreamLanguage.define(kotlin);
    case "scala": return StreamLanguage.define(scala);
    case "go": return StreamLanguage.define(go);
    case "sh": case "bash": case "zsh": return StreamLanguage.define(shell);
    case "toml": return StreamLanguage.define(toml);
    case "rs": return StreamLanguage.define(rust);
    case "rb": return StreamLanguage.define(ruby);
    case "swift": return StreamLanguage.define(swift);
    case "ini": case "env": case "properties": case "cfg": return StreamLanguage.define(properties);
    default: return null;
  }
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

const setBreakpoints = StateEffect.define<number[]>();
const setPaused = StateEffect.define<number[]>();
const setFlash = StateEffect.define<number | null>();

const bpMarker = new (class extends GutterMarker {
  toDOM() {
    const d = document.createElement("span");
    d.className = "cm-bp";
    return d;
  }
})();

const bpField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(set, tr) {
    set = set.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setBreakpoints)) {
        const lines = [...new Set(e.value)].filter((l) => l >= 1 && l <= tr.state.doc.lines).sort((a, b) => a - b);
        set = RangeSet.of(lines.map((l) => bpMarker.range(tr.state.doc.line(l).from)));
      }
    }
    return set;
  },
});

function lineDecorations(effect: typeof setPaused, cls: string) {
  return StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(set, tr) {
      set = set.map(tr.changes);
      for (const e of tr.effects) {
        if (e.is(effect)) {
          const lines = e.value.filter((l) => l >= 1 && l <= tr.state.doc.lines).sort((a, b) => a - b);
          set = Decoration.set(lines.map((l) => Decoration.line({ class: cls }).range(tr.state.doc.line(l).from)));
        }
      }
      return set;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
}
const pausedField = lineDecorations(setPaused, "cm-paused");
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

interface Buffer {
  state: EditorState;
  /** The text last read or saved, in the editor's "\n" form — what "unsaved" is measured against. */
  saved: string;
  mtimeMs: number;
  bom: boolean;
  lineBreak: "\r\n" | "\n";
  readOnly: boolean;
  /** The file changed on disk while this buffer had unsaved edits. */
  conflict: { text: string; mtimeMs: number } | null;
}

/** What the editor component does for a buffer, reached from inside CodeMirror (gutter clicks, ⌘S). */
interface Handlers {
  toggleBreakpoint: (line: number) => void;
  save: () => void;
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

/** Which open files have unsaved edits — the tab bar's dots, and the close prompts. */
export function useDirtyKeys(): Set<string> {
  useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => version
  );
  return new Set([...buffers].filter(([, b]) => isDirty(b)).map(([k]) => k));
}

export function dirtyKeys(): string[] {
  return [...buffers].filter(([, b]) => isDirty(b)).map(([k]) => k);
}

/** Forget a closed tab's buffer (its unsaved edits go with it — the caller has asked). */
export function dropBuffer(key: string): void {
  buffers.delete(key);
  handlers.delete(key);
  notify();
}

/**
 * Ask before closing tabs with unsaved edits, then forget their buffers.
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

function newState(key: string, text: string, path: string, readOnly: boolean): EditorState {
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
      gutter({ class: "cm-bp-gutter", markers: (v) => v.state.field(bpField), initialSpacer: () => bpMarker, domEventHandlers: gutterClick }),
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
      flashField,
      ...(lang ? [lang] : []),
      ...(readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) notify();
      }),
    ],
  });
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
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const [, rerender] = React.useReducer((n: number) => n + 1, 0);
  const [status, setStatus] = React.useState("");

  const buffer = (): Buffer => {
    let b = buffers.get(bufferKey);
    if (!b) {
      const { bom, text } = splitBom(file.content);
      const lineBreak = lineBreakOf(text);
      const lf = text.replace(/\r\n/g, "\n");
      b = { state: newState(bufferKey, lf, path, file.truncated), saved: lf, mtimeMs: file.mtimeMs, bom, lineBreak, readOnly: file.truncated, conflict: null };
      buffers.set(bufferKey, b);
    }
    return b;
  };

  const save = async (force = false) => {
    const b = buffers.get(bufferKey);
    const v = view.current;
    if (!b || !v || b.readOnly) return;
    const lines = v.state.doc.toString();
    setStatus("Saving…");
    const r = await onSave(toFileText(lines, b.lineBreak, b.bom), force ? null : b.mtimeMs);
    if ("error" in r) return setStatus(`Not saved: ${r.error}`);
    if (!r.saved) {
      // someone else saved first: show the choice, and read their version so "Use theirs" has it
      b.conflict = { text: "", mtimeMs: r.mtimeMs };
      setStatus("");
      rerender();
      onRefresh();
      return;
    }
    b.saved = lines;
    b.mtimeMs = r.mtimeMs;
    b.conflict = null;
    setStatus("Saved");
    setTimeout(() => setStatus((s) => (s === "Saved" ? "" : s)), 1500);
    notify();
  };

  handlers.set(bufferKey, { toggleBreakpoint: onToggleBreakpoint, save: () => save() });
  if (saveRef) saveRef.current = () => save();

  // the editor view, made from (and saved back to) the buffer, so a tab switch keeps edits and undo
  useEffect(() => {
    const b = buffer();
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
    return () => {
      b.state = v.state;
      v.destroy();
      view.current = null;
    };
  }, [bufferKey]);

  // the file on disk changed (an agent edited it): reload if nothing's unsaved, else let the user choose
  useEffect(() => {
    const b = buffers.get(bufferKey);
    const v = view.current;
    if (!b || !v || (file.mtimeMs === b.mtimeMs && !b.conflict)) return;
    const { bom, text } = splitBom(file.content);
    const lf = text.replace(/\r\n/g, "\n");
    if (lf === b.saved) {
      b.mtimeMs = file.mtimeMs;
      return;
    }
    if (!isDirty(b)) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: lf }, annotations: Transaction.addToHistory.of(false) });
      b.saved = lf;
      b.mtimeMs = file.mtimeMs;
      b.bom = bom;
      b.lineBreak = lineBreakOf(text);
      notify();
    } else {
      b.conflict = { text: lf, mtimeMs: file.mtimeMs };
      rerender();
    }
  }, [file.mtimeMs, file.content]);

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
  const reload = () => {
    const v = view.current;
    if (!b || !v || !b.conflict) return;
    const text = b.conflict.text;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text }, annotations: Transaction.addToHistory.of(false) });
    b.saved = text;
    b.mtimeMs = b.conflict.mtimeMs;
    b.conflict = null;
    notify();
    rerender();
  };

  return (
    <div className="ce">
      {file.truncated && <div className="fp-note">Large file — showing the first part of {file.size.toLocaleString()} bytes, read-only</div>}
      {b?.conflict && (
        <div className="ce-conflict">
          <span>This file changed on disk{b.conflict.text ? " while you had unsaved edits" : " after you opened it"}.</span>
          <button className="outline" data-tip="Write your version over the one on disk" onClick={() => save(true)}>
            Keep mine
          </button>
          <button className="outline" data-tip="Throw away your unsaved edits and show what's on disk" onClick={reload} disabled={!b.conflict.text}>
            Use theirs
          </button>
        </div>
      )}
      <div className="ce-host" ref={host} />
      {status && <div className="ce-status">{status}</div>}
    </div>
  );
}
