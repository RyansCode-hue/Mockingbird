import { EditorView, hoverTooltip, keymap, showPanel, type Panel, type Tooltip } from "@codemirror/view";
import { EditorState, StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { lintGutter, type Diagnostic } from "@codemirror/lint";
import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import type { LspCompletion, LspDiagnostic, LspLocation } from "../shared/types";
import type { LspPosition } from "../shared/textEdits";

/** What the editor's language features need from the buffer they're attached to. */
export interface LspDocContext {
  sessionId: string;
  rel: string;
  abs: string;
  /** The file is open with a running server. Until it is, nothing is asked of one. */
  ready: () => boolean;
  /** Send edits still waiting to go to the server, so it answers about the text on screen. */
  flush: () => Promise<void>;
  openLocation: (loc: LspLocation) => void;
  /** Rename the symbol at a position across files; resolves to what happened, for the user. */
  rename: (at: LspPosition, name: string) => Promise<Result<string>>;
  format: () => Promise<void>;
  /** A request failed: say so where the user can see it. */
  report: (message: string) => void;
}

export const NO_SERVER = "No language server is running for this file";

type Result<T> = T | { error: string };
const isErr = (r: unknown): r is { error: string } => !!r && typeof r === "object" && "error" in (r as object);

/** A document offset as an LSP position (line, UTF-16 column — CodeMirror's own units). */
export function toLspPos(doc: Text, offset: number): LspPosition {
  const line = doc.lineAt(offset);
  return { line: line.number - 1, character: offset - line.from };
}

/** An LSP position as a document offset, clamped into the document. */
export function fromLspPos(doc: Text, p: LspPosition): number {
  if (p.line + 1 > doc.lines) return doc.length;
  const line = doc.line(Math.max(1, p.line + 1));
  return Math.min(line.from + Math.max(0, p.character), line.to);
}

/** Server problems as CodeMirror diagnostics; an empty range marks the character after it. */
export function toCmDiagnostics(doc: Text, list: LspDiagnostic[]): Diagnostic[] {
  return list.map((d) => {
    const from = fromLspPos(doc, d.range.start);
    let to = fromLspPos(doc, d.range.end);
    if (to <= from) to = Math.min(from + 1, doc.lineAt(from).to);
    return { from, to: Math.max(from, to), severity: d.severity, message: d.message, ...(d.source ? { source: d.source } : {}) };
  });
}

const CM_TYPE: Record<string, string> = {
  method: "method",
  function: "function",
  constructor: "class",
  field: "property",
  variable: "variable",
  class: "class",
  interface: "interface",
  module: "namespace",
  property: "property",
  enum: "enum",
  "enum-member": "enum",
  keyword: "keyword",
  constant: "constant",
  struct: "class",
  "type-parameter": "type",
  value: "constant",
};

/** Characters after which a server offers completions without a word typed. */
const TRIGGERS = new Set([".", ":", ">", "/", "@", "<", "#", '"', "'"]);

export function completionSource(ctx: LspDocContext) {
  return async (c: CompletionContext): Promise<CompletionResult | null> => {
    if (!ctx.ready()) return null;
    const word = c.matchBefore(/[\w$]+/);
    const before = c.state.sliceDoc(Math.max(0, (word?.from ?? c.pos) - 1), word?.from ?? c.pos);
    const trigger = !word && TRIGGERS.has(before) ? before : undefined;
    if (!word && !trigger && !c.explicit) return null;
    await ctx.flush();
    if (c.aborted) return null;
    const p = toLspPos(c.state.doc, c.pos);
    const r: Result<LspCompletion[]> = await window.mb.lspComplete(ctx.sessionId, ctx.rel, p.line, p.character, word?.text ?? "", trigger);
    if (isErr(r)) {
      ctx.report(`Completions failed: ${r.error}`);
      return null;
    }
    if (c.aborted || !r.length) return null;
    const from = word ? word.from : c.pos;
    const options: Completion[] = r.map((it, i) => ({
      label: it.label,
      type: it.kind ? CM_TYPE[it.kind] ?? "text" : undefined,
      detail: it.detail,
      // the server's order, as a gentle tie-breaker for CodeMirror's own ranking
      boost: Math.round(40 - (i / r.length) * 80),
      apply: it.range
        ? (view: EditorView, _c: Completion, _from: number, to: number) => {
            const start = Math.min(fromLspPos(view.state.doc, it.range!.start), to);
            view.dispatch({ changes: { from: start, to, insert: it.insertText }, selection: { anchor: start + it.insertText.length } });
          }
        : it.insertText,
    }));
    return { from, options, validFor: /^[\w$]*$/ };
  };
}

/** Hover text as safe DOM: fenced code as blocks, `code` inline, the rest as text. */
export function renderHover(md: string): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "cm-lsp-hover";
  const parts = md.split(/```[\w-]*\n?/);
  parts.forEach((part, i) => {
    const text = part.replace(/\n+$/, "");
    if (!text.trim()) return;
    if (i % 2 === 1) {
      const pre = document.createElement("pre");
      pre.textContent = text;
      dom.appendChild(pre);
      return;
    }
    for (const para of text.split(/\n{2,}/)) {
      const p = document.createElement("p");
      para.split(/(`[^`]+`)/).forEach((seg) => {
        if (/^`[^`]+`$/.test(seg)) {
          const code = document.createElement("code");
          code.textContent = seg.slice(1, -1);
          p.appendChild(code);
        } else p.appendChild(document.createTextNode(seg.replace(/\*\*|__/g, "")));
      });
      dom.appendChild(p);
    }
  });
  return dom;
}

export function hoverSource(ctx: LspDocContext) {
  return async (view: EditorView, pos: number): Promise<Tooltip | null> => {
    if (!ctx.ready()) return null;
    await ctx.flush();
    const p = toLspPos(view.state.doc, pos);
    const r: Result<string> = await window.mb.lspHover(ctx.sessionId, ctx.rel, p.line, p.character);
    if (isErr(r)) {
      ctx.report(`Hover failed: ${r.error}`);
      return null;
    }
    if (!r.trim()) return null;
    return { pos, above: true, create: () => ({ dom: renderHover(r) }) };
  };
}

async function goToDefinition(view: EditorView, pos: number, ctx: LspDocContext): Promise<void> {
  if (!ctx.ready()) return ctx.report(NO_SERVER);
  await ctx.flush();
  const p = toLspPos(view.state.doc, pos);
  const r: Result<LspLocation[]> = await window.mb.lspDefinition(ctx.sessionId, ctx.rel, p.line, p.character);
  if (isErr(r)) return ctx.report(`Go to definition failed: ${r.error}`);
  const loc = r[0];
  if (!loc) return ctx.report("No definition found here");
  if (loc.path === ctx.abs) {
    const at = fromLspPos(view.state.doc, { line: loc.line - 1, character: loc.character });
    view.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: "center" }) });
    view.focus();
  } else ctx.openLocation(loc);
}

/** The rename box: F2 opens it under the editor with the name at the cursor. */
function renamePanel(ctx: LspDocContext): Extension {
  const toggle = StateEffect.define<{ pos: number; name: string } | null>();
  const field = StateField.define<{ pos: number; name: string } | null>({
    create: () => null,
    update: (v, tr) => {
      for (const e of tr.effects) if (e.is(toggle)) return e.value;
      return v;
    },
    provide: (f) => showPanel.from(f, (v) => (v ? (view) => makePanel(view, v) : null)),
  });
  const makePanel = (view: EditorView, at: { pos: number; name: string }): Panel => {
    const dom = document.createElement("div");
    dom.className = "cm-lsp-rename";
    const label = document.createElement("span");
    label.textContent = `Rename ${at.name} to`;
    const input = document.createElement("input");
    input.value = at.name;
    const note = document.createElement("span");
    note.className = "cm-lsp-note";
    const close = () => {
      view.dispatch({ effects: toggle.of(null) });
      view.focus();
    };
    input.addEventListener("keydown", async (e) => {
      if (e.key === "Escape") return close();
      if (e.key !== "Enter") return;
      e.preventDefault();
      const name = input.value.trim();
      if (!name || name === at.name) return close();
      input.disabled = true;
      note.textContent = "Renaming…";
      const r = await ctx.rename(toLspPos(view.state.doc, at.pos), name);
      if (isErr(r)) {
        input.disabled = false;
        note.textContent = r.error;
        return;
      }
      ctx.report(r);
      close();
    });
    dom.append(label, input, note);
    return { dom, top: false, mount: () => (input.focus(), input.select()) };
  };
  return [
    field,
    keymap.of([
      {
        key: "F2",
        run: (view) => {
          const pos = view.state.selection.main.head;
          const w = view.state.wordAt(pos);
          if (!w) return false;
          if (!ctx.ready()) return (ctx.report(NO_SERVER), true);
          view.dispatch({ effects: toggle.of({ pos: w.from, name: view.state.sliceDoc(w.from, w.to) }) });
          return true;
        },
      },
    ]),
  ];
}

/**
 * Language-server features for one buffer: problems underlined (and in the
 * gutter), hover, completions, go to definition (F12 or ⌘-click — Alt-click
 * adds a cursor, as in VS Code), rename (F2) and format (⇧⌥F).
 */
export function lspExtensions(ctx: LspDocContext): Extension[] {
  return [
    lintGutter(),
    EditorView.clickAddsSelectionRange.of((e) => e.altKey),
    EditorState.languageData.of(() => [{ autocomplete: completionSource(ctx) }]),
    hoverTooltip(hoverSource(ctx), { hoverTime: 400 }),
    renamePanel(ctx),
    keymap.of([
      { key: "F12", run: (v) => (void goToDefinition(v, v.state.selection.main.head, ctx), true) },
      { key: "Shift-Alt-f", run: () => (void ctx.format(), true), preventDefault: true },
    ]),
    EditorView.domEventHandlers({
      mousedown(e, view) {
        if (!e.metaKey || e.button !== 0 || !ctx.ready()) return false;
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos == null) return false;
        e.preventDefault();
        void goToDefinition(view, pos, ctx);
        return true;
      },
    }),
  ];
}
