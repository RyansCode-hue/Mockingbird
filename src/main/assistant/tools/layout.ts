import { GAP, LOOSE_GROUP, SIZE_PRESETS, type Rect, type SizePreset } from "../../../shared/landscape";
import { newAreaPatch, planMakeArea, planMoveTile, planResizeTile, planStack, planTidy, planUnstack, presetFor, tileSize, type ReadyPlan, type TidyWire } from "../../../shared/landscapeModel";
import { plainLine } from "../../../shared/team/agentText";
import { groupKey, sanitizeSegment, splitGroupKey } from "../../../shared/types";
import type { GuardOp } from "../../sessionGuards";
import type { AssistantDeps } from "../deps";
import { areaName, carry, layoutNow, ready, undoable, workspaceOf, type LayoutNow } from "../layoutPlan";
import { defineTool, type AssistantTool, type ToolResult } from "../registry";
import { noSession, SESSION_ARG, sessionById, teammates, titleOf } from "./lookup";

/**
 * Layout (docs/assistant.md → Ability groups): the landscape and the groups, and small changes to where and how
 * sessions show, each with an Undo. Moves, stacks, sizes and Tidy are planned with the window's own planners
 * (layoutPlan.ts), so what the window would refuse is refused here. Rule-able: set_group, mute_session and unmute;
 * the rest move the user's view of things about, which a standing rule has no business doing unasked.
 */

type Deps = Pick<
  AssistantDeps,
  "sessions" | "groups" | "toWindow" | "rename" | "guard" | "landscapeState" | "layoutSessions" | "patchLandscape" | "setGroup" | "renameGroup" | "setMuted" | "muted" | "wireList"
>;

const TITLE_MAX = 120;
const NAME_MAX = 80;
const AREA_ARG = { type: "string" as const, minLength: 1, maxLength: NAME_MAX, description: "An area's key: a top-level group, from landscape or list_groups" };

/** A plan for a call, made against the landscape now, or why it can't be made. */
type Planned = { now: LayoutNow; plan: ReadyPlan } | { refused: string };

const rect = (r: Rect) => ({ x: r.x, y: r.y, w: r.w, h: r.h });

/** A group name the user gave, as a top-level key ("/" can't be in one), or null when nothing's left of it. */
const topName = (name: string): string | null => sanitizeSegment(plainLine(name, NAME_MAX)) || null;

export function layoutTools(d: Deps): AssistantTool[] {
  /** Why `op` can't be done to session `id` (unknown here, or the session guards' no), or null. */
  const guard = (id: string, op: GuardOp): string | null => (sessionById(d, id) ? d.guard(op, id) : noSession(id));
  const label = (id: string) => titleOf(sessionById(d, id), id);
  const target = (id: string) => ({ session: id, title: sessionById(d, id)?.title ?? null });

  /** A planning tool's check: its session's guard, then the plan's own refusal. */
  const checked = (plan: () => Planned, ...ids: [string, GuardOp][]) => (): string | null => {
    for (const [id, op] of ids) {
      const why = guard(id, op);
      if (why) return why;
    }
    const p = plan();
    return "refused" in p ? p.refused : null;
  };
  /** A planning tool's run: planned again against the landscape as it is now, carried out, with its Undo. */
  const carried = async (p: Planned, what: string, text: string, undone?: string): Promise<ToolResult> => {
    if ("refused" in p) throw new Error(p.refused);
    const done = await carry(d, p.now, p.plan, what);
    return undoable(d, p.now, p.plan, done, done.note ? `${text} ${done.note}.` : text, what, undone);
  };
  /** `make` over the landscape now, its refusal or its plan (ready: a plan that changes nothing says `unchanged`). */
  const planOn = (make: (now: LayoutNow) => Planned): Planned => {
    const now = layoutNow(d);
    return "refused" in now ? now : make(now);
  };
  const withPlan = (now: LayoutNow, plan: ReturnType<typeof ready>): Planned => ("refused" in plan ? plan : { now, plan });

  // ---- the plans ----
  const movePlan = (a: { session: string; area?: string; next_to?: string }): Planned =>
    planOn((now) => {
      if ((a.area === undefined) === (a.next_to === undefined)) return { refused: "Say where: an area, or another session to put it next to (one of them)" };
      const w = workspaceOf(now, a.session);
      if ("refused" in w) return w;
      if (a.area !== undefined) {
        if (!now.layout.areas.some((x) => x.key === a.area)) return { refused: `There's no area ${areaName(a.area)} on the landscape: create_group makes one` };
        // Move to area: placed in it where it has room, as a new workspace is, the area growing to hold it
        return withPlan(now, ready(planMakeArea(now.placed, now.layout, [w.tile.key], a.area, areaName), `It's in ${areaName(a.area)} already`));
      }
      const o = workspaceOf(now, a.next_to!);
      if ("refused" in o) return { refused: `${label(a.next_to!)}: ${o.refused}` };
      if (o.tile.key === w.tile.key) return { refused: "They're the same workspace" };
      // dropped just right of the other one, in its area: what's there is pushed aside, as a drag there would push it
      const at = { x: o.tile.rect.x + o.tile.rect.w + GAP, y: o.tile.rect.y };
      return withPlan(now, ready(planMoveTile(now.placed, now.layout, w.tile.key, at, o.tile.area, areaName), "It's there already"));
    });

  const stackPlan = (a: { sessions: string[] }): Planned =>
    planOn((now) => {
      const keys: string[] = [];
      for (const id of a.sessions) {
        const w = workspaceOf(now, id);
        if ("refused" in w) return { refused: `${label(id)}: ${w.refused}` };
        if (!keys.includes(w.tile.key)) keys.push(w.tile.key);
      }
      return withPlan(now, ready(planStack(now.placed, now.layout, keys, areaName), "They're one stack already"));
    });

  const unstackPlan = (a: { session: string }): Planned =>
    planOn((now) => {
      const w = workspaceOf(now, a.session);
      if ("refused" in w) return w;
      if (!w.tile.stack) return { refused: "It isn't in a stack" };
      // a tab dragged out, dropped just right of the stack in its area
      const at = { x: w.tile.rect.x + w.tile.rect.w + GAP, y: w.tile.rect.y };
      return withPlan(now, ready(planUnstack(now.placed, now.layout, a.session, at, w.tile.area, areaName), "It's out of the stack already"));
    });

  const sizePlan = (a: { session: string; size: SizePreset }): Planned =>
    planOn((now) => {
      const w = workspaceOf(now, a.session);
      if ("refused" in w) return w;
      const { current, blocked } = tileSize(w.tile, now.layout, areaName);
      if (blocked) return { refused: blocked };
      if (current === a.size) return { refused: `It's ${a.size} already` };
      return withPlan(now, ready(planResizeTile(now.placed, now.layout, w.tile.key, presetFor(w.tile, a.size), areaName), `It's ${a.size} already`));
    });

  const tidyPlan = (a: { area: string }): Planned & { wiresNote?: string } =>
    planOn((now) => {
      let wires: TidyWire[] = [];
      let wiresNote: string | undefined;
      try {
        wires = d.wireList();
      } catch (err) {
        // Tidy lays out along wires only as a refinement: without the book, it lays the area out in rows, and says so
        wiresNote = `its wires couldn't be read (${err instanceof Error ? err.message : String(err)}), so it's laid out in rows`;
      }
      const p = withPlan(now, ready(planTidy(now.placed, now.layout, a.area, areaName, wires), `${areaName(a.area)} is tidy already`));
      return "refused" in p ? p : { ...p, wiresNote };
    });

  const createPlan = (a: { name: string; sessions?: string[] }): Planned =>
    planOn((now) => {
      const key = topName(a.name);
      if (!key || key === LOOSE_GROUP) return { refused: `“${plainLine(a.name, NAME_MAX)}” can't name a group: pick another name` };
      if (d.groups().some((g) => g.key === key) || now.layout.areas.some((x) => x.key === key)) return { refused: `There's a group ${areaName(key)} already: move workspaces into it with move_workspace` };
      if (!a.sessions?.length) {
        const patch = newAreaPatch(now.stored, key, null);
        return patch ? { now, plan: { patch, moves: [], after: null } } : { refused: `There's an area ${areaName(key)} already` };
      }
      const keys: string[] = [];
      for (const id of a.sessions) {
        const w = workspaceOf(now, id);
        if ("refused" in w) return { refused: `${label(id)}: ${w.refused}` };
        if (!keys.includes(w.tile.key)) keys.push(w.tile.key);
      }
      // Make area…: a new area formed around them, moved clear of the others with them
      return withPlan(now, ready(planMakeArea(now.placed, now.layout, keys, key, areaName), "Nothing to move"));
    });

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
    defineTool<Record<string, never>>({
      name: "landscape",
      tier: "read",
      description:
        "The landscape as it's laid out now, in landscape px: each area (key, place and size, locked, collapsed), each workspace " +
        "(its sessions' ids, its stack and front tab, its area or null when loose, its size S/M/L or null when it's none of them, " +
        "place and size, hidden when its area is collapsed), and the closed workspaces drawn as ghosts.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      label: () => "Read the landscape",
      run: () => {
        const now = layoutNow(d);
        if ("refused" in now) throw new Error(now.refused);
        const { layout } = now;
        return {
          text: JSON.stringify({
            areas: layout.areas.map((a) => ({ key: a.key, ...rect(a.rect), ...(a.rect.locked ? { locked: true } : {}), ...(a.rect.collapsed ? { collapsed: true } : {}) })),
            workspaces: layout.tiles.map((t) => ({
              sessions: t.members.map((m) => m.id),
              ...(t.stack ? { stack: t.stack, front: t.front.id } : {}),
              area: t.area === LOOSE_GROUP ? null : t.area,
              size: tileSize(t, layout, areaName).current,
              ...rect(t.rect),
              ...(t.hidden ? { hidden: true } : {}),
            })),
            closed: layout.ghosts.map((g) => ({ sessions: g.members.map((m) => m.id), area: g.area === LOOSE_GROUP ? null : g.area })),
          }),
        };
      },
    }),
    defineTool<{ session: string }>({
      name: "focus_session",
      tier: "direct",
      description: "Bring a session's workspace to the front of the landscape, as clicking it would. A teammate's room session can be focused too.",
      inputSchema: { type: "object", properties: { session: SESSION_ARG }, required: ["session"], additionalProperties: false },
      label: (a) => `Focus ${label(a.session)}`,
      check: (a) => {
        const s = sessionById(d, a.session);
        if (!s) return noSession(a.session);
        // a teammate's is only looked at, which is theirs to allow by sharing the room
        return s.mine ? d.guard("focus", s.id) : null;
      },
      target: (a) => target(a.session),
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
      label: (a) => `Rename ${label(a.session)} to “${plainLine(a.title, TITLE_MAX)}”`,
      check: (a) => {
        const s = sessionById(d, a.session);
        if (!s) return noSession(a.session);
        const title = plainLine(a.title, TITLE_MAX);
        if (!title) return "The new title is empty";
        if (title === s.title) return `It's called “${title}” already`;
        return teammates(s, "rename it") ?? d.guard("rename", s.id);
      },
      target: (a) => target(a.session),
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
    defineTool<{ session: string; area?: string; next_to?: string }>({
      name: "move_workspace",
      tier: "direct",
      description:
        "Move a session's workspace (its whole stack, for a stack's tab) into an area (its group follows: placed where the area has room, " +
        "the area growing to hold it), or next to another session's workspace (just right of it, in its area, pushing what's there aside). " +
        "Give area or next_to, not both. Refused where the landscape refuses the drag: a locked area, a teammate's workspace across areas, a stack left loose.",
      inputSchema: {
        type: "object",
        properties: { session: SESSION_ARG, area: AREA_ARG, next_to: { ...SESSION_ARG, description: "The id of the session to put it next to" } },
        required: ["session"],
        additionalProperties: false,
      },
      label: (a) => (a.area !== undefined ? `Move ${label(a.session)} into ${areaName(a.area)}` : `Move ${label(a.session)} next to ${label(a.next_to ?? "")}`),
      check: (a) => checked(() => movePlan(a), [a.session, "group"])(),
      target: (a) => target(a.session),
      run: (a) => carried(movePlan(a), `${label(a.session)}'s place`, a.area !== undefined ? `Moved ${label(a.session)} into ${areaName(a.area)}.` : `Moved ${label(a.session)} next to ${label(a.next_to!)}.`),
    }),
    defineTool<{ sessions: string[] }>({
      name: "stack_workspaces",
      tier: "direct",
      description:
        "Stack two or more sessions' workspaces in one area into one card with a tab each (⌘G): the first stack among them takes the others in, " +
        "else a new one forms where the first of them is. A teammate's workspace stays out.",
      inputSchema: {
        type: "object",
        properties: { sessions: { type: "array", items: SESSION_ARG, minItems: 2, maxItems: 12, description: "The sessions' ids" } },
        required: ["sessions"],
        additionalProperties: false,
      },
      label: (a) => `Stack ${a.sessions.map(label).join(", ")}`,
      check: (a) => checked(() => stackPlan(a), ...a.sessions.map((id): [string, GuardOp] => [id, "group"]))(),
      target: (a) => target(a.sessions[0]),
      run: (a) => carried(stackPlan(a), "the stack", `Stacked ${a.sessions.map(label).join(", ")}.`),
    }),
    defineTool<{ session: string }>({
      name: "unstack",
      tier: "direct",
      description: "Take a session's tab out of its stack, as dragging the tab out does: it becomes a workspace of its own just right of the stack, in the same area.",
      inputSchema: { type: "object", properties: { session: SESSION_ARG }, required: ["session"], additionalProperties: false },
      label: (a) => `Take ${label(a.session)} out of its stack`,
      check: (a) => checked(() => unstackPlan(a), [a.session, "group"])(),
      target: (a) => target(a.session),
      run: (a) => carried(unstackPlan(a), `${label(a.session)}'s stack`, `Took ${label(a.session)} out of its stack.`, `Put ${label(a.session)} back in its stack`),
    }),
    defineTool<{ session: string; size: SizePreset }>({
      name: "size_workspace",
      tier: "direct",
      description: "Size a session's workspace (its stack's, for a tab) S, M or L, as its Size menu does; its terminal follows. Refused in a locked area and for a teammate's.",
      inputSchema: {
        type: "object",
        properties: { session: SESSION_ARG, size: { type: "string", enum: SIZE_PRESETS, description: "S, M or L" } },
        required: ["session", "size"],
        additionalProperties: false,
      },
      label: (a) => `Size ${label(a.session)} ${a.size}`,
      check: (a) => checked(() => sizePlan(a), [a.session, "focus"])(),
      target: (a) => target(a.session),
      run: (a) => carried(sizePlan(a), `${label(a.session)}'s size`, `Sized ${label(a.session)} ${a.size}.`),
    }),
    defineTool<{ area: string }>({
      name: "tidy_area",
      tier: "direct",
      description: "Tidy an area (T): its workspaces packed in rows in the order they were made, or along its wires when it has any, and the area fitted to them. Refused while it's locked or collapsed.",
      inputSchema: { type: "object", properties: { area: AREA_ARG }, required: ["area"], additionalProperties: false },
      label: (a) => `Tidy ${areaName(a.area)}`,
      check: (a) => {
        const p = tidyPlan(a);
        return "refused" in p ? p.refused : null;
      },
      run: (a) => {
        const p = tidyPlan(a);
        const note = "refused" in p ? null : (p.plan.note ?? null);
        const extra = "refused" in p ? undefined : p.wiresNote;
        return carried(p, `${areaName(a.area)}'s places`, `${note ?? `Tidied ${areaName(a.area)}`}${extra ? `: ${extra}` : ""}.`);
      },
    }),
    defineTool<{ session: string; group: string }>({
      name: "set_group",
      tier: "direct",
      rule: true,
      description:
        'Put a session in a group, as Move to group does: a top-level group ("atticus") or a stack in one ("atticus/api"); "" takes it out of every group. ' +
        "The landscape places it in that group's area. Can be a standing rule's action.",
      inputSchema: {
        type: "object",
        properties: { session: SESSION_ARG, group: { type: "string", maxLength: 2 * NAME_MAX + 1, description: 'The group\'s key, or "" for none' } },
        required: ["session", "group"],
        additionalProperties: false,
      },
      label: (a) => {
        const g = groupArg(a.group);
        return g && g.group ? `Move ${label(a.session)} to ${areaName(g.group)}` : `Take ${label(a.session)} out of its group`;
      },
      check: (a) => {
        const s = sessionById(d, a.session);
        if (!s) return noSession(a.session);
        const g = groupArg(a.group);
        if (!g) return `“${plainLine(a.group, NAME_MAX)}” can't name a group: pick another name`;
        if ((s.group ?? null) === g.group) return g.group ? `It's in ${areaName(g.group)} already` : "It's in no group already";
        return d.guard("group", s.id);
      },
      target: (a) => target(a.session),
      run: (a) => {
        const before = sessionById(d, a.session)?.group ?? null;
        const g = groupArg(a.group);
        if (!g) throw new Error(`“${plainLine(a.group, NAME_MAX)}” can't name a group`);
        const group = g.group;
        d.setGroup(a.session, group);
        const groupNow = () => sessionById(d, a.session)?.group ?? null;
        return {
          text: group ? `Moved ${label(a.session)} to ${areaName(group)}.` : `Took ${label(a.session)} out of its group.`,
          stillUndoable: () => groupNow() === group,
          undo: () => {
            if (groupNow() !== group) throw new Error("It was moved again since");
            d.setGroup(a.session, before);
            return before ? `Moved it back to ${areaName(before)}` : "Took it back out of every group";
          },
        };
      },
    }),
    defineTool<{ name: string; sessions?: string[] }>({
      name: "create_group",
      tier: "direct",
      description:
        "Make a new group, as Make area… does: with sessions, a new area forms around their workspaces and they move into it; " +
        "without, an empty area is added right of the others. Refused when a group of that name exists.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1, maxLength: NAME_MAX, description: "The new group's name" },
          sessions: { type: "array", items: SESSION_ARG, minItems: 1, maxItems: 24, description: "The sessions to move into it, by id" },
        },
        required: ["name"],
        additionalProperties: false,
      },
      label: (a) => `Make the group ${areaName(topName(a.name) ?? a.name)}${a.sessions?.length ? ` of ${a.sessions.map(label).join(", ")}` : ""}`,
      check: (a) => checked(() => createPlan(a), ...(a.sessions ?? []).map((id): [string, GuardOp] => [id, "group"]))(),
      run: (a) => {
        const name = areaName(topName(a.name) ?? a.name);
        return carried(createPlan(a), `the group ${name}`, `Made the group ${name}.`, `Took the group ${name} away${a.sessions?.length ? ", its sessions back where they were" : ""}`);
      },
    }),
    defineTool<{ group: string; name: string }>({
      name: "rename_group",
      tier: "direct",
      description:
        'Rename a group, as its Rename does: a top-level group ("atticus"), or a stack ("atticus/api": the name is then the stack\'s part). ' +
        "Its area, its sessions, its team room and its artifacts follow. Refused when a group of the new name exists.",
      inputSchema: {
        type: "object",
        properties: {
          group: { type: "string", minLength: 1, maxLength: 2 * NAME_MAX + 1, description: "The group's key, from list_groups" },
          name: { type: "string", minLength: 1, maxLength: NAME_MAX, description: "Its new name" },
        },
        required: ["group", "name"],
        additionalProperties: false,
      },
      label: (a) => `Rename ${areaName(a.group)} to ${areaName(renamed(a) ?? a.name)}`,
      check: (a) => {
        const to = renamed(a);
        if (!groupExists(a.group)) return `There's no group ${areaName(a.group)}: the groups are in list_groups`;
        if (!to || splitGroupKey(to).top === LOOSE_GROUP) return `“${plainLine(a.name, NAME_MAX)}” can't name a group: pick another name`;
        if (to === a.group) return `It's called ${areaName(to)} already`;
        if (groupExists(to)) return `There's a group ${areaName(to)} already: renaming into it would merge the two, which can't be undone`;
        return null;
      },
      run: (a) => {
        const to = renamed(a)!;
        d.renameGroup(a.group, to);
        const still = () => groupExists(to) && !groupExists(a.group);
        return {
          text: `Renamed ${areaName(a.group)} to ${areaName(to)}.`,
          stillUndoable: still,
          undo: () => {
            if (!still()) throw new Error(`${areaName(to)} was renamed again since, or ${areaName(a.group)} is back`);
            d.renameGroup(to, a.group);
            return `Renamed back to ${areaName(a.group)}`;
          },
        };
      },
    }),
    ...([true, false] as const).map((on) =>
      defineTool<{ session: string }>({
        name: on ? "mute_session" : "unmute",
        tier: "direct",
        rule: true,
        description: on
          ? "Mute a session: no notifications or phone alerts from it until it's unmuted. Can be a standing rule's action."
          : "Unmute a muted session: its notifications come again. Can be a standing rule's action.",
        inputSchema: { type: "object", properties: { session: SESSION_ARG }, required: ["session"], additionalProperties: false },
        label: (a) => `${on ? "Mute" : "Unmute"} ${label(a.session)}`,
        check: (a) => {
          const why = guard(a.session, "mute");
          if (why) return why;
          const muted = d.muted(a.session);
          if (muted === null) return "It isn't open here";
          return muted === on ? `It's ${on ? "muted" : "unmuted"} already` : null;
        },
        target: (a) => target(a.session),
        run: (a) => {
          d.setMuted(a.session, on);
          return {
            text: `${on ? "Muted" : "Unmuted"} ${label(a.session)}.`,
            stillUndoable: () => d.muted(a.session) === on,
            undo: () => {
              if (d.muted(a.session) !== on) throw new Error(`It was ${on ? "unmuted" : "muted"} again since`);
              d.setMuted(a.session, !on);
              return on ? "Unmuted it" : "Muted it again";
            },
          };
        },
      })
    ),
  ];

  /** A group key the model gave: "" or the ungrouped bucket for none, "top/sub" kept as one; null when it can't be one. */
  function groupArg(raw: string): { group: string | null } | null {
    const line = plainLine(raw, 2 * NAME_MAX + 1).trim();
    if (!line) return { group: null };
    const { top, sub } = splitGroupKey(line);
    const t = sanitizeSegment(top);
    if (!t) return null;
    if (t === LOOSE_GROUP) return sub ? null : { group: null };
    return { group: groupKey(t, sub) };
  }

  /** Whether group `key` exists: a top-level group or one of its stacks. */
  function groupExists(key: string): boolean {
    return d.groups().some((g) => g.key === key || g.stacks.includes(key));
  }

  /** Rename_group's new key: a top-level name, or the stack's sub-name under its own top. */
  function renamed(a: { group: string; name: string }): string | null {
    const { top, sub } = splitGroupKey(a.group);
    const name = topName(a.name);
    if (!name) return null;
    return sub ? groupKey(top, name) : name;
  }
}
