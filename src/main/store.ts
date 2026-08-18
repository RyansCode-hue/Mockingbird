import { app } from "electron";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { SessionInfo, Settings, DEFAULT_SETTINGS } from "../shared/types";

export const MB_DIR = path.join(os.homedir(), ".mockingbird");

export function expandHome(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

interface State {
  settings: Settings;
  // persisted session metadata so we can offer resume after restart
  sessions: SessionInfo[];
}

const stateFile = path.join(MB_DIR, "state.json");

export class Store {
  state: State;

  constructor() {
    fs.mkdirSync(MB_DIR, { recursive: true });
    fs.mkdirSync(path.join(MB_DIR, "events"), { recursive: true });
    this.state = this.load();
  }

  private load(): State {
    if (!fs.existsSync(stateFile)) return { settings: { ...DEFAULT_SETTINGS }, sessions: [] };
    try {
      const raw = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      return {
        settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
        sessions: raw.sessions ?? [],
      };
    } catch (err) {
      // a corrupt state file is NOT a fresh install: keep it aside so the
      // sessions and settings in it are recoverable instead of silently
      // overwritten by the first save()
      const backup = `${stateFile}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(stateFile, backup);
      } catch {
        /* best effort — the message below still names the problem */
      }
      console.error(
        `[mockingbird] ${stateFile} was unreadable (${(err as Error).message}); ` +
          `moved to ${backup} and starting from defaults.`
      );
      return { settings: { ...DEFAULT_SETTINGS }, sessions: [] };
    }
  }

  save(): void {
    // write-then-rename: save() runs on every status flip, so a crash mid-write
    // would otherwise leave a truncated state.json and lose every session
    const tmp = `${stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, stateFile);
  }

  get settings(): Settings {
    return this.state.settings;
  }

  setSettings(s: Partial<Settings>): void {
    this.state.settings = { ...this.state.settings, ...s };
    this.save();
  }

  upsertSession(info: SessionInfo): void {
    const i = this.state.sessions.findIndex((s) => s.id === info.id);
    if (i >= 0) this.state.sessions[i] = info;
    else this.state.sessions.push(info);
    this.save();
  }

  removeSession(id: string): void {
    this.state.sessions = this.state.sessions.filter((s) => s.id !== id);
    this.save();
  }
}
