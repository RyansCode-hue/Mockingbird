import * as fs from "fs";
import * as path from "path";
import type { AgentMessage } from "../shared/types";

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
      // keep an unreadable log aside rather than overwrite it
      const backup = `${this.file}.corrupt-${Date.now()}`;
      fs.renameSync(this.file, backup);
      console.error(`[mockingbird] ${this.file} was unreadable (${(err as Error).message}); moved to ${backup}.`);
      return [];
    }
  }

  add(m: AgentMessage): void {
    this.items = [...this.items, m].slice(-KEEP);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.items));
    fs.renameSync(tmp, this.file);
  }

  list(): AgentMessage[] {
    return this.items;
  }
}
