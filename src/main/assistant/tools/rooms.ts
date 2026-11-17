import { ago } from "../../../shared/format";
import { BRANCH_RE, isTicketNumber } from "../../../shared/team/house";
import type { TakeoverPlan } from "../../../shared/team/takeover";
import type { AssistantDeps, AssistantRoom } from "../deps";
import { defineTool, type AssistantTool, type JsonSchema, type ToolCard } from "../registry";
import { SESSION_ARG, sessionRef } from "./lookup";

/**
 * Rooms (docs/assistant.md → Ability groups; docs/team-rooms.md): the House board to read, and every room action as a
 * card: sharing a group, leaving a room, taking over a teammate's session (its plan read first, for the card), the
 * room's sandbox on this Mac, and claiming or releasing a House ticket. Each goes through the team handlers' own
 * checks. None is rule-able: each is the user's word to teammates or about their work.
 */

type Deps = Pick<
  AssistantDeps,
  | "sessions"
  | "groups"
  | "rooms"
  | "houseBoard"
  | "shareRefusal"
  | "shareGroup"
  | "leaveRoom"
  | "takeoverTarget"
  | "takeoverPlan"
  | "takeOver"
  | "roomSandboxed"
  | "setRoomSandbox"
  | "houseWrite"
>;

const ROOM_ARG: JsonSchema = { type: "string", minLength: 1, maxLength: 120, description: "The room: its name or its group's key, from the snapshot" };
const TICKET_ARG: JsonSchema = { type: "integer", minimum: 1, maximum: 1_000_000_000, description: "The House ticket's number (143 for #143)" };

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err)) || "it failed without saying why";

export function roomTools(d: Deps): AssistantTool[] {
  /** A session as a card names it (lookup.ts sessionRef), from the landscape's sessions: these tools read no records. */
  const ref = (id: string) => sessionRef({ sessions: () => d.sessions() }, id);
  /** The room `arg` names (by id, name or group key), or why none does. */
  const roomOf = (arg: string): AssistantRoom | { refused: string } => {
    const hits = d.rooms().filter((r) => r.id === arg || r.name === arg || r.group === arg);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return { refused: `Several rooms go by “${arg}”: name one by its group` };
    return { refused: `This Mac isn't in a room called “${arg}”: the rooms are in the snapshot` };
  };
  const roomName = (arg: string) => {
    const r = roomOf(arg);
    return "refused" in r ? `“${arg}”` : `“${r.name}”`;
  };
  const why = (arg: string) => {
    const r = roomOf(arg);
    return "refused" in r ? r.refused : null;
  };
  /** Room `arg`, or throws why there's none: a run, after check said there is. */
  const room = (arg: string): AssistantRoom => {
    const r = roomOf(arg);
    if ("refused" in r) throw new Error(r.refused);
    return r;
  };

  /** A teammate's session's take-over plan, or why it can't be taken over. */
  const plan = async (id: string): Promise<{ plan: TakeoverPlan } | { refused: string }> => {
    const t = d.takeoverTarget(id);
    if (!t) return { refused: "That isn't a teammate's room session on this landscape: take-over is for one" };
    let p: TakeoverPlan;
    try {
      p = await d.takeoverPlan(t.roomId, t.sessionId);
    } catch (err) {
      return { refused: message(err) };
    }
    if (p.grant.kind === "none") return { refused: `“${p.title}” can't be taken over: ${p.grant.why}` };
    if (!p.clone) return { refused: `No clone of its repository was found on this Mac: take it over from the Team view, where you can pick one` };
    return { plan: p };
  };

  return [
    defineTool<{ room: string }>({
      name: "house_board",
      tier: "read",
      description: "A team room's House board, as its agents see it: its project, and its tickets with who has each and their status. Read now when what's here is old.",
      inputSchema: { type: "object", properties: { room: ROOM_ARG }, required: ["room"], additionalProperties: false },
      label: (a) => `Read ${roomName(a.room)}'s House board`,
      check: (a) => why(a.room),
      run: async (a) => {
        const r = room(a.room);
        const board = await d.houseBoard(r.id);
        return { text: JSON.stringify({ room: r.name, board: board ?? "The room isn't connected to a House project." }) };
      },
    }),
    defineTool<{ group: string; title?: string }>({
      name: "share_group",
      tier: "confirm",
      description:
        "Share a top-level group as a team room, as its Share does: teammates the user invites see its sessions live, and its agents run in the room's sandbox. " +
        "The invite code is the user's to send, from the Team view; it's never given here. This puts a card in front of the user; it runs only when they confirm.",
      inputSchema: {
        type: "object",
        properties: {
          group: { type: "string", minLength: 1, maxLength: 80, description: "The group's key, from list_groups" },
          title: { type: "string", minLength: 1, maxLength: 80, description: "The room's name; the group's when left out" },
        },
        required: ["group"],
        additionalProperties: false,
      },
      label: (a) => `Share “${a.group}” as a team room`,
      check: (a) => {
        const g = d.groups().find((x) => x.key === a.group);
        if (!g) return `There's no top-level group “${a.group}”: the groups are in list_groups`;
        if (g.room) return `“${a.group}” is shared already, as the room “${g.room}”`;
        return d.shareRefusal(a.group);
      },
      card: (a) => {
        const g = d.groups().find((x) => x.key === a.group);
        const n = g?.sessions ?? 0;
        return {
          title: `Share “${a.group}” as a team room`,
          detail: `Makes it a team room${a.title ? ` named “${a.title}”` : ""}: teammates you invite see its sessions live, and its agents run in the room's sandbox. You send the invite from the Team view.`,
          warnings: n ? [`Its ${n} running session${n === 1 ? "" : "s"} show to whoever joins.`] : [],
        };
      },
      stillValid: (a) => !!d.groups().find((x) => x.key === a.group && !x.room),
      run: async (a) => {
        const r = await d.shareGroup(a.group, a.title ?? a.group);
        return { text: `Shared “${a.group}” as a team room${r.created ? "" : " again"}: its invite code is in the Team view, for the user to send.${r.warning ? ` ${r.warning}` : ""}` };
      },
    }),
    defineTool<{ room: string }>({
      name: "leave_room",
      tier: "confirm",
      description: "Leave a team room on this Mac, as its Leave does: teammates are told, and their sessions go from this landscape. This puts a card in front of the user; it runs only when they confirm.",
      inputSchema: { type: "object", properties: { room: ROOM_ARG }, required: ["room"], additionalProperties: false },
      label: (a) => `Leave the room ${roomName(a.room)}`,
      check: (a) => why(a.room),
      card: (a) => {
        const r = roomOf(a.room);
        const others = "refused" in r ? [] : r.members.slice(1);
        return {
          title: `Leave the room ${roomName(a.room)}`,
          detail: "This Mac leaves the room: teammates are told, their sessions go from your landscape, and what the room kept here goes. Joining again takes a new invite.",
          warnings: others.length ? [`${others.join(", ")} stay${others.length === 1 ? "s" : ""} in it without you.`] : [],
          danger: true,
        };
      },
      stillValid: (a) => !("refused" in roomOf(a.room)),
      run: async (a) => ({ text: await d.leaveRoom(room(a.room).id) }),
    }),
    defineTool<{ session: string }>({
      name: "take_over",
      tier: "confirm",
      description:
        "Take over a teammate's room session, as the room's Take over does: it continues on this Mac in a worktree on its branch, from its newest " +
        "snapshot, under the user's account; an online owner is asked first. The session is the teammate's, by its id in list_sessions. " +
        "This puts a card in front of the user; it runs only when they confirm.",
      inputSchema: { type: "object", properties: { session: SESSION_ARG }, required: ["session"], additionalProperties: false },
      label: (a) => `Take over ${d.takeoverTarget(a.session)?.title ? `“${d.takeoverTarget(a.session)!.title}”` : a.session}`,
      check: async (a) => {
        const p = await plan(a.session);
        return "refused" in p ? p.refused : null;
      },
      card: async (a): Promise<ToolCard> => {
        const p = await plan(a.session);
        if ("refused" in p) return { title: `Take over ${ref(a.session)}`, detail: p.refused, warnings: [] };
        const x = p.plan;
        const warnings: string[] = [];
        if (x.grant.kind === "offline") warnings.push(`${x.ownerName} is offline: it goes ahead without asking them.`);
        if (x.latestMissing) warnings.push("A newer snapshot was announced than any that reached this Mac.");
        if (x.originProblem) warnings.push(`Origin's backup couldn't be read: ${x.originProblem}`);
        if (x.conversation.kind === "partial") warnings.push(`Only part of the conversation reached this Mac (${x.conversation.have} of ${x.conversation.of}).`);
        if (x.conversation.kind === "none") warnings.push("None of the conversation reached this Mac: it starts from a brief of the snapshot.");
        return {
          title: `Take over ${ref(a.session)} from ${x.ownerName}`,
          detail:
            `Continues it on this Mac in a worktree${x.branch ? ` on ${x.branch}` : ""} of ${x.clone}, from ${x.snapshot ? `the snapshot of ${ago(x.snapshot.takenAt)}` : "its newest snapshot"}, ` +
            `under your account.${x.grant.kind === "ask" ? ` ${x.ownerName} is online: they're asked first, and their agent stops when they hand it over.` : ""}`,
          warnings,
        };
      },
      stillValid: (a) => !!d.takeoverTarget(a.session),
      target: (a) => ({ session: a.session, title: d.takeoverTarget(a.session)?.title ?? null }),
      run: async (a) => {
        const t = d.takeoverTarget(a.session);
        if (!t) throw new Error("That teammate's session isn't on this landscape any more");
        const id = await d.takeOver(t.roomId, t.sessionId);
        return { text: `Took over “${t.title}” from ${t.owner}: it runs on this Mac as session ${id}.` };
      },
    }),
    defineTool<{ room: string; on: boolean }>({
      name: "set_room_sandbox",
      tier: "confirm",
      description:
        "Switch a team room's sandbox on this Mac on or off, as Settings → Team does: the room's sessions started from then on run in it or not; " +
        "running ones keep how they started until they're restarted. This puts a card in front of the user; it runs only when they confirm.",
      inputSchema: { type: "object", properties: { room: ROOM_ARG, on: { type: "boolean", description: "true: sandboxed" } }, required: ["room", "on"], additionalProperties: false },
      label: (a) => `Switch ${roomName(a.room)}'s sandbox ${a.on ? "on" : "off"}`,
      check: (a) => {
        const r = roomOf(a.room);
        if ("refused" in r) return r.refused;
        const now = d.roomSandboxed(r.id);
        if (now === null) return `This Mac isn't in ${roomName(a.room)} now`;
        return now === a.on ? `Its sandbox is ${a.on ? "on" : "off"} already` : null;
      },
      card: (a) => ({
        title: `Switch ${roomName(a.room)}'s sandbox ${a.on ? "on" : "off"} on this Mac`,
        detail: a.on
          ? "This Mac's sessions in the room that start from now on run in the room's sandbox. Running ones keep how they started until they're restarted."
          : "This Mac's sessions in the room that start from now on run without the room's sandbox. Running ones keep how they started until they're restarted.",
        warnings: a.on ? [] : ["Without the sandbox, the room's agents on this Mac aren't held to the room's limits on what they can read and run."],
        ...(a.on ? {} : { danger: true }),
      }),
      stillValid: (a) => {
        const r = roomOf(a.room);
        return !("refused" in r) && d.roomSandboxed(r.id) === !a.on;
      },
      run: (a) => {
        d.setRoomSandbox(room(a.room).id, a.on);
        return { text: `Switched ${roomName(a.room)}'s sandbox ${a.on ? "on" : "off"} on this Mac.` };
      },
    }),
    defineTool<{ room: string; ticket: number; branch: string }>({
      name: "claim_ticket",
      tier: "confirm",
      description:
        "Claim a House ticket in a team room, as the board's Claim does: it's marked the user's, with its work on `branch`, and teammates see it. " +
        "This puts a card in front of the user; it runs only when they confirm.",
      inputSchema: {
        type: "object",
        properties: { room: ROOM_ARG, ticket: TICKET_ARG, branch: { type: "string", minLength: 1, maxLength: 250, description: "The git branch the work goes on" } },
        required: ["room", "ticket", "branch"],
        additionalProperties: false,
      },
      label: (a) => `Claim #${a.ticket} in ${roomName(a.room)}`,
      check: (a) => why(a.room) ?? (isTicketNumber(a.ticket) ? null : "A ticket number is a whole number") ?? (BRANCH_RE.test(a.branch) ? null : `“${a.branch}” isn't a branch name git accepts`),
      card: (a) => ({
        title: `Claim #${a.ticket} in ${roomName(a.room)}'s House`,
        detail: `Marks it yours on the room's House board, with its work on ${a.branch}. Teammates see it.`,
        warnings: [],
      }),
      stillValid: (a) => !("refused" in roomOf(a.room)),
      run: async (a) => ({ text: await d.houseWrite(room(a.room).id, { kind: "claim", n: a.ticket, branch: a.branch }) }),
    }),
    defineTool<{ room: string; ticket: number }>({
      name: "release_ticket",
      tier: "confirm",
      description: "Release a House ticket the user has claimed, as the board's Release does: it shows free to teammates. This puts a card in front of the user; it runs only when they confirm.",
      inputSchema: { type: "object", properties: { room: ROOM_ARG, ticket: TICKET_ARG }, required: ["room", "ticket"], additionalProperties: false },
      label: (a) => `Release #${a.ticket} in ${roomName(a.room)}`,
      check: (a) => why(a.room) ?? (isTicketNumber(a.ticket) ? null : "A ticket number is a whole number"),
      card: (a) => ({
        title: `Release #${a.ticket} in ${roomName(a.room)}'s House`,
        detail: "Takes your claim off it on the room's House board: teammates see it's free.",
        warnings: [],
      }),
      stillValid: (a) => !("refused" in roomOf(a.room)),
      run: async (a) => ({ text: await d.houseWrite(room(a.room).id, { kind: "release", n: a.ticket }) }),
    }),
  ];
}
