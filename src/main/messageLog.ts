import type { AgentMessage } from "../shared/types";
import { readJsonOrSetAside, writeFileAtomic } from "./fileOps";

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
    const v = readJsonOrSetAside(this.file, []);
    return Array.isArray(v) ? v : [];
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
