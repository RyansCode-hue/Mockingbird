import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState, type RangeSet, type RangeValue, type StateField } from "@codemirror/state";
import { CompletionContext } from "@codemirror/autocomplete";
import type { FileContent, LspFileState } from "../src/shared/types";
import { EMPTY_EDITOR, MAX_TABS, fileKey, filesClosing, openTab, tabKey, type OpenFile } from "../src/renderer/editorTabs";

const READY: LspFileState = { server: { id: "typescript", label: "TypeScript" }, state: "ready" };
const mb = {
  lspOpen: vi.fn(),
  lspChange: vi.fn(),
  lspClose: vi.fn(),
  lspFormat: vi.fn(),
  lspRename: vi.fn(),
  lspHover: vi.fn(),
  lspComplete: vi.fn(),
  onLspDiagnostics: () => {},
  onLspStatus: () => {},
};
vi.stubGlobal("window", { mb });

let CE: typeof import("../src/renderer/CodeEditor");
beforeAll(async () => {
  CE = await import("../src/renderer/CodeEditor");
});
beforeEach(() => {
  for (const f of Object.values(mb)) if (vi.isMockFunction(f)) f.mockReset();
  mb.lspOpen.mockResolvedValue(READY);
  mb.lspChange.mockResolvedValue(undefined);
  mb.lspClose.mockResolvedValue(undefined);
});

const tick = () => new Promise((r) => setTimeout(r, 0));
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};
const disk = (content: string, mtimeMs = 100): FileContent => ({ binary: false, size: content.length, content, truncated: false, mtimeMs });
const LSP = { sessionId: "s", root: "/r" };
const edit = (line: number, from: number, to: number, newText: string) => ({ range: { start: { line, character: from }, end: { line, character: to } }, newText });

describe("editor tabs past the limit", () => {
  const file = (path: string, o: Partial<OpenFile> = {}): OpenFile => ({ sessionId: "s", root: "/r", path, mode: "file", ...o });

  it("never closes a tab of a file with unsaved edits to make room", () => {
    let s = EMPTY_EDITOR;
    for (let i = 0; i < MAX_TABS; i++) s = openTab(s, file(`f${i}.ts`));
    s = openTab(s, file("new.ts"), new Set([fileKey(file("f0.ts"))]));
    expect(s.tabs).toHaveLength(MAX_TABS);
    expect(s.tabs.map((t) => t.path)).toContain("f0.ts");
    expect(s.tabs.map((t) => t.path)).not.toContain("f1.ts");
    expect(s.active).toBe(tabKey(file("new.ts")));
  });

  it("closes a file only with its last tab", () => {
    const own = file("a.ts");
    const diff = file("a.ts", { mode: "diff", source: { kind: "scm", staged: false, untracked: false } });
    const tabs = [own, diff, file("b.ts")];
    expect(filesClosing(tabs, [tabKey(diff)])).toEqual([]);
    expect(filesClosing(tabs, [tabKey(diff), tabKey(own)]).map(fileKey)).toEqual([fileKey(own)]);
    expect(fileKey(own)).toBe(fileKey(diff));
  });
});

describe("one buffer per file", () => {
  it("gives every tab of a file the same buffer", () => {
    const a = CE.openBuffer("/r:shared.ts", disk("x\n"), "shared.ts");
    expect(CE.openBuffer("/r:shared.ts", disk("other\n"), "shared.ts")).toBe(a);
  });

  it("forgets clean buffers no tab shows, and keeps unsaved ones", () => {
    CE.openBuffer("/r:gone.ts", disk("x\n"), "gone.ts");
    CE.openBuffer("/r:kept.ts", disk("x\n"), "kept.ts");
    CE.updateBuffer("/r:kept.ts", () => ({ changes: { from: 0, insert: "y" } }));
    CE.releaseBuffers(new Set());
    expect(CE.dirtyKeys()).toContain("/r:kept.ts");
    expect(CE.openBuffer("/r:gone.ts", disk("fresh\n"), "gone.ts").state.doc.toString()).toBe("fresh\n");
  });
});

describe("language-server edits", () => {
  it("formats the text the server was asked about, and drops the edits when it changed meanwhile", async () => {
    const b = CE.openBuffer("/r:fmt.ts", disk("const a=1\n"), "fmt.ts", LSP);
    await tick();
    mb.lspFormat.mockResolvedValueOnce([edit(0, 7, 8, " = ")]);
    await b.lsp!.ctx.format();
    expect(b.state.doc.toString()).toBe("const a = 1\n");

    const answer = deferred<unknown>();
    mb.lspFormat.mockReturnValueOnce(answer.promise);
    const done = b.lsp!.ctx.format();
    await tick();
    CE.updateBuffer("/r:fmt.ts", () => ({ changes: { from: 0, insert: "// typed\n" } }));
    answer.resolve([edit(0, 0, 11, "const a = 2")]);
    await done;
    expect(b.state.doc.toString()).toBe("// typed\nconst a = 1\n");
    expect(b.lsp!.note).toMatch(/changed while it was being formatted/);
  });

  it("leaves an open file edited during a rename alone", async () => {
    const a = CE.openBuffer("/r:ren-a.ts", disk("let x = 1\n"), "ren-a.ts", LSP);
    const other = CE.openBuffer("/r:ren-b.ts", disk("x\n"), "ren-b.ts", LSP);
    await tick();
    const answer = deferred<unknown>();
    mb.lspRename.mockReturnValueOnce(answer.promise);
    const done = a.lsp!.ctx.rename({ line: 0, character: 4 }, "y");
    await tick();
    CE.updateBuffer("/r:ren-b.ts", () => ({ changes: { from: 0, insert: "z" } }));
    answer.resolve([
      { path: "/r/ren-a.ts", edits: [edit(0, 4, 5, "y")] },
      { path: "/r/ren-b.ts", edits: [edit(0, 0, 1, "y")] },
    ]);
    expect(await done).toMatch(/ren-b\.ts changed while renaming — not changed/);
    expect(a.state.doc.toString()).toBe("let y = 1\n");
    expect(other.state.doc.toString()).toBe("zx\n");
  });

  it("closes a file with its server only once the open is answered", async () => {
    const answer = deferred<LspFileState>();
    mb.lspOpen.mockReturnValueOnce(answer.promise);
    CE.openBuffer("/r:slow.ts", disk("x\n"), "slow.ts", LSP);
    CE.dropBuffer("/r:slow.ts");
    await tick();
    expect(mb.lspClose).not.toHaveBeenCalled();
    answer.resolve(READY);
    await tick();
    expect(mb.lspClose).toHaveBeenCalledWith("s", "slow.ts");
  });

  it("sends edits made while the server was starting once it's ready", async () => {
    const answer = deferred<LspFileState>();
    mb.lspOpen.mockReturnValueOnce(answer.promise);
    CE.openBuffer("/r:start.ts", disk("a\n"), "start.ts", LSP);
    CE.updateBuffer("/r:start.ts", () => ({ changes: { from: 0, insert: "b" } }));
    expect(mb.lspChange).not.toHaveBeenCalled();
    answer.resolve(READY);
    await tick();
    expect(mb.lspChange).toHaveBeenCalledWith("s", "start.ts", "ba\n");
  });

  it("asks nothing of a server that isn't running", async () => {
    const { hoverSource, completionSource } = await import("../src/renderer/lspEditor");
    const ctx = { sessionId: "s", rel: "a.md", abs: "/r/a.md", ready: () => false, flush: vi.fn(async () => {}), openLocation: () => {}, rename: vi.fn(), format: vi.fn(), report: vi.fn() };
    const state = EditorState.create({ doc: "some.text" });
    expect(await hoverSource(ctx)({ state } as never, 2)).toBeNull();
    expect(await completionSource(ctx)(new CompletionContext(state, 5, true))).toBeNull();
    expect(ctx.flush).not.toHaveBeenCalled();
    expect(ctx.report).not.toHaveBeenCalled();
    expect(mb.lspHover).not.toHaveBeenCalled();
    expect(mb.lspComplete).not.toHaveBeenCalled();
  });
});

describe("a file changing on disk under its buffer", () => {
  it("ignores a read older than what the buffer has", () => {
    const b = CE.openBuffer("/r:old.ts", disk("saved\n", 200), "old.ts");
    CE.diskRead("/r:old.ts", disk("before the save\n", 150));
    expect(b.state.doc.toString()).toBe("saved\n");
    expect(b.mtimeMs).toBe(200);
  });

  it("drops the choice once the disk matches what the buffer was measured against", () => {
    const b = CE.openBuffer("/r:race.ts", disk("one\n"), "race.ts");
    CE.updateBuffer("/r:race.ts", () => ({ changes: { from: 0, insert: "mine " } }));
    CE.diskRead("/r:race.ts", disk("theirs\n", 200));
    expect(b.conflict).toEqual({ text: "theirs\n", mtimeMs: 200, bom: false, lineBreak: "\n" });
    CE.diskRead("/r:race.ts", disk("one\n", 300));
    expect(b.conflict).toBeNull();
    expect(b.mtimeMs).toBe(300);
    expect(b.state.doc.toString()).toBe("mine one\n");
  });

  it("drops a stale choice when a clean buffer reloads", () => {
    const b = CE.openBuffer("/r:clean.ts", disk("one\n"), "clean.ts");
    b.conflict = { text: null, mtimeMs: 150, bom: false, lineBreak: "\n" };
    CE.diskRead("/r:clean.ts", disk("two\n", 200));
    expect(b.state.doc.toString()).toBe("two\n");
    expect(b.conflict).toBeNull();
  });

  it("takes the disk version with its own byte-order mark and line breaks", async () => {
    const { toFileText } = await import("../src/shared/editorText");
    const b = CE.openBuffer("/r:theirs.cs", disk("a\nb\n"), "theirs.cs");
    CE.updateBuffer("/r:theirs.cs", () => ({ changes: { from: 0, insert: "mine " } }));
    CE.diskRead("/r:theirs.cs", disk("﻿c\r\nd\r\n", 200));
    CE.takeDiskVersion("/r:theirs.cs");
    expect(b.conflict).toBeNull();
    expect(CE.dirtyKeys()).not.toContain("/r:theirs.cs");
    expect(toFileText(b.state.doc.toString(), b.lineBreak, b.bom)).toBe("﻿c\r\nd\r\n");
    expect(b.mtimeMs).toBe(200);
  });
});

describe("saving", () => {
  it("reports a write that fails outright, and keeps the edits unsaved", async () => {
    CE.openBuffer("/r:save.ts", disk("a\n"), "save.ts");
    CE.updateBuffer("/r:save.ts", () => ({ changes: { from: 0, insert: "b" } }));
    const r = await CE.saveBuffer("/r:save.ts", () => Promise.reject(new Error("disk full")), false);
    expect(r).toEqual({ error: "Error: disk full" });
    expect(CE.dirtyKeys()).toContain("/r:save.ts");
  });

  it("leaves a choice when someone else saved first, and saves when forced", async () => {
    const b = CE.openBuffer("/r:race2.ts", disk("a\n", 100), "race2.ts");
    CE.updateBuffer("/r:race2.ts", () => ({ changes: { from: 0, insert: "b" } }));
    expect(await CE.saveBuffer("/r:race2.ts", async () => ({ saved: false, conflict: true, mtimeMs: 200 }), false)).toBe("conflict");
    expect(b.conflict).toEqual({ text: null, mtimeMs: 200, bom: false, lineBreak: "\n" });
    const write = vi.fn(async (_text: string, _mtime: number | null) => ({ saved: true as const, mtimeMs: 300 }));
    expect(await CE.saveBuffer("/r:race2.ts", write, true)).toBe("saved");
    expect(write).toHaveBeenCalledWith("ba\n", null);
    expect(b.conflict).toBeNull();
    expect(CE.dirtyKeys()).not.toContain("/r:race2.ts");
  });
});

describe("files with lone carriage returns", () => {
  it("opens clean and saves with the file's own line breaks", async () => {
    const { toFileText, lineBreakOf } = await import("../src/shared/editorText");
    const b = CE.openBuffer("/r:classic.txt", disk("a\rb\r"), "classic.txt");
    expect(CE.dirtyKeys()).not.toContain("/r:classic.txt");
    expect(b.state.doc.lines).toBe(3);
    expect(b.lineBreak).toBe("\r");
    expect(toFileText(b.state.doc.toString(), b.lineBreak, b.bom)).toBe("a\rb\r");
    expect(lineBreakOf("a\r\nb\r\nc\n")).toBe("\r\n");
    expect(lineBreakOf("no breaks")).toBe("\n");
  });
});

describe("the debugger's marks", () => {
  const lines = <T extends RangeValue>(s: EditorState, field: StateField<{ marks: RangeSet<T> }>) => {
    const out: number[] = [];
    for (let it = s.field(field).marks.iter(); it.value; it.next()) out.push(s.doc.lineAt(it.from).number);
    return out;
  };

  it("keeps breakpoint dots on the debugger's lines while the text above them changes", () => {
    let s = EditorState.create({ doc: "a\nb\nc\nd", extensions: [CE.bpField] });
    s = s.update({ effects: CE.setBreakpoints.of([3]) }).state;
    expect(lines(s, CE.bpField)).toEqual([3]);
    s = s.update({ changes: { from: 0, insert: "new\n" } }).state;
    expect(lines(s, CE.bpField)).toEqual([3]);
    expect(s.field(CE.bpField).lines).toEqual([3]);
  });

  it("keeps the paused-line highlight on the line the debugger stopped at", () => {
    let s = EditorState.create({ doc: "a\nb\nc\nd", extensions: [CE.pausedField] });
    s = s.update({ effects: CE.setPaused.of([2]) }).state;
    s = s.update({ changes: { from: 0, insert: "new\n" } }).state;
    expect(lines(s, CE.pausedField)).toEqual([2]);
    s = s.update({ effects: CE.setPaused.of([]) }).state;
    expect(lines(s, CE.pausedField)).toEqual([]);
  });
});
