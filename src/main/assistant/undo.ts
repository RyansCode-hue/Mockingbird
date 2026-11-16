import { ASSISTANT_LIMITS } from "../../shared/assistant";
import type { ToolTarget } from "./registry";

/**
 * The Undo of the Assistant's direct steps (docs/assistant.md → Tiers), in memory only: offered for ASSISTANT_LIMITS.undoMs
 * after the step, while what it changed is still as it left it (the tool's stillUndoable).
 */

export interface UndoEntry {
  tool: string;
  label: string;
  target: ToolTarget | null;
  until: number;
  undo: () => string | Promise<string>;
  stillUndoable?: () => boolean;
}

export class UndoBook {
  private entries = new Map<string, UndoEntry>();

  constructor(private readonly o: { now: () => number; log: (context: string, err: unknown) => void }) {}

  add(stepId: string, e: UndoEntry): void {
    this.entries.set(stepId, e);
  }

  /** Why step `stepId` can't be undone now, or null when it can. */
  refusal(stepId: string): string | null {
    const e = this.entries.get(stepId);
    if (!e) return "That step has no Undo: it changed nothing that can be put back, or it was undone already";
    if (this.o.now() >= e.until) return `Its Undo has run out: it's offered for ${Math.round(ASSISTANT_LIMITS.undoMs / 60_000)} minutes after the step`;
    if (!this.unchanged(stepId, e)) return "What it changed has changed again since, so putting it back would undo that too";
    return null;
  }

  /** The Undo of step `stepId`, taken out so it runs once. Throws why not. */
  take(stepId: string): UndoEntry {
    const why = this.refusal(stepId);
    if (why) throw new Error(why);
    const e = this.entries.get(stepId)!;
    this.entries.delete(stepId);
    return e;
  }

  /** The steps whose Undo lapsed since (time ran out, or what they changed changed again): no longer offered. */
  sweep(): string[] {
    const out: string[] = [];
    for (const [id, e] of this.entries) {
      if (this.o.now() >= e.until || !this.unchanged(id, e)) {
        this.entries.delete(id);
        out.push(id);
      }
    }
    return out;
  }

  /** Drop every Undo (a fresh thread). */
  clear(keep: (stepId: string) => boolean): void {
    for (const id of [...this.entries.keys()]) if (!keep(id)) this.entries.delete(id);
  }

  private unchanged(stepId: string, e: UndoEntry): boolean {
    if (!e.stillUndoable) return true;
    try {
      return e.stillUndoable();
    } catch (err) {
      this.o.log(`assistant: checking whether step ${stepId} (${e.tool}) can still be undone`, err);
      return false;
    }
  }
}
