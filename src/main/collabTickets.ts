import type { CollabRooms } from "./collab";
import type { CollabRoom } from "../shared/types";
import { asDraft, type CouncilCreateResult, type CouncilHouseTargets, type TicketDraft, type TicketTargetRef } from "../shared/collabTickets";

/** What the Council needs of the House (the House board's service, team/houseService.ts). */
export interface CouncilHouse {
  councilTargets(repoPath: string | null): Promise<CouncilHouseTargets>;
  councilConsent(target: TicketTargetRef, allow: boolean): void;
  createTickets(target: TicketTargetRef, drafts: TicketDraft[], o: { track: boolean }): Promise<CouncilCreateResult>;
  webUrl(target: TicketTargetRef, n: number): Promise<{ url: string; problem?: string }>;
}

/** A target as the window sent it, checked. */
export function asTarget(v: unknown): TicketTargetRef {
  const x = v as Record<string, unknown> | null;
  if (x && typeof x.roomId === "string" && x.roomId) return { roomId: x.roomId };
  if (x && typeof x.project === "string" && x.project) return { project: x.project };
  throw new Error("Choose where the tickets go");
}

/**
 * An approved Council plan as House tickets: where they can go, the user's
 * answer about their token, and creating the reviewed drafts — only from the
 * user's click in the window — with what was created linked back into the
 * council. The House's own rules and the token stay with the House service.
 */
export class CouncilTickets {
  constructor(
    private rooms: CollabRooms,
    private house: CouncilHouse
  ) {}

  targets(id: string): Promise<CouncilHouseTargets> {
    return this.house.councilTargets(this.rooms.get(id).repoPath);
  }

  consent(id: string, target: TicketTargetRef, allow: boolean): Promise<CouncilHouseTargets> {
    this.house.councilConsent(asTarget(target), allow);
    return this.targets(id);
  }

  /**
   * Create the drafts as reviewed: they're kept with the council first, so
   * whatever happens the review still has them; a failure before anything was
   * sent throws (nothing was created), and anything after is in the result and
   * in the discussion.
   */
  async create(id: string, target: TicketTargetRef, drafts: TicketDraft[], track: boolean): Promise<{ room: CollabRoom; result: CouncilCreateResult }> {
    const room = this.rooms.get(id);
    if (!room.plan?.approved) throw new Error("Approve a plan first");
    const t = asTarget(target);
    const checked = (Array.isArray(drafts) ? drafts : []).map(asDraft);
    if (!checked.length || checked.some((d) => !d)) throw new Error("There are no tickets to create");
    this.rooms.setTicketDrafts(id, checked as TicketDraft[]);
    const result = await this.house.createTickets(t, checked as TicketDraft[], { track: "roomId" in t && track === true });
    return { room: this.rooms.recordHouseTickets(id, result, "roomId" in t ? t.roomId : null), result };
  }

  /** Where one of the council's tickets opens in the House. */
  async url(id: string, n: number): Promise<{ url: string; problem?: string }> {
    const ticket = (this.rooms.get(id).houseTickets ?? []).find((t) => t.n === n);
    if (!ticket) throw new Error(`#${n} wasn't created from this council`);
    return this.house.webUrl(ticket.roomId ? { roomId: ticket.roomId } : { project: ticket.project }, n);
  }
}
