import * as fs from "fs";
import type { AgentMessage } from "../shared/types";
import { writeFileAtomic } from "./fileOps";

const KEEP = 300;

/**
 * Who told whom what: the last 300 agent-to-agent messages, refused ones
 * included, kept in one JSON file (written whole, then renamed into place).
 */
export class MessageLog {
  private items: AgentMessage[];

  constructor(private file: string) {
    this.items = this.load();
  }

  private load(): AgentMessage[] {
    if (!fs.existsSync(this.file)) return [];
    try {
      const v = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return Array.isArray(v) ? v : [];
    } catch (err) {
      // keep an unreadable log aside rather than overwrite it; the log is
      // built at startup, so failing to move it must not stop the app
      const backup = `${this.file}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(this.file, backup);
        console.error(`[mockingbird] ${this.file} was unreadable (${(err as Error).message}); moved to ${backup}.`);
      } catch (moveErr) {
        console.error(`[mockingbird] ${this.file} was unreadable (${(err as Error).message}) and couldn't be moved aside; starting an empty log:`, moveErr);
      }
      return [];
    }
  }

  /** Record a message. It is listed even when the file can't be written; that failure is thrown for the caller to report. */
  add(m: AgentMessage): void {
    this.items = [...this.items, m].slice(-KEEP);
    writeFileAtomic(this.file, JSON.stringify(this.items));
  }

  list(): AgentMessage[] {
    return this.items;
  }
}
