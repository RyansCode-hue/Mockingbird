import { plainLine } from "../../../shared/team/agentText";
import type { AssistantDeps } from "../deps";
import { defineTool, type AssistantTool } from "../registry";
import { noSession, SESSION_ARG, sessionById, teammates, titleOf } from "./lookup";

/** Layout (docs/assistant.md → Ability groups): the groups, and small changes to where and how sessions show. */

type Deps = Pick<AssistantDeps, "sessions" | "groups" | "toWindow" | "rename">;

const TITLE_MAX = 120;

export function layoutTools(d: Deps): AssistantTool[] {
  return [
    defineTool<Record<string, never>>({
      name: "list_groups",
      tier: "read",
      description:
        "The user's groups (each an area of the landscape): key, its stacks (sub-groups shown as one card with a tab per session), " +
        "how many of this Mac's sessions run in it, the team room it's shared as, and whether it has an area on the landscape.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      label: () => "Listed the groups",
      run: () => ({ text: JSON.stringify({ groups: d.groups() }) }),
    }),
    defineTool<{ session: string }>({
      name: "focus_session",
      tier: "direct",
      description: "Bring a session's workspace to the front of the landscape, as clicking it would. A teammate's room session can be focused too.",
      inputSchema: { type: "object", properties: { session: SESSION_ARG }, required: ["session"], additionalProperties: false },
      label: (a) => `Focus ${titleOf(sessionById(d, a.session), a.session)}`,
      check: (a) => (sessionById(d, a.session) ? null : noSession(a.session)),
      target: (a) => ({ session: a.session, title: sessionById(d, a.session)?.title ?? null }),
      run: (a) => {
        const s = sessionById(d, a.session);
        d.toWindow({ kind: "focus", sessionId: a.session });
        return { text: `Focused ${titleOf(s, a.session)}.` };
      },
    }),
    defineTool<{ session: string; title: string }>({
      name: "rename_session",
      tier: "direct",
      description: "Rename one of this Mac's sessions: the title its workspace shows. The user can Undo it.",
      inputSchema: {
        type: "object",
        properties: { session: SESSION_ARG, title: { type: "string", minLength: 1, maxLength: TITLE_MAX, description: "The new title, one line" } },
        required: ["session", "title"],
        additionalProperties: false,
      },
      label: (a) => `Rename ${titleOf(sessionById(d, a.session), a.session)} to “${plainLine(a.title, TITLE_MAX)}”`,
      check: (a) => {
        const s = sessionById(d, a.session);
        if (!s) return noSession(a.session);
        const title = plainLine(a.title, TITLE_MAX);
        if (!title) return "The new title is empty";
        if (title === s.title) return `It's called “${title}” already`;
        return teammates(s, "rename it");
      },
      target: (a) => ({ session: a.session, title: sessionById(d, a.session)?.title ?? null }),
      run: (a) => {
        const before = sessionById(d, a.session)!.title;
        const title = plainLine(a.title, TITLE_MAX);
        d.rename(a.session, title);
        return {
          text: `Renamed “${before}” to “${title}”.`,
          // put back only over its own rename: a title changed again since is the user's
          stillUndoable: () => sessionById(d, a.session)?.title === title,
          undo: () => {
            if (sessionById(d, a.session)?.title !== title) throw new Error("It was renamed again since");
            d.rename(a.session, before);
            return `Renamed back to “${before}”`;
          },
        };
      },
    }),
  ];
}
