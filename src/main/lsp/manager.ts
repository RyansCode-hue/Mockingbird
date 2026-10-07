import * as fs from "fs";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { ensureAdapter, installDir } from "../dap/adapters";
import { spawnRpcProcess } from "../rpc";
import { LspConnection } from "./connection";
import { WatchedFiles } from "./watchedFiles";
import { projectPython, SERVERS, serverFor, type LspServerSpec } from "./servers";
import type { LspCompletion, LspDiagnostic, LspFileEdits, LspFileState, LspLocation, LspServerId } from "../../shared/types";
import type { LspPosition, LspTextEdit } from "../../shared/textEdits";

const IDLE_MS = 10 * 60_000;
const PULL_DELAY_MS = 400;
const PULL_ATTEMPTS = 3;
const MAX_COMPLETIONS = 200;

const SEVERITY: Record<number, LspDiagnostic["severity"]> = { 1: "error", 2: "warning", 3: "info", 4: "hint" };
const KIND: Record<number, string> = { 1: "text", 2: "method", 3: "function", 4: "constructor", 5: "field", 6: "variable", 7: "class", 8: "interface", 9: "module", 10: "property", 11: "unit", 12: "value", 13: "enum", 14: "keyword", 15: "snippet", 16: "color", 17: "file", 18: "reference", 19: "folder", 20: "enum-member", 21: "constant", 22: "struct", 23: "event", 24: "operator", 25: "type-parameter" };

/** What Mockingbird's editor supports, as the protocol's client capabilities. */
const CLIENT_CAPABILITIES = {
  general: { positionEncodings: ["utf-16"] },
  textDocument: {
    synchronization: { didSave: true, dynamicRegistration: false },
    hover: { contentFormat: ["markdown", "plaintext"] },
    completion: { completionItem: { snippetSupport: false, documentationFormat: ["markdown", "plaintext"], labelDetailsSupport: true }, contextSupport: true },
    definition: { linkSupport: true },
    rename: { prepareSupport: false },
    formatting: {},
    publishDiagnostics: { relatedInformation: false },
    diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
  },
  // watching is done here (see watchedFiles.ts), so a server never runs its own watcher
  workspace: { configuration: true, workspaceFolders: true, applyEdit: false, workspaceEdit: { documentChanges: true }, diagnostics: { refreshSupport: true }, didChangeWatchedFiles: { dynamicRegistration: true, relativePatternSupport: true } },
  window: { workDoneProgress: false, showMessage: {} },
};

interface Doc {
  uri: string;
  languageId: string;
  version: number;
  /** The editors that have it open: the server is told it closed when the last one closes. */
  refs: number;
}

interface Server {
  spec: LspServerSpec;
  root: string;
  conn: LspConnection;
  caps: any;
  ready: Promise<void>;
  docs: Map<string, Doc>;
  pulls: Map<string, NodeJS.Timeout>;
  /** Per file: the newest diagnostics request sent, the only one whose answer is used. */
  latestPull: Map<string, number>;
  idle: NodeJS.Timeout | null;
  /** The files it asked to be told about, watched in its folder. */
  watched: WatchedFiles;
}

export interface LspDeps {
  dir: string;
  /** The environment servers run in (the user's PATH, so dotnet and python resolve). */
  env: () => Record<string, string>;
  /** Absolute path of a command, or null when it isn't installed. */
  which: (bin: string) => Promise<string | null>;
  /** The Node that runs JavaScript servers (Electron's own, as Node). */
  node: string;
  onDiagnostics: (file: string, diagnostics: LspDiagnostic[]) => void;
  onStatus: (s: { server: LspServerId; root: string; state: "starting" | "ready" | "failed" | "stopped"; message?: string }) => void;
}

const uriOf = (file: string) => pathToFileURL(file).href;
const fileOf = (uri: string) => (uri.startsWith("file:") ? fileURLToPath(uri) : uri);

/** Hover contents (MarkupContent, MarkedString or a list of them) as Markdown. */
export function hoverText(contents: any): string {
  if (!contents) return "";
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) return contents.map(hoverText).filter(Boolean).join("\n\n");
  if (typeof contents.value === "string") return contents.language ? "```" + contents.language + "\n" + contents.value + "\n```" : contents.value;
  return "";
}

/**
 * A completion response (a list, or CompletionList) as the editor's items.
 * Servers send everything in scope and leave filtering to the client, so the
 * word being typed narrows the list (matches at the start first, then the
 * server's own order) before it's capped.
 */
export function completionItems(r: any, prefix = ""): LspCompletion[] {
  const all: any[] = Array.isArray(r) ? r : r?.items ?? [];
  const p = prefix.toLowerCase();
  const key = (it: any) => String(it.filterText ?? it.label).toLowerCase();
  const items = (p ? all.filter((it) => key(it).includes(p)) : all)
    .map((it, i) => ({ it, i, starts: p ? key(it).startsWith(p) : true }))
    .sort((a, b) => Number(b.starts) - Number(a.starts) || String(a.it.sortText ?? "").localeCompare(String(b.it.sortText ?? "")) || a.i - b.i)
    .map((x) => x.it);
  return items.slice(0, MAX_COMPLETIONS).map((it) => {
    const te = it.textEdit;
    const range = te?.range ?? te?.replace ?? te?.insert;
    return {
      label: String(it.label),
      kind: KIND[it.kind] ?? undefined,
      detail: it.detail ?? it.labelDetails?.description ?? undefined,
      insertText: te?.newText ?? it.insertText ?? String(it.label),
      ...(range ? { range } : {}),
      ...(it.sortText ? { sortText: it.sortText } : {}),
    };
  });
}

/** Definition results (Location, Location[] or LocationLink[]) as absolute places. */
export function locations(r: any): LspLocation[] {
  const list: any[] = !r ? [] : Array.isArray(r) ? r : [r];
  return list
    .map((l) => {
      const uri = l.targetUri ?? l.uri;
      const range = l.targetSelectionRange ?? l.targetRange ?? l.range;
      return uri && range ? { path: fileOf(uri), line: range.start.line + 1, character: range.start.character } : null;
    })
    .filter((x): x is LspLocation => !!x);
}

/** A rename's WorkspaceEdit as edits per file. File creations, renames and deletions aren't applied: they're refused. */
export function workspaceEdits(w: any): LspFileEdits[] {
  if (!w) return [];
  const out = new Map<string, LspFileEdits>();
  const add = (uri: string, edits: LspTextEdit[]) => {
    const p = fileOf(uri);
    const cur = out.get(p) ?? { path: p, edits: [] };
    cur.edits.push(...edits.map((e) => ({ range: e.range, newText: e.newText })));
    out.set(p, cur);
  };
  // a server may send both forms of the same edit; documentChanges is the one to use when present
  if (w.documentChanges) {
    for (const dc of w.documentChanges) {
      if (dc.kind) throw new Error(`The rename would ${dc.kind} a file, which Mockingbird doesn't do — rename it in the session instead`);
      add(dc.textDocument.uri, dc.edits);
    }
  } else for (const [uri, edits] of Object.entries(w.changes ?? {})) add(uri, edits as LspTextEdit[]);
  return [...out.values()];
}

export function diagnostics(list: any[]): LspDiagnostic[] {
  return (list ?? []).map((d) => ({
    range: d.range,
    severity: SEVERITY[d.severity] ?? "error",
    message: String(d.message ?? ""),
    ...(d.source ? { source: String(d.source) } : {}),
  }));
}

/**
 * Language servers for the editor, one per language per session folder,
 * started when a file of that language opens and stopped 10 minutes after its
 * last file closes. Documents are synced whole on each change.
 */
export class LspManager {
  private servers = new Map<string, Server>();
  private starting = new Map<string, Promise<Server>>();
  /** Per root and file: opens still waiting for their server, and the closes that arrived for them meanwhile. */
  private opening = new Map<string, { opens: number; closes: number }>();
  private pullSeq = 0;

  constructor(private deps: LspDeps) {}

  private key = (spec: LspServerSpec, root: string) => `${spec.id}:${root}`;

  installed(spec: LspServerSpec): boolean {
    const p = spec.pinned();
    return fs.existsSync(path.join(installDir(p, this.deps.dir), p.marker));
  }

  /** Download and unpack a server (pinned version, checksum checked). */
  async install(id: LspServerId, onProgress: (msg: string) => void): Promise<void> {
    const spec = SERVERS.find((s) => s.id === id);
    if (!spec) throw new Error(`No language server "${id}"`);
    await ensureAdapter(spec.pinned(), onProgress, this.deps.dir);
  }

  /** Start (or reuse) the server for a folder, initialized and ready. */
  private async server(spec: LspServerSpec, root: string): Promise<Server> {
    const key = this.key(spec, root);
    const live = this.servers.get(key);
    if (live && !live.conn.isClosed) {
      await live.ready;
      return live;
    }
    let p = this.starting.get(key);
    if (!p) {
      p = this.start(spec, root).finally(() => this.starting.delete(key));
      this.starting.set(key, p);
    }
    return p;
  }

  private async start(spec: LspServerSpec, root: string): Promise<Server> {
    const dir = installDir(spec.pinned(), this.deps.dir);
    const dotnet = spec.requires?.bin === "dotnet" ? await this.deps.which("dotnet") : null;
    const { cmd, args, env } = spec.command(dir, { node: this.deps.node, dotnet });
    this.deps.onStatus({ server: spec.id, root, state: "starting" });
    const { conn } = spawnRpcProcess(cmd, args, { cwd: root, env: { ...this.deps.env(), ...(env ?? {}) }, name: `${spec.label} language server` }, (input, output, onClose) => new LspConnection(input, output, onClose));
    const watched = new WatchedFiles(root, (changes) => conn.notify("workspace/didChangeWatchedFiles", { changes }));
    const s: Server = { spec, root, conn, caps: {}, ready: Promise.resolve(), docs: new Map(), pulls: new Map(), latestPull: new Map(), idle: null, watched };
    conn.on("close", (reason: string) => {
      watched.dispose();
      for (const t of s.pulls.values()) clearTimeout(t);
      if (s.idle) clearTimeout(s.idle);
      const key = this.key(spec, root);
      if (this.servers.get(key) === s) this.servers.delete(key);
      // one stopped while idle may have a successor for this folder already, which reports for itself
      if (this.servers.has(key)) return;
      // its problems are no longer known
      for (const file of s.docs.keys()) this.deps.onDiagnostics(file, []);
      this.deps.onStatus({ server: spec.id, root, state: s.docs.size ? "failed" : "stopped", message: reason });
    });
    conn.onRequest = async (method, params) => {
      switch (method) {
        case "workspace/configuration":
          return (params?.items ?? []).map((it: { section?: string }) => this.configuration(spec, root, it.section));
        case "workspace/workspaceFolders":
          return [{ uri: uriOf(root), name: path.basename(root) }];
        case "workspace/diagnostic/refresh":
          for (const file of s.docs.keys()) this.schedulePull(s, file);
          return null;
        case "client/registerCapability":
          for (const r of params?.registrations ?? []) {
            if (r?.method === "workspace/didChangeWatchedFiles") watched.register(String(r.id), r.registerOptions?.watchers ?? []);
          }
          return null;
        case "client/unregisterCapability":
          // the protocol spells it "unregisterations"
          for (const r of params?.unregisterations ?? params?.unregistrations ?? []) watched.unregister(String(r?.id));
          return null;
        case "window/workDoneProgress/create":
        case "window/showMessageRequest":
          return null;
        case "workspace/applyEdit":
          return { applied: false, failureReason: "Mockingbird applies edits itself" };
        default:
          throw Object.assign(new Error(`Mockingbird doesn't handle ${method}`), { code: -32601 });
      }
    };
    conn.on("notification", (method: string, params: any) => {
      if (method === "textDocument/publishDiagnostics" && params?.uri) this.deps.onDiagnostics(fileOf(params.uri), diagnostics(params.diagnostics));
      else if (method === "window/showMessage" && params?.type === 1) this.deps.onStatus({ server: spec.id, root, state: "ready", message: String(params.message) });
    });
    s.ready = (async () => {
      const init = await conn.request(
        "initialize",
        {
          processId: process.pid,
          clientInfo: { name: "Mockingbird" },
          rootUri: uriOf(root),
          rootPath: root,
          workspaceFolders: [{ uri: uriOf(root), name: path.basename(root) }],
          capabilities: CLIENT_CAPABILITIES,
        },
        // a large C# solution takes a while to load
        spec.id === "csharp" ? 180_000 : 60_000
      );
      s.caps = init?.capabilities ?? {};
      conn.notify("initialized", {});
    })();
    this.servers.set(this.key(spec, root), s);
    try {
      await s.ready;
    } catch (err) {
      conn.close((err as Error).message);
      throw err;
    }
    this.deps.onStatus({ server: spec.id, root, state: "ready" });
    return s;
  }

  /** Settings a server asks for. pyright gets the project's own Python, so its imports resolve. */
  private configuration(spec: LspServerSpec, root: string, section?: string): unknown {
    if (spec.id === "python" && section === "python") {
      const py = projectPython(root);
      return py ? { pythonPath: py } : {};
    }
    // rename renames the symbol everywhere, rather than aliasing it at an import
    const ts = { preferences: { useAliasesForRenames: false } };
    if (spec.id === "typescript" && (section === "typescript" || section === "javascript")) return ts;
    if (spec.id === "typescript" && !section) return { typescript: ts, javascript: ts };
    return {};
  }

  /**
   * Ask a pull-diagnostics server for a file's problems once typing settles.
   * Only the newest request speaks for the file: an answer or error for one
   * that's been overtaken — the text changed, or a newer request went out
   * (answers can arrive out of order) — is dropped, since the newer one will
   * answer. A failed request (a server busy rebuilding may abandon it) is
   * asked again a few times before the failure is reported.
   */
  private schedulePull(s: Server, file: string, attempt = 0): void {
    if (!s.caps.diagnosticProvider) return; // this server pushes its problems instead
    clearTimeout(s.pulls.get(file));
    s.pulls.set(
      file,
      setTimeout(async () => {
        s.pulls.delete(file);
        const doc = s.docs.get(file);
        if (!doc) return;
        const version = doc.version;
        const seq = ++this.pullSeq;
        s.latestPull.set(file, seq);
        const current = () => s.docs.get(file) === doc && doc.version === version && s.latestPull.get(file) === seq;
        try {
          const r = await s.conn.request("textDocument/diagnostic", { textDocument: { uri: doc.uri } });
          if (current() && r?.kind === "full") this.deps.onDiagnostics(file, diagnostics(r.items));
        } catch (err) {
          if (s.conn.isClosed || !current()) return; // the close says why; a newer request answers instead
          if (attempt < PULL_ATTEMPTS - 1) return this.schedulePull(s, file, attempt + 1);
          this.deps.onStatus({ server: s.spec.id, root: s.root, state: "ready", message: `Couldn't read problems: ${(err as Error).message}` });
        }
      }, attempt ? 1000 : PULL_DELAY_MS)
    );
  }

  /** The server and document for an open file; null when it isn't open (yet, or any more) with a ready server. */
  private lookup(root: string, file: string): { s: Server; doc: Doc } | null {
    const sf = serverFor(file);
    const s = sf && this.servers.get(this.key(sf.spec, root));
    const doc = s?.docs.get(file);
    return s && doc ? { s, doc } : null;
  }

  private find(root: string, file: string): { s: Server; doc: Doc } {
    const found = this.lookup(root, file);
    if (!found) throw new Error(`${path.basename(file)} isn't open with a language server`);
    return found;
  }

  /** The folder's server for a file, started and ready; or why the file can't have one. */
  private async acquire(sf: { spec: LspServerSpec }, root: string): Promise<Server | LspFileState> {
    const server = { id: sf.spec.id, label: sf.spec.label };
    if (sf.spec.requires && !(await this.deps.which(sf.spec.requires.bin))) return { server, state: "missing", message: sf.spec.requires.why };
    if (!this.installed(sf.spec)) {
      const p = sf.spec.pinned();
      return { server, state: "install", message: `${p.name} ${p.version}` };
    }
    try {
      return await this.server(sf.spec, root);
    } catch (err) {
      return { server, state: "failed", message: (err as Error).message };
    }
  }

  /**
   * A file opened in an editor: start its server if it's installed, and send
   * the text. Several editors may have the same file open; each open that
   * answers "ready", or hasn't answered yet, is balanced by one close.
   */
  async open(root: string, file: string, text: string): Promise<LspFileState> {
    const sf = serverFor(file);
    if (!sf) return { server: null, state: "none" };
    const key = `${root}\0${file}`;
    const flight = this.opening.get(key) ?? { opens: 0, closes: 0 };
    flight.opens++;
    this.opening.set(key, flight);
    let got: Server | LspFileState;
    let cancelled = false;
    try {
      got = await this.acquire(sf, root);
    } finally {
      // a close that arrived while the server started cancels this open
      cancelled = flight.closes > 0;
      if (cancelled) flight.closes--;
      if (!--flight.opens) this.opening.delete(key);
    }
    if (!("conn" in got)) return got;
    const s = got;
    const server = { id: sf.spec.id, label: sf.spec.label };
    if (cancelled) {
      if (!s.docs.size) this.idleLater(s);
      return { server, state: "ready" };
    }
    if (s.idle) {
      clearTimeout(s.idle);
      s.idle = null;
    }
    const cur = s.docs.get(file);
    if (cur) {
      cur.refs++;
      cur.version++;
      s.conn.notify("textDocument/didChange", { textDocument: { uri: cur.uri, version: cur.version }, contentChanges: [{ text }] });
    } else {
      const doc = { uri: uriOf(file), languageId: sf.languageId, version: 1, refs: 1 };
      s.docs.set(file, doc);
      s.conn.notify("textDocument/didOpen", { textDocument: { uri: doc.uri, languageId: doc.languageId, version: doc.version, text } });
    }
    this.schedulePull(s, file);
    return { server, state: "ready" };
  }

  change(root: string, file: string, text: string): void {
    const { s, doc } = this.find(root, file);
    doc.version++;
    s.conn.notify("textDocument/didChange", { textDocument: { uri: doc.uri, version: doc.version }, contentChanges: [{ text }] });
    this.schedulePull(s, file);
  }

  saved(root: string, file: string): void {
    const { s, doc } = this.find(root, file);
    s.conn.notify("textDocument/didSave", { textDocument: { uri: doc.uri } });
  }

  close(root: string, file: string): void {
    const flight = this.opening.get(`${root}\0${file}`);
    if (flight && flight.opens > flight.closes) {
      flight.closes++;
      return;
    }
    const found = this.lookup(root, file);
    if (!found || --found.doc.refs > 0) return;
    const { s, doc } = found;
    s.docs.delete(file);
    clearTimeout(s.pulls.get(file));
    s.latestPull.delete(file);
    s.conn.notify("textDocument/didClose", { textDocument: { uri: doc.uri } });
    if (!s.docs.size) this.idleLater(s);
  }

  /** Stop a server once it has had no open files for a while. */
  private idleLater(s: Server): void {
    if (s.idle) clearTimeout(s.idle);
    s.idle = setTimeout(() => this.stop(s), IDLE_MS);
  }

  /** Nothing to show (no text) while the file isn't open with a ready server. */
  async hover(root: string, file: string, pos: LspPosition): Promise<string> {
    const found = this.lookup(root, file);
    if (!found) return "";
    const { s, doc } = found;
    return hoverText((await s.conn.request("textDocument/hover", { textDocument: { uri: doc.uri }, position: pos }))?.contents);
  }

  /** `prefix` is the word before the cursor, which narrows the list (see completionItems). None while the file isn't open with a ready server. */
  async completion(root: string, file: string, pos: LspPosition, prefix = "", trigger?: string): Promise<LspCompletion[]> {
    const found = this.lookup(root, file);
    if (!found) return [];
    const { s, doc } = found;
    const context = trigger ? { triggerKind: 2, triggerCharacter: trigger } : { triggerKind: 1 };
    return completionItems(await s.conn.request("textDocument/completion", { textDocument: { uri: doc.uri }, position: pos, context }), prefix);
  }

  async definition(root: string, file: string, pos: LspPosition): Promise<LspLocation[]> {
    const { s, doc } = this.find(root, file);
    return locations(await s.conn.request("textDocument/definition", { textDocument: { uri: doc.uri }, position: pos }));
  }

  async rename(root: string, file: string, pos: LspPosition, newName: string): Promise<LspFileEdits[]> {
    const { s, doc } = this.find(root, file);
    if (!s.caps.renameProvider) throw new Error(`${s.spec.label}'s language server can't rename`);
    return workspaceEdits(await s.conn.request("textDocument/rename", { textDocument: { uri: doc.uri }, position: pos, newName }, 60_000));
  }

  async format(root: string, file: string, options: { tabSize: number; insertSpaces: boolean }): Promise<LspTextEdit[] | null> {
    const { s, doc } = this.find(root, file);
    if (!s.caps.documentFormattingProvider) return null; // this language's server doesn't format (pyright)
    return (await s.conn.request("textDocument/formatting", { textDocument: { uri: doc.uri }, options })) ?? [];
  }

  private async stop(s: Server): Promise<void> {
    if (s.conn.isClosed) return;
    // no longer handed out: a file opened from now on starts a fresh server
    const key = this.key(s.spec, s.root);
    if (this.servers.get(key) === s) this.servers.delete(key);
    try {
      await s.conn.request("shutdown", null, 3000);
      s.conn.notify("exit", null);
    } catch {
      /* it's going away either way */
    }
    setTimeout(() => s.conn.close("Stopped"), 1000);
  }

  stopAll(): void {
    for (const s of [...this.servers.values()]) {
      s.docs.clear();
      void this.stop(s);
    }
  }
}
