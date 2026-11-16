import { randomUUID } from "crypto";
import type { AssistantCard } from "../../shared/assistant";
import type { ToolCard } from "./registry";

/**
 * The Assistant's confirm cards (docs/assistant.md → Tiers), in memory only. A card holds the call it stands for (tool
 * and arguments) for the user's Do it; the window sees only the card. Open → running → done or failed (or back to open
 * when Do it's check says no), open → cancelled, open → expired.
 */

const SETTLED_KEPT = 20;

/** A card, with the call it stands for and the step that proposed it. */
export interface HeldCard {
  card: AssistantCard;
  args: Record<string, unknown>;
  stepId: string;
}

export class CardBook {
  /** Oldest first. */
  private held: HeldCard[] = [];

  constructor(private readonly o: { now: () => number; cardMs: number }) {}

  open(p: { turnId: string; stepId: string; tool: string; args: Record<string, unknown>; card: ToolCard; blocked: string | null }): AssistantCard {
    const card: AssistantCard = {
      id: `c-${randomUUID()}`,
      turnId: p.turnId,
      tool: p.tool,
      title: p.card.title,
      detail: p.card.detail,
      warnings: [...p.card.warnings],
      ...(p.card.danger ? { danger: true } : {}),
      blocked: p.blocked,
      state: "open",
      expiresAt: this.o.now() + this.o.cardMs,
    };
    this.held.push({ card, args: p.args, stepId: p.stepId });
    this.trim();
    return card;
  }

  get(id: string): HeldCard | undefined {
    return this.held.find((h) => h.card.id === id);
  }

  /** Settle card `id`: `state` and its outcome in plain words. */
  settle(id: string, state: "done" | "failed" | "cancelled" | "expired", result: string): AssistantCard | undefined {
    const h = this.get(id);
    if (!h) return undefined;
    h.card.state = state;
    h.card.result = result;
    h.card.blocked = null;
    this.trim();
    return h.card;
  }

  /** Open cards (oldest first), then the last settled ones. */
  view(): AssistantCard[] {
    const open = this.held.filter((h) => h.card.state === "open" || h.card.state === "running");
    const settled = this.held.filter((h) => h.card.state !== "open" && h.card.state !== "running");
    return [...open, ...settled].map((h) => ({ ...h.card, warnings: [...h.card.warnings] }));
  }

  /** Open cards whose time ran out, or whose target changed (`valid` false), expire. Returns those that did. */
  sweep(valid: (h: HeldCard) => boolean): AssistantCard[] {
    const now = this.o.now();
    const out: AssistantCard[] = [];
    for (const h of this.held) {
      if (h.card.state !== "open") continue;
      if (now >= h.card.expiresAt) out.push(this.settle(h.card.id, "expired", `Expired: it waited ${Math.round(this.o.cardMs / 60_000)} minutes without an answer`)!);
      else if (!valid(h)) out.push(this.settle(h.card.id, "expired", "Expired: what it was about has changed since")!);
    }
    return out;
  }

  private trim(): void {
    const settled = this.held.filter((h) => h.card.state !== "open" && h.card.state !== "running");
    const drop = new Set(settled.slice(0, Math.max(0, settled.length - SETTLED_KEPT)));
    if (drop.size) this.held = this.held.filter((h) => !drop.has(h));
  }
}
