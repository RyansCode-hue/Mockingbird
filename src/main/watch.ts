import * as fs from "fs";
import * as path from "path";

/**
 * Paths whose churn never changes what the explorer, Source Control or a pane's
 * change count show: dependency installs, git's object store and reflogs, and
 * git's own lock files. Changes to .git/index, HEAD and refs do count — staging
 * and commits show — and so do a project's lockfiles (yarn.lock, Cargo.lock).
 */
export function ignoredChange(rel: string | null): boolean {
  if (!rel) return false;
  const p = rel.split("\\").join("/");
  return (
    p === ".DS_Store" ||
    p.endsWith("/.DS_Store") ||
    /(^|\/)node_modules(\/|$)/.test(p) ||
    p.startsWith(".git/objects/") ||
    p.startsWith(".git/logs/") ||
    (p.startsWith(".git/") && p.endsWith(".lock"))
  );
}

type Watch = { watcher: fs.FSWatcher; timer: NodeJS.Timeout | null };

/**
 * Watches the folders the window shows (live sessions' folders), so views
 * refresh when a file changes instead of polling every few seconds. One
 * recursive watch per folder (FSEvents on macOS); bursts are coalesced to at
 * most one notice per `settleMs`. A folder that can't be watched is reported
 * through `onError` and left to the window's slower fallback poll.
 */
export class FolderWatcher {
  private watches = new Map<string, Watch>();

  constructor(
    private onChange: (root: string) => void,
    private onError: (root: string, err: unknown) => void,
    // at most one notice per folder this often: while an agent edits steadily,
    // each notice re-reads git state for the folder's panes and views
    private settleMs = 750,
    private watchFn: typeof fs.watch = fs.watch
  ) {}

  /** Watch exactly these folders: new ones start, ones no longer listed stop. */
  set(roots: string[]): { watching: string[] } {
    const want = new Set(roots.filter((r) => typeof r === "string" && r.startsWith("/")));
    for (const [root, w] of this.watches) if (!want.has(root)) this.stop(root, w);
    for (const root of want) if (!this.watches.has(root)) this.start(root);
    return { watching: [...this.watches.keys()] };
  }

  private start(root: string): void {
    let watcher: fs.FSWatcher;
    // FSEvents also reports the watched folder itself, by its own name, whenever
    // an entry is added or removed at its top — the entry's own event follows
    const self = path.basename(root);
    try {
      watcher = this.watchFn(root, { recursive: true, persistent: false }, (_event, file) => {
        const rel = typeof file === "string" ? file : file ? String(file) : null;
        if (rel === self || ignoredChange(rel)) return;
        const w = this.watches.get(root);
        if (!w || w.timer) return;
        w.timer = setTimeout(() => {
          w.timer = null;
          this.onChange(root);
        }, this.settleMs);
      });
    } catch (err) {
      this.onError(root, err);
      return;
    }
    watcher.on("error", (err) => {
      this.onError(root, err);
      const w = this.watches.get(root);
      if (w?.watcher === watcher) this.stop(root, w);
    });
    this.watches.set(root, { watcher, timer: null });
  }

  private stop(root: string, w: Watch): void {
    if (w.timer) clearTimeout(w.timer);
    w.watcher.close();
    this.watches.delete(root);
  }
}
