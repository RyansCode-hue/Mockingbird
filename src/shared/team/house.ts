/**
 * Team rooms: the board of a room's Radley House tickets (docs/team-rooms.md,
 * "Radley House board"). The House is the system of record: every member's
 * Mockingbird reads it with that member's own builder token and writes to it
 * the same way. The room log holds only what the House doesn't: which House
 * project the room works in (its admin's choice), the tickets the room added
 * to its board by number, and nudges that tell members a ticket just changed.
 * Titles, claims and statuses are never copied into the log.
 *
 * Plain code with no Node or Electron APIs: the window and the main process
 * both use it.
 */
import type { MemberId, RoomId } from "./types";

/** A House project name: the env file `~/.config/radley-house/<project>.env` holds its coordinates and this builder's token. */
export const HOUSE_PROJECT_RE = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Where each builder keeps a project's coordinates and token, relative to their home folder. */
export const HOUSE_CONFIG_DIR = ".config/radley-house";
export const houseEnvFile = (project: string) => `${HOUSE_CONFIG_DIR}/${project}.env`;
/** What a builder does when their env file is missing or their token is refused. */
export const HOUSE_TOKEN_HOW = "Each builder needs their own token: in the House, open the project's Overview → External build setup → Mint build token.";

/** House ticket numbers are positive whole numbers the House assigns. */
export const isTicketNumber = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0 && (n as number) <= 1_000_000_000;

/** Statuses a builder's token may set (only staff close a ticket as done or dropped). */
export const BUILDER_STATUSES = ["parked", "ready", "in_progress", "review", "validating"] as const;
export type BuilderStatus = (typeof BUILDER_STATUSES)[number];
export const HOUSE_PRIORITIES = ["high", "medium", "low", "investigate"] as const;

/** What post_house_ticket_event (and the ticket dialog) can add to a ticket's history. */
export const HOUSE_EVENT_KINDS = ["progress", "status", "question", "note"] as const;
export type HouseEventKind = (typeof HOUSE_EVENT_KINDS)[number];

/** The handoff tags (only one at a time): a question for a person, or work handed back to an agent. */
export const NEEDS_HUMAN = "needs-human";
export const NEEDS_AGENT = "needs-agent";

export const statusLabel = (s: string): string => s.replace(/_/g, " ");

/** The House's tools on the Mockingbird MCP server, for agents in a room. */
export const HOUSE_TOOLS = {
  list: "list_house_tickets",
  read: "read_house_ticket",
  create: "create_house_ticket",
  claim: "claim_house_ticket",
  release: "release_house_ticket",
  event: "post_house_ticket_event",
  spec: "get_house_spec",
} as const;
export const HOUSE_TOOL_NAMES: string[] = Object.values(HOUSE_TOOLS);

// ---- what the House says, as Mockingbird reads it ---------------------------------------

/** Who has a ticket in the House, and on which branch. */
export interface HouseClaim {
  /** The builder's name as the House gives it. */
  by: string | null;
  branch: string | null;
  at: string | null;
}

export interface HouseTicket {
  n: number;
  title: string;
  status: string;
  priority: string | null;
  kind: string | null;
  tags: string[];
  claim: HouseClaim | null;
}

export interface HouseHistoryEntry {
  /** progress, question, note, claim… as the House names it. */
  kind: string;
  text: string;
  by: string | null;
  at: string | null;
  status: string | null;
  reference: string | null;
}

export interface HouseTicketDetail extends HouseTicket {
  /** The ticket's page in the House, when the House gives one. */
  url: string | null;
  detail: string;
  acceptance: string;
  blockedBy: number[];
  history: HouseHistoryEntry[];
}

/** The current frozen slice, from the House's spec. */
export interface HouseSlice {
  name: string | null;
  numbers: number[];
  /** Whether the spec named its tickets at all (false: only the room's own tickets can show). */
  listsTickets: boolean;
}

// ---- the room log ---------------------------------------------------------------------------

/** What does a nudge say happened (for the room's chat line; the House holds the rest). */
export const NUDGE_CHANGES = ["created", "claimed", "released", "progress", "status", "question", "note"] as const;
export type NudgeChange = (typeof NUDGE_CHANGES)[number];

export interface TrackedTicket {
  n: number;
  by: MemberId;
  at: number;
}

/** The room's part of the board, as every member reduces it from the log. */
export interface HouseRoomState {
  /** The House project the room works in: its admin's choice. */
  project: string | null;
  projectBy: MemberId | null;
  /** Tickets the room added to its board, oldest first. */
  tracked: TrackedTicket[];
}

/** How many tickets a room can add to its board. */
export const MAX_TRACKED = 200;
export const VIA_MAX = 200;

export const emptyHouse = (): HouseRoomState => ({ project: null, projectBy: null, tracked: [] });

declare module "./types" {
  interface RoomEventBodies {
    /** The room's admin chose its House project (null: none). Anyone else's changes nothing. */
    "house.project": { project: string | null };
    /** A member added a ticket to the room's board, by its House number. */
    "house.track": { n: number };
    "house.untrack": { n: number };
    /**
     * A member just wrote to ticket `n` in the House: other members read it
     * again now rather than at their next poll. Changes no state.
     */
    "house.nudge": { n: number; change?: NudgeChange; via?: string };
  }
  interface RoomExtensions {
    house: HouseRoomState;
  }
}

// ---- what the window shows ------------------------------------------------------------------

/** How this Mac reaches the room's House project. */
export type HouseConnection =
  /** The room's admin hasn't chosen a project. */
  | { state: "unset" }
  /** This builder's env file is missing, or doesn't hold what's needed. */
  | { state: "missing" | "bad"; file: string; message: string }
  /** Not read yet. */
  | { state: "pending" }
  | { state: "ok" }
  /** The House refused or couldn't be reached (the House's message, token scrubbed). */
  | { state: "error"; message: string };

/** Who a claimed ticket is with, as the board shows it. */
export interface HouseOwner {
  name: string;
  /** The room member, when the claim's branch or the House's name tie it to one. */
  member: MemberId | null;
  self: boolean;
}

export interface HouseRow {
  n: number;
  /** Null when it couldn't be read (see problem) or hasn't been yet. */
  ticket: HouseTicket | null;
  owner: HouseOwner | null;
  problem?: string;
  /** For the room's own tickets: who added it. */
  addedBy?: string;
}

export interface HouseView {
  roomId: RoomId;
  room: string;
  project: string | null;
  /** The room's admin by name, who alone chooses the project. */
  admin: string | null;
  isAdmin: boolean;
  /** The env file this Mac reads for the project (`~/…`). */
  envFile: string | null;
  connection: HouseConnection;
  /** Null until the spec has been read (or when it couldn't be: problem). */
  slice: { name: string | null; listsTickets: boolean; rows: HouseRow[] } | null;
  sliceProblem?: string;
  added: HouseRow[];
  /** When the House was last read (0: never). */
  fetchedAt: number;
  refreshing: boolean;
  /** Branches of this Mac's sessions in the room, to claim a ticket on. */
  branches: string[];
  /** Why the room's claims couldn't be written into a repository's worktrees (agents there aren't warned). */
  copiesProblem?: string;
  /** Why teammates' branches couldn't be fetched (their claimed files may be out of date). */
  fetchProblem?: string;
}

/** One ticket in the dialog: the House's detail, or why it couldn't be read. */
export type HouseTicketView = { detail: HouseTicketDetail; owner: HouseOwner | null; onBoard: "slice" | "added" | null; mine: boolean } | { error: string };

/** What the window asks to write. */
export type HouseWrite =
  | { kind: "claim"; n: number; branch: string }
  | { kind: "release"; n: number }
  | { kind: "event"; n: number; event: HouseEventKind; text: string; status?: BuilderStatus }
  | { kind: "create"; title: string; description: string; acceptance?: string }
  | { kind: "track"; n: number }
  | { kind: "untrack"; n: number }
  | { kind: "project"; project: string | null };

/** "Nick · in progress" (or "You · …"). */
export const ownerChip = (owner: HouseOwner, status: string): string => `${owner.self ? "You" : owner.name} · ${statusLabel(status)}`;

/** A suggested branch for claiming ticket `n`: feature/<n>-<slug of its title>. */
export function branchFor(n: number, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(0, 5)
    .join("-");
  return `feature/${n}${slug ? `-${slug}` : ""}`;
}

/** A git branch name as git accepts it (enough to refuse what it wouldn't). */
export const BRANCH_RE = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)(?!.*\.lock$)(?!.*\/$)[^\s~^:?*[\\\0]{1,250}$/;
