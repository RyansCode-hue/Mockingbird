import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** Where macOS keeps an administrator's Claude Code settings: managed-settings.json, and drop-ins beside it. */
export const CLAUDE_MANAGED_DIR = "/Library/Application Support/ClaudeCode";

/**
 * The settings a room pane takes beside its own --settings (it runs with --setting-sources user): the user's own and
 * an administrator's. A change to one can change a running pane's sandbox, so its account of it is asked for again.
 */
export function claudeSandboxSources(home = os.homedir(), managed = CLAUDE_MANAGED_DIR): SettingsSources {
  return { files: [path.join(home, ".claude", "settings.json"), path.join(managed, "managed-settings.json")], dirs: [path.join(managed, "managed-settings.d")] };
}

export interface SettingsSources {
  files: string[];
  /** Folders whose every file counts (drop-ins). */
  dirs: string[];
}

export const SETTINGS_POLL_MS = 2_000;
/** How long the files must be still after a change before it's acted on: an editor's save can be several writes. */
export const SETTINGS_SETTLE_MS = 1_000;

/** What a file is now, or why it isn't there: it changes when the file is written in place, replaced or removed. */
function stamp(file: string): string {
  try {
    const s = fs.statSync(file);
    return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code ?? "unreadable";
  }
}

/**
 * Settings files watched by what they are, polled (as usage.ts and hooks.ts watch theirs), so a write in place, an
 * editor's rename over the file, a removal and a file that appears are all seen. `changed` runs once they've settled.
 */
export class SettingsWatch {
  private last = "";
  private poll: ReturnType<typeof setInterval> | null = null;
  private settle: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly sources: SettingsSources,
    private readonly changed: () => void,
    private readonly timing: { pollMs: number; settleMs: number } = { pollMs: SETTINGS_POLL_MS, settleMs: SETTINGS_SETTLE_MS }
  ) {}

  get watching(): boolean {
    return this.poll !== null;
  }

  /** Starts from the files as they are now: what changes from here on is reported. */
  start(): void {
    if (this.poll) return;
    this.last = this.fingerprint();
    this.poll = setInterval(() => this.check(), this.timing.pollMs);
    this.poll.unref?.();
  }

  stop(): void {
    if (this.poll) clearInterval(this.poll);
    if (this.settle) clearTimeout(this.settle);
    this.poll = this.settle = null;
  }

  private fingerprint(): string {
    const parts = this.sources.files.map((f) => `${f}=${stamp(f)}`);
    for (const d of this.sources.dirs) {
      let names: string[];
      try {
        names = fs.readdirSync(d).sort();
      } catch (err) {
        parts.push(`${d}=${(err as NodeJS.ErrnoException).code ?? "unreadable"}`);
        continue;
      }
      parts.push(`${d}=${stamp(d)}`, ...names.map((n) => `${d}/${n}=${stamp(path.join(d, n))}`));
    }
    return parts.join("\n");
  }

  private check(): void {
    const now = this.fingerprint();
    if (now === this.last) return;
    this.last = now;
    if (this.settle) clearTimeout(this.settle);
    this.settle = setTimeout(() => {
      this.settle = null;
      try {
        this.changed();
      } catch (err) {
        console.error("[sessions] acting on a change to Claude Code's settings failed:", err);
      }
    }, this.timing.settleMs);
    this.settle.unref?.();
  }
}
