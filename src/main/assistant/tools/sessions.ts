import type { AssistantDeps, AssistantSession } from "../deps";
import { defineTool, type AssistantTool } from "../registry";
import { noSession, SESSION_ARG, sessionById, teammates, titleOf } from "./lookup";

/** Sessions (docs/assistant.md → Ability groups): what's running and how, and restarting one. */

type Deps = Pick<AssistantDeps, "sessions" | "relaunchRefusal" | "relaunch">;

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

export function sessionTools(d: Deps): AssistantTool[] {
  return [
    defineTool<Record<string, never>>({
      name: "list_sessions",
      tier: "read",
      description:
        "Every session on the user's landscape: this Mac's own and teammates' room sessions (mine false, with their owner). " +
        "For each: id, title, agent, status (working, waiting, idle, dead), why and since when it waits on the user, group, team room, repo, branch, model, " +
        "permission mode, and whether it's the Helpdesk workspace. It never includes what a session printed.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      label: () => "Listed the sessions",
      run: () => ({ text: JSON.stringify({ sessions: d.sessions().map(listed) }) }),
    }),
    defineTool<{ session: string }>({
      name: "relaunch_session",
      tier: "confirm",
      description:
        "Restart one of this Mac's sessions in place: its agent is stopped and started again on the same conversation, in the same folder. " +
        "This puts a card in front of the user; it runs only when they confirm.",
      inputSchema: { type: "object", properties: { session: SESSION_ARG }, required: ["session"], additionalProperties: false },
      label: (a) => `Restart ${titleOf(sessionById(d, a.session), a.session)}`,
      check: (a) => {
        const s = sessionById(d, a.session);
        if (!s) return noSession(a.session);
        return teammates(s, "restart it") ?? d.relaunchRefusal(s.id);
      },
      card: (a) => {
        const s = sessionById(d, a.session);
        const warnings: string[] = [];
        if (s?.status === "working") warnings.push("It's working: restarting stops its current turn.");
        if (s?.status === "waiting") warnings.push(`It's waiting on you${s.waitingReason ? ` (${s.waitingReason})` : ""}: restarting drops that question.`);
        return {
          title: `Restart ${titleOf(s, a.session)}`,
          detail: "Stops its agent and starts it again on the same conversation, in the same folder. Nothing in its folder changes.",
          warnings,
        };
      },
      stillValid: (a) => !!sessionById(d, a.session)?.mine,
      target: (a) => ({ session: a.session, title: sessionById(d, a.session)?.title ?? null }),
      run: async (a) => {
        const s = sessionById(d, a.session);
        await d.relaunch(a.session);
        return { text: `Restarted ${titleOf(s, a.session)}.` };
      },
    }),
  ];
}
