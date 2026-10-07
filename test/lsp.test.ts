import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { afterAll, describe, expect, it } from "vitest";
import { LspManager, completionItems, hoverText, locations, workspaceEdits } from "../src/main/lsp/manager";
import { SERVERS, serverFor, type LspServerSpec } from "../src/main/lsp/servers";
import { applyTextEdits, lineStarts, offsetAt } from "../src/shared/textEdits";
import type { LspDiagnostic, LspServerId } from "../src/shared/types";
import { tempDir, write } from "./helpers";

describe("text edits", () => {
  it("finds offsets by line and UTF-16 column, whatever the line breaks", () => {
    const t = "ab\r\ncd\ref\ngh";
    const s = lineStarts(t);
    expect(s).toEqual([0, 4, 7, 10]);
    expect(offsetAt(t, s, { line: 1, character: 1 })).toBe(5);
    expect(offsetAt(t, s, { line: 0, character: 99 })).toBe(2); // past the end: the line's end, not its break
    expect(offsetAt(t, s, { line: 9, character: 0 })).toBe(t.length);
  });
  it("applies edits back to front, same-place inserts in the order given", () => {
    const at = (line: number, character: number) => ({ line, character });
    const edits = [
      { range: { start: at(0, 0), end: at(0, 0) }, newText: "A" },
      { range: { start: at(0, 0), end: at(0, 0) }, newText: "B" },
      { range: { start: at(1, 0), end: at(1, 3) }, newText: "xyz" },
    ];
    expect(applyTextEdits("one\ntwo\n", edits)).toBe("ABone\nxyz\n");
  });
});

describe("reading server replies", () => {
  it("flattens hover contents to Markdown", () => {
    expect(hoverText({ kind: "markdown", value: "**x**" })).toBe("**x**");
    expect(hoverText([{ language: "ts", value: "let x: number" }, "doc"])).toBe("```ts\nlet x: number\n```\n\ndoc");
    expect(hoverText(null)).toBe("");
  });
  it("takes completions from a list or a CompletionList, with their edit range", () => {
    const range = { start: { line: 0, character: 2 }, end: { line: 0, character: 4 } };
    expect(completionItems({ items: [{ label: "foo", kind: 3, textEdit: { range, newText: "foo()" } }] })).toEqual([{ label: "foo", kind: "function", insertText: "foo()", range }]);
    expect(completionItems([{ label: "bar" }])).toEqual([{ label: "bar", insertText: "bar" }]);
  });
  it("narrows completions to the word being typed, starts first, before capping", () => {
    const many = [...Array.from({ length: 300 }, (_, i) => ({ label: `zz${i}`, sortText: "0" })), { label: "segregate", sortText: "1" }, { label: "greet", sortText: "2" }];
    expect(completionItems(many, "gre").map((i) => i.label)).toEqual(["greet", "segregate"]);
    expect(completionItems(many)).toHaveLength(200);
  });
  it("reads locations and location links", () => {
    const r = { start: { line: 4, character: 2 }, end: { line: 4, character: 5 } };
    expect(locations({ uri: "file:///a/b.ts", range: r })).toEqual([{ path: "/a/b.ts", line: 5, character: 2 }]);
    expect(locations([{ targetUri: "file:///c.ts", targetRange: r, targetSelectionRange: r }])).toEqual([{ path: "/c.ts", line: 5, character: 2 }]);
  });
  it("collects a rename's edits per file, and refuses file operations", () => {
    const e = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "y" };
    const f = { ...e, newText: "z" };
    expect(workspaceEdits({ changes: { "file:///a.ts": [e, f] } })).toEqual([{ path: "/a.ts", edits: [e, f] }]);
    expect(() => workspaceEdits({ documentChanges: [{ kind: "rename", oldUri: "file:///a", newUri: "file:///b" }] })).toThrow(/rename a file/);
  });
  it("applies a rename sent in both forms once, from documentChanges", () => {
    const e = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "y" };
    expect(workspaceEdits({ changes: { "file:///a.ts": [e] }, documentChanges: [{ textDocument: { uri: "file:///a.ts", version: 1 }, edits: [e] }] })).toEqual([{ path: "/a.ts", edits: [e] }]);
  });
  it("picks the server by extension", () => {
    expect(serverFor("/x/a.tsx")).toMatchObject({ languageId: "typescriptreact", spec: { id: "typescript" } });
    expect(serverFor("/x/a.py")?.spec.id).toBe("python");
    expect(serverFor("/x/a.cs")?.spec.id).toBe("csharp");
    expect(serverFor("/x/a.md")).toBeNull();
  });
});

describe("asking about a file that has no ready server", () => {
  it("answers hover and completions with nothing, and other requests with why", async () => {
    const m = new LspManager({ dir: tempDir("lsp-none"), env: () => ({}), which: async () => null, node: process.execPath, onDiagnostics: () => {}, onStatus: () => {} });
    const at = { line: 0, character: 0 };
    expect(await m.hover("/r", "/r/readme.md", at)).toBe("");
    expect(await m.hover("/r", "/r/a.ts", at)).toBe("");
    expect(await m.completion("/r", "/r/a.py", at, "pr")).toEqual([]);
    await expect(m.definition("/r", "/r/a.ts", at)).rejects.toThrow(/isn't open with a language server/);
    expect(() => m.close("/r", "/r/a.ts")).not.toThrow();
  });
});

/**
 * A pull-diagnostics server scripted by the `mode` file in its folder; a file
 * whose text says ERROR has one problem. "out-of-order": the first request
 * after an edit is held, a refresh asks for another, and the held one is
 * answered last, with the problems from before the edit. "abandon": a
 * refresh's request is held until the edit, then abandoned (ContentModified),
 * and the edit's own first request fails (ServerCancelled).
 */
const FAKE_SERVER = String.raw`
const fs = require("fs");
const mode = fs.readFileSync("mode", "utf8").trim();
const send = (m) => {
  const b = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...m }));
  process.stdout.write("Content-Length: " + b.length + "\r\n\r\n");
  process.stdout.write(b);
};
const docs = {};
let n = 0, held = null, ids = 1000;
const full = (id, text) => send({ id, result: { kind: "full", items: text.includes("ERROR") ? [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: 1, message: "an error" }] : [] } });
const refresh = () => send({ id: ids++, method: "workspace/diagnostic/refresh" });
function handle(m) {
  if (m.method === "initialize") return send({ id: m.id, result: { capabilities: { textDocumentSync: 1, diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false } } } });
  if (m.method === "shutdown") return send({ id: m.id, result: null });
  if (m.method === "exit") process.exit(0);
  if (m.method === "textDocument/didOpen") docs[m.params.textDocument.uri] = m.params.textDocument.text;
  if (m.method === "textDocument/didChange") {
    docs[m.params.textDocument.uri] = m.params.contentChanges[0].text;
    if (mode === "abandon" && held) send({ id: held.id, error: { code: -32801, message: "content modified" } });
  }
  if (m.method !== "textDocument/diagnostic") return;
  const text = docs[m.params.textDocument.uri];
  n++;
  if (mode === "out-of-order" && n === 2) return (held = m), refresh();
  if (mode === "out-of-order" && n === 3) return full(m.id, text), full(held.id, "ERROR from before the edit");
  if (mode === "abandon" && n === 1) return full(m.id, text), refresh();
  if (mode === "abandon" && n === 2) return (held = m), send({ method: "window/showMessage", params: { type: 1, message: "holding" } });
  if (mode === "abandon" && n === 3) return send({ id: m.id, error: { code: -32802, message: "busy" } });
  full(m.id, text);
}
let buf = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const h = buf.indexOf("\r\n\r\n");
    if (h < 0) return;
    const len = Number(/Content-Length: (\d+)/i.exec(buf.subarray(0, h).toString())[1]);
    if (buf.length < h + 4 + len) return;
    const m = JSON.parse(buf.subarray(h + 4, h + 4 + len).toString());
    buf = buf.subarray(h + 4 + len);
    handle(m);
  }
});
`;

describe("pulled problems", () => {
  const dir = tempDir("lsp-fake");
  const spec: LspServerSpec = {
    id: "fake" as LspServerId,
    label: "Fake",
    languages: { ".fake": "fake" },
    pinned: () => ({ name: "fake", version: "1", url: "https://example.invalid/fake.tgz", marker: "server.js" }),
    command: (d) => ({ cmd: process.execPath, args: [path.join(d, "server.js")], env: { ELECTRON_RUN_AS_NODE: "1" } }),
  };
  fs.mkdirSync(path.join(dir, "fake-1"), { recursive: true });
  fs.writeFileSync(path.join(dir, "fake-1", "server.js"), FAKE_SERVER);
  SERVERS.push(spec);
  afterAll(() => {
    SERVERS.splice(SERVERS.indexOf(spec), 1);
  });

  const run = async (mode: string, edit: (m: LspManager, root: string, file: string, said: (msg: string) => Promise<void>) => Promise<void>) => {
    const seen: string[][] = [];
    const messages: string[] = [];
    const m = new LspManager({
      dir,
      env: () => ({ PATH: process.env.PATH ?? "/usr/bin:/bin" }),
      which: async () => null,
      node: process.execPath,
      onDiagnostics: (_f, d) => seen.push(d.map((x) => x.message)),
      onStatus: (st) => st.message && messages.push(st.message),
    });
    const until = async (cond: () => boolean, what: string) => {
      for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 50));
      if (!cond()) throw new Error(`never ${what}: ${JSON.stringify({ seen, messages })}`);
    };
    const root = tempDir(`lsp-${mode}`);
    fs.writeFileSync(path.join(root, "mode"), mode);
    const file = path.join(root, "a.fake");
    try {
      expect(await m.open(root, file, "ERROR here")).toMatchObject({ state: "ready" });
      await until(() => seen.length > 0, "saw the first problems");
      expect(seen.at(-1)).toEqual(["an error"]);
      await edit(m, root, file, (msg) => until(() => messages.includes(msg), `said ${msg}`));
      await until(() => seen.at(-1)?.length === 0, "cleared the problems");
      await new Promise((r) => setTimeout(r, 1500)); // anything still to come
      expect(seen.at(-1)).toEqual([]);
      expect(messages.filter((x) => x.startsWith("Couldn't read problems"))).toEqual([]);
    } finally {
      m.stopAll();
    }
  };

  it("uses only the newest request's answer when answers arrive out of order", { timeout: 20_000 }, async () => {
    await run("out-of-order", async (m, root, file) => m.change(root, file, "all fixed"));
  });

  it("drops an abandoned request for old text and keeps asking about the new text", { timeout: 20_000 }, async () => {
    await run("abandon", async (m, root, file, said) => {
      await said("holding");
      m.change(root, file, "all fixed");
    });
  });
});

// Real servers, downloaded once into a cache that outlives the per-file temp HOME.
const CACHE = path.join(os.tmpdir(), "mockingbird-test-lsp-cache");
const has = (bin: string) => {
  try {
    execFileSync("/usr/bin/which", [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

describe("real language servers", () => {
  const diags = new Map<string, LspDiagnostic[]>();
  const waiters: (() => void)[] = [];
  // what the servers said, for a failure message
  const statuses: string[] = [];
  const m = new LspManager({
    dir: CACHE,
    env: () => ({ ...process.env }) as Record<string, string>,
    which: async (bin) => (has(bin) ? bin : null),
    node: process.execPath,
    onDiagnostics: (file, d) => {
      diags.set(file, d);
      waiters.splice(0).forEach((w) => w());
    },
    onStatus: (st) => statuses.push(`${st.server} ${st.state}${st.message ? `: ${st.message}` : ""}`),
  });
  afterAll(() => m.stopAll());
  const problems = async (file: string, test: (d: LspDiagnostic[]) => boolean, ms = 30_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const d = diags.get(file);
      if (d && test(d)) return d;
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 500);
      });
    }
    throw new Error(`No matching problems for ${file}: ${JSON.stringify(diags.get(file))}; servers said: ${JSON.stringify(statuses.slice(-10))}`);
  };

  it("TypeScript: problems, hover, completions, definition, rename and formatting", { timeout: 180_000 }, async () => {
    await m.install("typescript", () => {});
    const root = tempDir("tsproj");
    write(root, {
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, target: "es2022", module: "esnext" } }),
      "util.ts": "export function greet(name: string): string {\n  return `hi ${name}`;\n}\n",
      "main.ts": 'import { greet } from "./util";\nconst n: number = "x";\ngreet("a");\n',
    });
    const main = path.join(root, "main.ts");
    const text = fs.readFileSync(main, "utf8");
    expect(await m.open(root, main, text)).toMatchObject({ state: "ready", server: { id: "typescript" } });
    const d = await problems(main, (x) => x.length > 0);
    expect(d[0]).toMatchObject({ severity: "error", range: { start: { line: 1 } } });
    expect(await m.hover(root, main, { line: 2, character: 1 })).toContain("greet(name: string): string");
    const items = await m.completion(root, main, { line: 2, character: 2 }, "gr");
    expect(items[0].label).toBe("greet");
    const def = await m.definition(root, main, { line: 2, character: 1 });
    expect(def[0]).toMatchObject({ path: path.join(root, "util.ts"), line: 1 }); // in the root's own spelling, as sent
    const edits = await m.rename(root, main, { line: 2, character: 1 }, "welcome");
    expect(edits.map((e) => path.basename(e.path)).sort()).toEqual(["main.ts", "util.ts"]);
    // fixing the error clears it — unsaved: the server answers from the open text
    m.change(root, main, 'import { greet } from "./util";\nconst n: number = 1;\ngreet("a");\n');
    await problems(main, (x) => x.every((p) => p.severity !== "error"));
    m.change(root, main, "const  x=1;\n");
    const fmt = await m.format(root, main, { tabSize: 2, insertSpaces: true });
    expect(applyTextEdits("const  x=1;\n", fmt ?? [])).toBe("const x = 1;\n");
    m.close(root, main);
  });

  it("TypeScript: keeps up with edits while files are written beside the project", { timeout: 180_000 }, async () => {
    await m.install("typescript", () => {});
    const root = tempDir("tsburst");
    write(root, {
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, target: "es2022", module: "esnext" } }),
      "main.ts": 'const n: number = "x";\n',
    });
    const main = path.join(root, "main.ts");
    expect(await m.open(root, main, fs.readFileSync(main, "utf8"))).toMatchObject({ state: "ready" });
    await problems(main, (x) => x.some((p) => p.severity === "error"));
    // a burst of writes outside the project: left to watch for itself, the
    // server watched the whole temp folder and dropped the edit that follows
    const beside = path.join(path.dirname(root), "burst");
    fs.mkdirSync(beside);
    for (let i = 0; i < 20_000; i++) fs.writeFileSync(path.join(beside, `f${i}.txt`), "x");
    m.change(root, main, "const n: number = 1;\n");
    await problems(main, (x) => x.every((p) => p.severity !== "error"), 15_000);
    m.close(root, main);
  });

  it("TypeScript: hears about files changed on disk outside the editor", { timeout: 180_000 }, async () => {
    await m.install("typescript", () => {});
    const root = tempDir("tsdisk");
    write(root, {
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, target: "es2022", module: "esnext" } }),
      "util.ts": "export function greet(name: string): string {\n  return name;\n}\n",
      "main.ts": 'import { greet } from "./util";\ngreet("a");\n',
    });
    const main = path.join(root, "main.ts");
    expect(await m.open(root, main, fs.readFileSync(main, "utf8"))).toMatchObject({ state: "ready" });
    await problems(main, (x) => x.every((p) => p.severity !== "error"));
    // util.ts changes on disk (an agent's edit; it isn't open in the editor): main.ts's call is now wrong
    fs.writeFileSync(path.join(root, "util.ts"), "export function greet(n: number): number {\n  return n;\n}\n");
    await problems(main, (x) => x.some((p) => p.severity === "error"));
    // and a file created on disk is found: main.ts can import it
    m.change(root, main, 'import { later } from "./later";\nlater();\n');
    await problems(main, (x) => x.some((p) => /later/.test(p.message)));
    fs.writeFileSync(path.join(root, "later.ts"), "export function later(): void {}\n");
    await problems(main, (x) => x.every((p) => p.severity !== "error"));
    m.close(root, main);
  });

  it("keeps a file open until its last editor closes it, including one closed while the server starts", { timeout: 180_000 }, async () => {
    await m.install("typescript", () => {});
    const root = tempDir("tsrefs");
    write(root, { "a.ts": "export const answer = 42;\n" });
    const file = path.join(root, "a.ts");
    const text = fs.readFileSync(file, "utf8");
    const isOpen = () => {
      try {
        m.change(root, file, text);
        return true;
      } catch {
        return false;
      }
    };
    const opening = m.open(root, file, text);
    m.close(root, file);
    expect(await opening).toMatchObject({ state: "ready" });
    expect(isOpen()).toBe(false);
    // a file tab and a diff tab of the same file
    await m.open(root, file, text);
    await m.open(root, file, text);
    m.close(root, file);
    expect(isOpen()).toBe(true);
    m.close(root, file);
    expect(isOpen()).toBe(false);
  });

  it("starts a fresh server for a file opened while the last one stops for idleness", { timeout: 180_000 }, async () => {
    await m.install("typescript", () => {});
    const root = tempDir("tsidle");
    write(root, { "a.ts": "export const answer = 42;\n" });
    const file = path.join(root, "a.ts");
    const text = fs.readFileSync(file, "utf8");
    await m.open(root, file, text);
    m.close(root, file);
    const stopping = (m as any).servers.get(`typescript:${root}`);
    void (m as any).stop(stopping);
    expect(await m.open(root, file, text)).toMatchObject({ state: "ready" });
    // past the old server's shutdown and exit
    await new Promise((r) => setTimeout(r, 1500));
    expect(stopping.conn.isClosed).toBe(true);
    expect(await m.hover(root, file, { line: 0, character: 14 })).toContain("answer");
    m.close(root, file);
  });

  it("Python: problems from pyright", { timeout: 180_000 }, async () => {
    await m.install("python", () => {});
    const root = tempDir("pyproj");
    write(root, { "app.py": "def add(a: int, b: int) -> int:\n    return a + b\n\nadd(1, 'x')\n" });
    const file = path.join(root, "app.py");
    expect(await m.open(root, file, fs.readFileSync(file, "utf8"))).toMatchObject({ state: "ready" });
    const d = await problems(file, (x) => x.some((p) => p.severity === "error"), 60_000);
    expect(d.find((p) => p.severity === "error")!.range.start.line).toBe(3);
    expect(await m.hover(root, file, { line: 3, character: 1 })).toContain("def add");
    expect(await m.format(root, file, { tabSize: 4, insertSpaces: true })).toBeNull(); // pyright doesn't format
    m.close(root, file);
  });

  // csharp-ls needs the .NET 10 runtime and SDK; CI runners don't carry that version
  it.skipIf(!has("dotnet") || !!process.env.CI)("C#: problems from csharp-ls in a project", { timeout: 300_000 }, async () => {
    await m.install("csharp", () => {});
    const root = tempDir("csproj");
    write(root, {
      "app.csproj": '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>',
      "Program.cs": "int x = \"no\";\nSystem.Console.WriteLine(x);\n",
    });
    const file = path.join(root, "Program.cs");
    expect(await m.open(root, file, fs.readFileSync(file, "utf8"))).toMatchObject({ state: "ready" });
    const d = await problems(file, (x) => x.some((p) => p.severity === "error"), 240_000);
    expect(d.some((p) => /convert|string/i.test(p.message))).toBe(true);
    m.close(root, file);
  });
});
