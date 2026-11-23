import { closeWarningLines } from "../../../shared/closing";
import { PERMISSION_MODE_LABEL, PERMISSION_MODES, WIDER_MODES, type PermissionMode } from "../../../shared/permissionModes";
import { plainLine } from "../../../shared/team/agentText";
import { AGENT_NAME, topOfKey, type AgentKind, type RelaunchChange, type SessionInfo } from "../../../shared/types";
import { CLAUDE_EFFORTS, widerModeWarning } from "../../agents";
import type { GuardOp } from "../../sessionGuards";
import type { AssistantDeps, AssistantRoom, AssistantSession } from "../deps";
import { defineTool, type AssistantTool, type JsonSchema } from "../registry";
import { joinsRoomWarning, noSession, roomJoined, SESSION_ARG, sessionById, sessionRef, teammates, titleOf } from "./lookup";

/** Sessions (docs/assistant.md → Ability groups): what's running and how; restarting, closing, resuming and handing off. */

type Deps = Pick<
  AssistantDeps,
  | "sessions"
  | "plannedSteps"
  | "closedSessions"
  | "groups"
  | "rooms"
  | "relaunchRefusal"
  | "relaunch"
  | "guards"
  | "takenOver"
  | "record"
  | "describeRelaunch"
  | "relaunchWith"
  | "close"
  | "resume"
  | "reopen"
  | "briefStart"
  | "handoffStart"
>;

// ---- shared by the sessions, start work, triage, git and diagnose tools ----------------------------

/** A session's title as a step's line names it: from the landscape's sessions, else this Mac's closed ones. */
export function nameOf(d: Pick<AssistantDeps, "sessions" | "record">, id: string): string {
  const s = sessionById(d, id);
  if (s) return titleOf(s, id);
  const r = d.record(id)?.info;
  return r ? `“${plainLine(r.ticketTitle ?? r.title, 120)}”` : titleOf(null, id);
}

/**
 * Why `op` can't be done to session `id` on the user's behalf now, or null: no such session, a teammate's (named, as
 * only its owner can `what`), then main's session guards (sessionGuards.ts whyNot), which refuse what they would for
 * anyone: the Helpdesk workspace's conversation, a copy a teammate took over, one that isn't running.
 */
export function refusal(d: Pick<AssistantDeps, "sessions" | "record" | "guards">, id: string, op: GuardOp, what: string): string | null {
  const s = sessionById(d, id);
  if (s && !s.mine) return teammates(s, what);
  if (!s && !d.record(id)) return noSession(id);
  return d.guards.whyNot(op, id);
}

/** This Mac's session `id` as main keeps it, open here; null when it's closed, a teammate's or unknown. */
export function openRecord(d: Pick<AssistantDeps, "record">, id: string): SessionInfo | null {
  const r = d.record(id);
  return r?.open ? r.info : null;
}

/** What a card warns of a permission mode it gives a session: what its agent then does without asking. */
export const modeWarnings = (mode: PermissionMode | undefined, agent: AgentKind): string[] => (mode && WIDER_MODES.has(mode) ? [widerModeWarning(mode, agent)] : []);

/** An ISO time, or null. */
export const iso = (ms: number | null | undefined): string | null => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null);

/** A tool argument naming a group: a top-level group's key, or a stack's ("5038/api"). */
export const GROUP_ARG: JsonSchema = { type: "string", minLength: 1, maxLength: 120, description: "The group's key, from the snapshot or list_groups (a stack's is top/sub)" };

/** Whether group `key` is one the landscape has: a top-level group, or one of their stacks. */
export const groupKnown = (d: Pick<AssistantDeps, "groups">, key: string): boolean => d.groups().some((g) => g.key === key || g.stacks.includes(key));

/** This Mac's running agent sessions in group `key` (a top-level one takes in its stacks'), terminals and exited panes left out. */
export function agentsIn(d: Pick<AssistantDeps, "sessions">, key: string): AssistantSession[] {
  const inGroup = (g: string | null) => !!g && (key.includes("/") ? g === key : topOfKey(g) === key);
  return d.sessions().filter((s) => s.mine && s.agent !== "terminal" && s.status !== "dead" && inGroup(s.group));
}

/** Whether two lists of ids hold the same ids. */
export const sameIds = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && [...a].sort().join("\0") === [...b].sort().join("\0");

/**
 * What a card saw when it was made, kept by the call's own arguments (the service hands a card's Do it and its expiry
 * check the very object its card was made from): a card whose state was never seen holds nothing, so a rule's run,
 * which has no card, reads the state then.
 */
export const cardSaw = <T>() => new WeakMap<object, T>();

/**
 * The team room each card that starts a session said it joins (its id; null: none), by its call's arguments: a group
 * shared as a room since the card, or a room left, makes it another card, whose warnings would differ.
 */
export function roomCards() {
  const saw = cardSaw<string | null>();
  return {
    shown: (a: object, room: AssistantRoom | null): void => void saw.set(a, room?.id ?? null),
    same: (a: object, room: AssistantRoom | null): boolean => !saw.has(a) || saw.get(a) === (room?.id ?? null),
  };
}

// ---- the tools ------------------------------------------------------------------------------------

/** How many closed sessions list_sessions lists: the rest are counted. */
const CLOSED_LISTED = 60;

/** A session as list_sessions gives it: its state, never its output. */
function listed(s: AssistantSession) {
  return {
    id: s.id,
    title: s.title,
    agent: s.agent,
    status: s.status,
    ...(s.status === "waiting" ? { waiting: { reason: s.waitingReason, since: s.waitingSince ? new Date(s.waitingSince).toISOString() : null } } : {}),
    group: s.group,
    room: s.room,
    repo: s.repo,
    branch: s.branch,
    model: s.model,
    permissionMode: s.permissionMode,
    ...(s.mine ? { mine: true } : { mine: false, owner: s.owner ?? null }),
    ...(s.helpdesk ? { helpdesk: true } : {}),
  };
}

type RestartArgs = { session: string; permissionMode?: PermissionMode; model?: string; effort?: string };

const changeOf = (a: RestartArgs): RelaunchChange => ({
  ...(a.permissionMode !== undefined ? { permissionMode: a.permissionMode } : {}),
  ...(a.model !== undefined ? { model: a.model } : {}),
  ...(a.effort !== undefined ? { effort: a.effort } : {}),
});

/** " in Plan mode, on opus, at high effort": what a restart changes, as its line says it. */
function changeWords(c: RelaunchChange): string {
  const parts = [
    ...(c.permissionMode ? [`in ${PERMISSION_MODE_LABEL[c.permissionMode]}`] : []),
    ...(c.model ? [`on ${plainLine(c.model, 80)}`] : []),
    ...(c.effort ? [`at ${c.effort} effort`] : []),
  ];
  return parts.length ? ` ${parts.join(", ")}` : "";
}

export const MODE_ARG: JsonSchema = {
  type: "string",
  enum: PERMISSION_MODES,
  description: "Its permission mode: default (ask as usual), plan, acceptEdits, auto or bypass (bypass permissions: it asks nothing)",
};
// main's readRelaunchChange holds a model and an effort to what each agent takes
export const MODEL_ARG: JsonSchema = { type: "string", minLength: 1, maxLength: 80, description: "A model name or alias, as its agent takes it (opus, sonnet, gpt-5.1-codex…)" };
export const EFFORT_ARG: JsonSchema = { type: "string", enum: CLAUDE_EFFORTS, description: "Its effort: low, medium, high, xhigh or max (Codex has no max)" };

export function sessionTools(d: Deps): AssistantTool[] {
  const target = (a: { session: string }) => ({ session: a.session, title: sessionById(d, a.session)?.title ?? d.record(a.session)?.info.title ?? null });
  const groupSaw = cardSaw<string[]>();
  const resumeSaw = cardSaw<"resume" | "reopen">();
  const handoffRoom = roomCards();
  /** The team room a handoff's fresh session joins: it starts in its session's group. */
  const handoffJoins = (id: string) => {
    const s = openRecord(d, id);
    return { group: s?.taskGroup ?? null, room: roomJoined(d, s?.taskGroup, s?.role) };
  };

  return [
    defineTool<Record<string, never>>({
      name: "list_sessions",
      tier: "read",
      description:
        "Every session on the user's landscape: this Mac's own and teammates' room sessions (mine false, with their owner). " +
        "For each: id, title, agent, status (working, waiting, idle, dead), why and since when it waits on the user, group, team room, repo, branch, model, " +
        "permission mode, and whether it's the Helpdesk workspace. Then, apart, this Mac's steps not started yet and its closed sessions (drawn as ghosts): " +
        "id, title, agent, state (not started or closed), group, model and effort. It never includes what a session printed.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      label: () => "Listed the sessions",
      run: () => {
        const ghost = (s: SessionInfo, state: "not started" | "closed") => ({
          id: s.id,
          title: s.ticketTitle ?? s.title,
          agent: s.shell ? "terminal" : (s.agent ?? "claude"),
          state,
          group: s.taskGroup ?? null,
          ...(s.shell ? {} : { model: s.model ?? null, effort: s.effort ?? null }),
        });
        const closed = d.closedSessions();
        const notRunning = [...d.plannedSteps().map((s) => ghost(s, "not started")), ...closed.slice(0, CLOSED_LISTED).map((s) => ghost(s, "closed"))];
        return {
          text: JSON.stringify({
            sessions: d.sessions().map(listed),
            notRunning,
            ...(closed.length > CLOSED_LISTED ? { closedNotListed: closed.length - CLOSED_LISTED } : {}),
          }),
        };
      },
    }),

    defineTool<RestartArgs>({
      name: "restart_session",
      tier: "confirm",
      description:
        "Restart one of this Mac's sessions in place: its agent is stopped and started again on the same conversation, in the same folder, " +
        "optionally in another permission mode, model or effort (each kept for its later restarts). This puts a card in front of the user; it runs only when they confirm.",
      inputSchema: {
        type: "object",
        properties: { session: SESSION_ARG, permissionMode: MODE_ARG, model: MODEL_ARG, effort: EFFORT_ARG },
        required: ["session"],
        additionalProperties: false,
      },
      label: (a) => `Restart ${nameOf(d, a.session)}${changeWords(changeOf(a))}`,
      describe: (a) => {
        const c = changeOf(a);
        const s = sessionById(d, a.session);
        return {
          line: `Restart ${sessionRef(d, a.session)}${changeWords(c)}`,
          warnings: modeWarnings(c.permissionMode, s && s.agent !== "terminal" ? s.agent : "claude"),
          ...(c.permissionMode === "bypass" ? { danger: true } : {}),
        };
      },
      check: (a) => refusal(d, a.session, "relaunch", "restart it") ?? d.describeRelaunch(a.session, changeOf(a)).blocked,
      card: (a) => {
        const c = changeOf(a);
        const { warnings } = d.describeRelaunch(a.session, c);
        return {
          title: `Restart ${sessionRef(d, a.session)}${changeWords(c)}`,
          detail: `Stops its agent and starts it again on the same conversation, in the same folder${c.permissionMode || c.model || c.effort ? `, now${changeWords(c)}` : ""}. Nothing in its folder changes.`,
          warnings,
          ...(c.permissionMode === "bypass" ? { danger: true } : {}),
        };
      },
      stillValid: (a) => !!openRecord(d, a.session),
      target,
      run: async (a) => {
        const c = changeOf(a);
        await d.relaunchWith(a.session, c);
        return { text: `Restarted ${nameOf(d, a.session)}${changeWords(c)}.` };
      },
      rule: true,
    }),

    defineTool<{ group: string }>({
      name: "restart_group",
      tier: "confirm",
      description:
        "Restart every running agent session of this Mac's in a group (a top-level group takes in its stacks'), each on its own conversation, as Restart does one. " +
        "Terminals and exited panes are left alone. This puts a card in front of the user listing them; it runs only when they confirm.",
      inputSchema: { type: "object", properties: { group: GROUP_ARG }, required: ["group"], additionalProperties: false },
      label: (a) => `Restart the sessions in “${plainLine(a.group, 120)}”`,
      check: (a) => {
        if (!groupKnown(d, a.group)) return `There's no group “${plainLine(a.group, 120)}”: the groups are in the snapshot and list_groups`;
        const all = agentsIn(d, a.group);
        if (!all.length) return `No agent session of this Mac's runs in “${plainLine(a.group, 120)}”`;
        const whys = all.map((s) => d.relaunchRefusal(s.id));
        if (whys.every(Boolean)) return `None of them can be restarted now: ${all.map((s, i) => `${titleOf(s, s.id)}: ${whys[i]}`).join("; ")}`;
        return null;
      },
      card: (a) => {
        const all = agentsIn(d, a.group);
        const ok = all.filter((s) => !d.relaunchRefusal(s.id));
        groupSaw.set(a, ok.map((s) => s.id));
        const ref = (s: AssistantSession) => sessionRef(d, s.id);
        return {
          title: `Restart ${ok.length === 1 ? "1 session" : `${ok.length} sessions`} in “${plainLine(a.group, 120)}”`,
          detail: `Stops each one's agent and starts it again on the same conversation: ${ok.map(ref).join(", ") || "none"}.`,
          warnings: [
            ...ok.filter((s) => s.status === "working").map((s) => `${ref(s)} is mid-turn: restarting stops the turn it's on`),
            ...ok.filter((s) => s.status === "waiting").map((s) => `${ref(s)} is waiting on you: restarting drops the prompt it's showing`),
            ...all.filter((s) => !ok.includes(s)).map((s) => `${ref(s)} is left out: ${d.relaunchRefusal(s.id)}`),
          ],
        };
      },
      // the card names who it restarts: a session joining or leaving the group since makes it another card
      stillValid: (a) => {
        const saw = groupSaw.get(a);
        return !saw || sameIds(saw, agentsIn(d, a.group).filter((s) => !d.relaunchRefusal(s.id)).map((s) => s.id));
      },
      run: async (a) => {
        const ids = groupSaw.get(a) ?? agentsIn(d, a.group).map((s) => s.id);
        const done: string[] = [];
        const left: string[] = [];
        const failed: string[] = [];
        for (const id of ids) {
          const why = d.relaunchRefusal(id);
          if (why) {
            left.push(`${nameOf(d, id)} (${why})`);
            continue;
          }
          try {
            await d.relaunch(id);
            done.push(nameOf(d, id));
          } catch (err) {
            failed.push(`${nameOf(d, id)} (${err instanceof Error ? err.message : String(err)})`);
          }
        }
        const text = [
          done.length ? `Restarted ${done.join(", ")}.` : "",
          left.length ? `Left out: ${left.join(", ")}.` : "",
          failed.length ? `Failed: ${failed.join(", ")}.` : "",
        ]
          .filter(Boolean)
          .join(" ");
        if (!done.length) throw new Error(text || "Nothing was restarted");
        return { text };
      },
      rule: true,
    }),

    defineTool<{ session: string }>({
      name: "close_session",
      tier: "confirm",
      description:
        "Close one of this Mac's sessions: its pane closes and its agent stops. It's kept in Closed sessions, its conversation and folder as they are, " +
        "so resume_session reopens it. This puts a card in front of the user saying what's at stake; it runs only when they confirm.",
      inputSchema: { type: "object", properties: { session: SESSION_ARG }, required: ["session"], additionalProperties: false },
      label: (a) => `Close ${nameOf(d, a.session)}`,
      describe: (a) => ({ line: `Close ${sessionRef(d, a.session)}, kept in Closed sessions to reopen` }),
      check: (a) => refusal(d, a.session, "kill", "close it") ?? (openRecord(d, a.session) ? null : "It's closed already: resume_session reopens it"),
      card: async (a) => ({
        title: `Close ${sessionRef(d, a.session)}`,
        detail: "Closes its pane and stops its agent. It stays in Closed sessions with its conversation and folder, so it can be reopened.",
        warnings: openRecord(d, a.session) ? closeWarningLines(await d.guards.closeWarnings(a.session)) : [],
      }),
      stillValid: (a) => !!openRecord(d, a.session),
      target,
      run: (a) => {
        const name = nameOf(d, a.session);
        d.close(a.session);
        return { text: `Closed ${name}: it can be reopened from Closed sessions.` };
      },
      rule: true,
    }),

    defineTool<{ session: string }>({
      name: "resume_session",
      tier: "confirm",
      description:
        "Bring back one of this Mac's sessions on its conversation: an exited pane's agent starts again in it, and a closed session reopens from Closed sessions. " +
        "This puts a card in front of the user; it runs only when they confirm.",
      inputSchema: { type: "object", properties: { session: SESSION_ARG }, required: ["session"], additionalProperties: false },
      label: (a) => `Resume ${nameOf(d, a.session)}`,
      describe: (a) => ({ line: `Resume ${sessionRef(d, a.session)} on its conversation (an exited pane in place, a closed session reopened)` }),
      check: (a) => {
        const r = d.record(a.session);
        if (!r) return refusal(d, a.session, "resume", "resume it");
        if (r.open && r.info.status !== "dead") return "It's running already";
        // an exited pane resumes in place; a closed session reopens, which is a relaunch's checks
        return r.open ? refusal(d, a.session, "resume", "resume it") : refusal(d, a.session, "relaunch", "reopen it");
      },
      card: (a) => {
        const how = d.record(a.session)?.open ? "resume" : "reopen";
        resumeSaw.set(a, how);
        return how === "resume"
          ? { title: `Resume ${sessionRef(d, a.session)}`, detail: "Starts its agent again in its pane, on the same conversation and in the same folder.", warnings: [] }
          : { title: `Reopen ${sessionRef(d, a.session)}`, detail: "Opens it again from Closed sessions: its agent resumes the same conversation, in its folder.", warnings: [] };
      },
      // an exited pane closed since, or a closed session reopened since, is another card's
      stillValid: (a) => {
        const r = d.record(a.session);
        const saw = resumeSaw.get(a);
        return !!r && (!r.open || r.info.status === "dead") && (!saw || saw === (r.open ? "resume" : "reopen"));
      },
      target,
      run: async (a) => {
        const r = d.record(a.session);
        if (!r) throw new Error("It isn't on this Mac any more");
        if (r.open) await d.resume(a.session);
        else await d.reopen(a.session);
        return { text: `${r.open ? "Resumed" : "Reopened"} ${nameOf(d, a.session)}.` };
      },
      rule: true,
    }),

    defineTool<{ session: string; to?: "same" | "other" }>({
      name: "handoff_session",
      tier: "confirm",
      description:
        "Hand one of this Mac's sessions off to a fresh session in its folder and group, on its branch as it stands: to: same (default) starts the same agent from a brief " +
        "of its conversation (its branch, changes, plan and latest turns); to: other has the other agent write a handoff from it and start from that. The session itself keeps running. " +
        "This puts a card in front of the user; it runs only when they confirm.",
      inputSchema: {
        type: "object",
        properties: { session: SESSION_ARG, to: { type: "string", enum: ["same", "other"], description: "same: the same agent, from a brief; other: the other agent, from a handoff it writes" } },
        required: ["session"],
        additionalProperties: false,
      },
      label: (a) => `Hand ${nameOf(d, a.session)} off to a fresh session`,
      check: (a) => {
        // a brief or a handoff carries its conversation to another session: the Helpdesk workspace's never goes
        const why = refusal(d, a.session, "readOutput", "hand it off");
        if (why) return why;
        const s = openRecord(d, a.session);
        if (!s) return "It isn't open here: resume it first";
        if (s.shell) return "It's a terminal: it has no agent conversation to hand off";
        return d.takenOver(a.session, a.to === "other" ? "handoff:start" : "usage:briefStart");
      },
      card: (a) => {
        const s = openRecord(d, a.session);
        const from = s?.agent ?? "claude";
        const to = a.to === "other" ? (from === "claude" ? "codex" : "claude") : from;
        const { group, room } = handoffJoins(a.session);
        handoffRoom.shown(a, room);
        return {
          title: `Hand ${sessionRef(d, a.session)} off to a fresh ${AGENT_NAME[to]} session`,
          detail:
            a.to === "other"
              ? `${AGENT_NAME[to]} writes a handoff from its conversation, then a ${AGENT_NAME[to]} session starts from it in the same folder and group, on its branch as it stands. It keeps running.`
              : `A fresh ${AGENT_NAME[to]} session starts in the same folder and group, from a brief of its conversation: its branch, changes, plan and latest turns. It keeps running.`,
          warnings: [...(a.to === "other" ? [`Writing the handoff takes ${AGENT_NAME[to]} up to 4 minutes`] : []), ...(room && group ? [joinsRoomWarning(room, group)] : [])],
          ...(room ? { danger: true } : {}),
        };
      },
      stillValid: (a) => !!openRecord(d, a.session) && handoffRoom.same(a, handoffJoins(a.session).room),
      target,
      run: async (a) => {
        const next = a.to === "other" ? await d.handoffStart(a.session) : await d.briefStart(a.session);
        return { text: `Started “${plainLine(next.ticketTitle ?? next.title, 120)}” (${next.id}) from ${nameOf(d, a.session)}.` };
      },
    }),
  ];
}
