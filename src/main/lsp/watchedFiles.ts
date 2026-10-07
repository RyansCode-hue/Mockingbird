import * as fs from "fs";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";

/**
 * File watching done for a language server, as the protocol's
 * workspace/didChangeWatchedFiles. A server whose client can't watch runs its
 * own watcher, and TypeScript's then watches far above the project (all of
 * /tmp, or the folder holding every repository): a burst of writes anywhere in
 * there — another test, an agent in a sibling worktree — makes it drop edits
 * to open files and report problems that were already fixed. Watching here
 * keeps that to the project's own folder, with its events batched.
 */

/** LSP FileChangeType. */
export const CREATED = 1;
export const CHANGED = 2;
export const DELETED = 3;

/** What a server asked to hear about: a glob (absolute, or under a base folder) and which kinds of change (WatchKind bits). */
export interface Watcher {
  globPattern: string | { baseUri: string | { uri: string }; pattern: string };
  kind?: number;
}

export interface FileChange {
  uri: string;
  type: number;
}

/** A glob as a regex: `**` crosses folders, `*` and `?` stay within one, `{a,b}` and `[…]` as usual. */
export function globRegex(glob: string, caseInsensitive = process.platform === "darwin"): RegExp {
  let re = "";
  let braces = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      // "**/" also matches no folders at all
      if (glob[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "{") {
      braces++;
      re += "(?:";
    } else if (c === "}" && braces) {
      braces--;
      re += ")";
    } else if (c === "," && braces) re += "|";
    else if (c === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end < 0) re += "\\[";
      else {
        re += `[${glob.slice(i + 1, end).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`;
        i = end;
      }
    } else re += c.replace(/[.+^$()|\\\]]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, caseInsensitive ? "i" : "");
}

/** A watcher as a test of an absolute path, and the kinds of change it wants. */
function compile(w: Watcher): { matches: (file: string) => boolean; kind: number } {
  const kind = w.kind ?? 7;
  if (typeof w.globPattern === "string") {
    const re = globRegex(w.globPattern);
    // a pattern with no folder in it ("*.ts") is about the file's name, wherever it is
    return { kind, matches: w.globPattern.includes("/") ? (f) => re.test(f) : (f) => re.test(path.basename(f)) };
  }
  const base = w.globPattern.baseUri;
  const baseUri = typeof base === "string" ? base : base.uri;
  const dir = baseUri.startsWith("file:") ? fileURLToPath(baseUri) : baseUri;
  const re = globRegex(w.globPattern.pattern);
  return {
    kind,
    matches: (f) => {
      const rel = path.relative(dir, f);
      return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel) && re.test(rel.split(path.sep).join("/"));
    },
  };
}

/** When a file was created (ms), or null when it doesn't exist. */
function birthTime(file: string): number | null {
  try {
    return fs.statSync(file).birthtimeMs;
  } catch {
    return null;
  }
}

/**
 * What an event means to a server. macOS reports writing to an existing file
 * as a "rename", like creating one, so the file's birth time decides: born
 * well before the event, it was changed in place. Born around it, it is new —
 * or replaced by an atomic save, which looks the same — so it is reported
 * deleted and then created: a server that had it drops it and reads it afresh,
 * and one that didn't adds it. (TypeScript's server ignores "created" for a
 * file it already has, which would leave it on the old text.)
 */
export function changeTypes(event: "rename" | "change", born: number | null, eventAt: number): number[] {
  if (born === null) return [DELETED];
  if (event === "change" || born < eventAt - 2000) return [CHANGED];
  return [DELETED, CREATED];
}

/** WatchKind bit for a change type: Create 1, Change 2, Delete 4. */
const bitOf = (type: number) => (type === CREATED ? 1 : type === CHANGED ? 2 : 4);

type WatchFn = (dir: string, onEvent: (event: "rename" | "change", file: string | null) => void, onError: (err: Error) => void) => { close(): void };

const nodeWatch: WatchFn = (dir, onEvent, onError) => {
  const w = fs.watch(dir, { recursive: true }, (event, file) => onEvent(event as "rename" | "change", file ? String(file) : null));
  w.on("error", onError);
  return w;
};

/**
 * One server's watched files: the folder is watched (recursively) while the
 * server has asked to watch anything, events matching what it asked for are
 * batched — sent once things go quiet for `quietMs`, or every `maxWaitMs`
 * during a long burst — and git's own bookkeeping under .git is never sent.
 */
export class WatchedFiles {
  private watchers = new Map<string, ReturnType<typeof compile>[]>();
  private handle: { close(): void } | null = null;
  private pending = new Map<string, "rename" | "change">();
  /** When the batch's first event arrived: a file born well before it was there already. */
  private batchStart = 0;
  private quiet: NodeJS.Timeout | null = null;
  private maxWait: NodeJS.Timeout | null = null;
  private failed = false;

  constructor(
    private root: string,
    private send: (changes: FileChange[]) => void,
    private opts: { quietMs?: number; maxWaitMs?: number; watch?: WatchFn; bornAt?: (file: string) => number | null; onError?: (err: Error) => void } = {}
  ) {}

  register(id: string, watchers: Watcher[]): void {
    this.watchers.set(id, watchers.map(compile));
    this.ensureWatching();
  }

  unregister(id: string): void {
    this.watchers.delete(id);
    if (!this.watchers.size) this.stopWatching();
  }

  dispose(): void {
    this.watchers.clear();
    this.stopWatching();
  }

  private ensureWatching(): void {
    if (this.handle || this.failed || !this.watchers.size) return;
    try {
      this.handle = (this.opts.watch ?? nodeWatch)(
        this.root,
        (event, file) => file && this.note(event, path.join(this.root, file)),
        (err) => this.fail(err)
      );
    } catch (err) {
      this.fail(err as Error);
    }
  }

  private fail(err: Error): void {
    this.failed = true;
    this.stopWatching();
    (this.opts.onError ?? ((e) => console.error(`[lsp] can't watch ${this.root} for its language server; changes made outside the editor won't reach it:`, e)))(err);
  }

  private stopWatching(): void {
    this.handle?.close();
    this.handle = null;
    if (this.quiet) clearTimeout(this.quiet);
    if (this.maxWait) clearTimeout(this.maxWait);
    this.quiet = this.maxWait = null;
    this.pending.clear();
  }

  private note(event: "rename" | "change", file: string): void {
    if (!this.handle) return; // a closed watcher can still deliver one it had queued
    const rel = path.relative(this.root, file).split(path.sep);
    if (rel[0] === ".git") return;
    if (!this.pending.size) this.batchStart = Date.now();
    // a rename then a change is still a creation or a deletion
    if (this.pending.get(file) !== "rename") this.pending.set(file, event);
    if (this.quiet) clearTimeout(this.quiet);
    this.quiet = setTimeout(() => this.flush(), this.opts.quietMs ?? 150);
    this.maxWait ??= setTimeout(() => this.flush(), this.opts.maxWaitMs ?? 1000);
  }

  private flush(): void {
    if (this.quiet) clearTimeout(this.quiet);
    if (this.maxWait) clearTimeout(this.maxWait);
    this.quiet = this.maxWait = null;
    const bornAt = this.opts.bornAt ?? birthTime;
    const all = [...this.watchers.values()].flat();
    const changes: FileChange[] = [];
    for (const [file, event] of this.pending) {
      for (const type of changeTypes(event, bornAt(file), this.batchStart)) {
        if (all.some((w) => w.kind & bitOf(type) && w.matches(file))) changes.push({ uri: pathToFileURL(file).href, type });
      }
    }
    this.pending.clear();
    if (changes.length) this.send(changes);
  }
}
