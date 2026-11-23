import { isWorkspaceTool, TOOL_KINDS, TOOL_NAME, type ToolKind, type ToolWindow } from "../../../shared/landscape";
import { ACCENT_NAMES, automaticAccent, pipelinesIn } from "../../../shared/landscapeModel";
import { plainLine } from "../../../shared/team/agentText";
import type { AssistantDeps } from "../deps";
import { areaName, layoutNow, tileOf } from "../layoutPlan";
import { defineTool, type AssistantTool, type ToolResult } from "../registry";
import { noSession, roomOfGroup, SESSION_ARG, sessionById, titleOf } from "./lookup";

/**
 * Layout's look (docs/assistant.md → Ability groups), all direct with an Undo: an area's colour, as its Colour… sets it,
 * and tool windows (Files, Changes, Search, Run & debug beside a workspace; Artifacts and Chat in an area; or docked).
 * A window is opened by the window itself (`assistant:window` openTool, its own Show), which places it, or docks it when
 * its area has no room; one is closed, and an Undo puts back what changed, through the landscape as the window's ×
 * does. Main refuses what the window's own buttons would: a workspace tool on a teammate's session, or on an exited one
 * but Search; Chat outside a team room's area. None is a standing rule's: they change what the user is looking at.
 */

type Deps = Pick<AssistantDeps, "sessions" | "rooms" | "record" | "toWindow" | "landscapeState" | "layoutSessions" | "patchLandscape" | "setGroup" | "wireList">;

type ColourArgs = { group: string; colour: string };
type ToolArgs = { kind: ToolKind; session?: string; group?: string; docked?: boolean };

const AUTOMATIC = "Automatic";
const AREA_ARG = { type: "string" as const, minLength: 1, maxLength: 80, description: "An area's key: a top-level group, from landscape or list_groups" };

/** A colour as the Colour popover names it: its accent number, null for Automatic; undefined when it isn't one. */
export function accentNamed(name: string): number | null | undefined {
  const n = name.trim().toLowerCase();
  if (n === AUTOMATIC.toLowerCase()) return null;
  const i = ACCENT_NAMES.findIndex((c) => c.toLowerCase() === n);
  return i < 0 ? undefined : i;
}

const colourWord = (accent: number | null | undefined) => (accent === null || accent === undefined ? AUTOMATIC : ACCENT_NAMES[accent]);

export function lookTools(d: Deps): AssistantTool[] {
  // ---- an area's colour ----
  /** What set_area_colour's call would change: the area, its chosen colour now (undefined: automatic) and the one asked for. */
  const colourPlan = (a: ColourArgs): { key: string; was: number | undefined; to: number | null; auto: number } | { refused: string } => {
    const now = layoutNow(d);
    if ("refused" in now) return now;
    const to = accentNamed(a.colour);
    if (to === undefined) return { refused: `${JSON.stringify(plainLine(a.colour, 20))} isn't a colour an area can be: ${[AUTOMATIC, ...ACCENT_NAMES].join(", ")}` };
    if (!Object.hasOwn(now.stored.areas, a.group)) return { refused: `There's no area ${areaName(a.group)} on the landscape: list_groups says which groups have one` };
    const was = now.stored.areas[a.group].accent;
    const auto = automaticAccent(now.layout.areas, a.group);
    if ((to ?? undefined) === was) return { refused: to === null ? `${areaName(a.group)} takes its automatic colour (${ACCENT_NAMES[auto]}) already` : `${areaName(a.group)} is ${ACCENT_NAMES[to]} already` };
    return { key: a.group, was, to, auto };
  };

  // ---- tool windows ----
  const nameOf = (k: ToolKind) => TOOL_NAME[k];
  const windows = (): Record<string, ToolWindow> => d.landscapeState().landscape.tools;
  /** Where a call's window is, as a step's line says it. */
  const where = (a: ToolArgs): string => (a.docked ? "docked" : a.session !== undefined ? `beside ${titleOf(sessionById(d, a.session), a.session)}` : `in ${areaName(a.group ?? "")}`);
  /** The windows of kind `a.kind` that are open where `a` says: docked, beside its session's workspace, or in its area. */
  const openWhere = (a: ToolArgs): [string, ToolWindow][] =>
    Object.entries(windows()).filter(([, w]) => w.tool === a.kind && (a.docked ? w.docked : !w.docked && (a.session !== undefined ? w.session === a.session : w.area === a.group)));
  /** Why `a` names no place for its window: docked takes no scope, a workspace tool takes a session, an area's a group. */
  const scopeRefusal = (a: ToolArgs): string | null => {
    if (a.docked) return a.session !== undefined || a.group !== undefined ? "A docked window follows the selected workspace: give docked alone, or a session or group without it" : null;
    if (isWorkspaceTool(a.kind)) return a.session === undefined || a.group !== undefined ? `${nameOf(a.kind)} opens beside a session's workspace: name the session (not a group), or dock it` : null;
    return a.group === undefined || a.session !== undefined ? `${nameOf(a.kind)} opens in an area: name its group (not a session), or dock it` : null;
  };
  /** Why `a`'s window can't open now: the window's own buttons' rules, or it's open there already. */
  const openRefusal = (a: ToolArgs): string | null => {
    const scope = scopeRefusal(a);
    if (scope) return scope;
    const st = d.landscapeState();
    if (st.problem) return `The landscape can't be changed now: ${st.problem}`;
    if (a.docked) return openWhere(a).length ? `${nameOf(a.kind)} is docked already` : null;
    const now = layoutNow(d);
    if ("refused" in now) return now.refused;
    if (a.session !== undefined) {
      const s = sessionById(d, a.session);
      if (!s) return noSession(a.session);
      if (!s.mine) return `${titleOf(s, s.id)} is ${s.owner ? `${s.owner}'s` : "a teammate's"} session: it has no folder on this Mac for ${nameOf(a.kind)}`;
      const r = d.record(s.id);
      if (!r?.open) return `${titleOf(s, s.id)} is closed: reopen it first`;
      if (r.info.status === "dead" && a.kind !== "search") return `${titleOf(s, s.id)} has exited: only Search opens on it`;
      const t = tileOf(now.layout, s.id);
      if (!t) return `${titleOf(s, s.id)} has no workspace on the landscape`;
      if (t.hidden) return `${titleOf(s, s.id)} is in ${areaName(t.area)}, which is collapsed: open it first`;
    } else {
      const area = now.layout.areas.find((x) => x.key === a.group);
      if (!area) return `There's no area ${areaName(a.group!)} on the landscape: list_groups says which groups have one`;
      if (area.rect.collapsed) return `${areaName(area.key)} is collapsed: open it first`;
      if (a.kind === "chat" && !roomOfGroup(d, area.key)) return `${areaName(area.key)} isn't a team room's area: Chat is a room's`;
      if (a.kind === "pipeline" && !pipelinesIn(now.layout, area.key, d.wireList()).length) return `No wires join ${areaName(area.key)}'s workspaces into a pipeline, so there's nothing for Pipeline to show`;
    }
    return openWhere(a).length ? `${nameOf(a.kind)} is open ${where(a)} already` : null;
  };
  const target = (a: ToolArgs) => (a.session !== undefined ? { session: a.session, title: sessionById(d, a.session)?.title ?? null } : null);
  const toolSchema = {
    type: "object" as const,
    properties: {
      kind: { type: "string" as const, enum: TOOL_KINDS, description: "files, changes, search, run (Run & debug): beside a workspace; artifacts, chat, pipeline: in an area" },
      session: SESSION_ARG,
      group: AREA_ARG,
      docked: { type: "boolean" as const, description: "true: docked at the window's edge, where it follows the selected workspace" },
    },
    required: ["kind"],
    additionalProperties: false,
  };

  return [
    defineTool<ColourArgs>({
      name: "set_area_colour",
      tier: "direct",
      description:
        `Give an area (a top-level group with an area on the landscape) a colour, as its Colour… does: one of ${ACCENT_NAMES.join(", ")}, ` +
        `or ${AUTOMATIC} for the one it takes by itself. The user can Undo it.`,
      inputSchema: {
        type: "object",
        properties: { group: AREA_ARG, colour: { type: "string", minLength: 1, maxLength: 20, description: `${AUTOMATIC}, or one of ${ACCENT_NAMES.join(", ")}` } },
        required: ["group", "colour"],
        additionalProperties: false,
      },
      label: (a) => `Colour ${areaName(plainLine(a.group, 80))} ${colourWord(accentNamed(a.colour))}`,
      check: (a) => {
        const p = colourPlan(a);
        return "refused" in p ? p.refused : null;
      },
      run: (a): ToolResult => {
        const p = colourPlan(a);
        if ("refused" in p) throw new Error(p.refused);
        d.patchLandscape({ areas: { [p.key]: { accent: p.to } } });
        const set = p.to ?? undefined;
        const still = () => {
          const area = d.landscapeState().landscape.areas[p.key];
          return !!area && area.accent === set;
        };
        return {
          text: p.to === null ? `${areaName(p.key)} takes its automatic colour again (${ACCENT_NAMES[p.auto]}).` : `Coloured ${areaName(p.key)} ${ACCENT_NAMES[p.to]}.`,
          stillUndoable: still,
          undo: () => {
            if (!still()) throw new Error("Its colour was changed again since");
            d.patchLandscape({ areas: { [p.key]: { accent: p.was ?? null } } });
            return `Put ${areaName(p.key)} back to ${p.was === undefined ? `${AUTOMATIC} (${ACCENT_NAMES[p.auto]})` : ACCENT_NAMES[p.was]}`;
          },
        };
      },
    }),

    defineTool<ToolArgs>({
      name: "open_tool",
      tier: "direct",
      description:
        "Open a tool window as the window's own buttons do: Files, Changes, Search or Run & debug (kind files, changes, search, run) beside one of this Mac's sessions' workspaces, " +
        "Artifacts, Chat or Pipeline (artifacts, chat, pipeline) in an area (Chat only a team room's, Pipeline only where wires join a pipeline), or any of them docked at the window's edge (docked: true), where it follows the selection. " +
        "The window places it beside its workspace, or docks it when the area has no room. Only Search opens on an exited session. The user can Undo it.",
      inputSchema: toolSchema,
      label: (a) => `Open ${nameOf(a.kind)} ${where(a)}`,
      check: (a) => openRefusal(a),
      target,
      run: (a): ToolResult => {
        const why = openRefusal(a);
        if (why) throw new Error(why);
        const before = new Set(Object.keys(windows()));
        const rev = d.landscapeState().rev;
        // a docked one of the kind shows the workspace it's asked for there, once that's selected: nothing new opens
        const docked = !a.docked && a.session !== undefined && Object.values(windows()).some((w) => w.docked && w.tool === a.kind);
        d.toWindow({ kind: "openTool", tool: a.kind, ...(a.session !== undefined ? { session: a.session } : {}), ...(a.group !== undefined ? { area: a.group } : {}), ...(a.docked ? { docked: true } : {}) });
        if (docked) return { text: `${nameOf(a.kind)} is docked, so it shows ${titleOf(sessionById(d, a.session!), a.session!)} there now.` };
        const opened = () => Object.entries(windows()).filter(([id, w]) => w.tool === a.kind && !before.has(id));
        // until the window has placed it, the landscape is as it was
        const still = () => opened().length > 0 || d.landscapeState().rev === rev;
        return {
          text: a.docked ? `Docked ${nameOf(a.kind)}.` : `Opening ${nameOf(a.kind)} ${where(a)}: the window docks it instead if there's no room there.`,
          stillUndoable: still,
          undo: () => {
            const ids = opened().map(([id]) => id);
            if (!ids.length) throw new Error(`${nameOf(a.kind)} didn't open, so there's nothing to close`);
            d.patchLandscape({ tools: Object.fromEntries(ids.map((id) => [id, null])) });
            return `Closed ${nameOf(a.kind)} again`;
          },
        };
      },
    }),

    defineTool<ToolArgs>({
      name: "close_tool",
      tier: "direct",
      description:
        "Close a tool window, as its × does: the one of that kind beside a session's workspace (session), in an area (group), or docked (docked: true). The user can Undo it.",
      inputSchema: toolSchema,
      label: (a) => `Close ${nameOf(a.kind)} ${where(a)}`,
      check: (a) => {
        const scope = scopeRefusal(a);
        if (scope) return scope;
        const st = d.landscapeState();
        if (st.problem) return `The landscape can't be changed now: ${st.problem}`;
        if (openWhere(a).length) return null;
        const dockedToo = !a.docked && Object.values(st.landscape.tools).some((w) => w.docked && w.tool === a.kind);
        return `${nameOf(a.kind)} isn't open ${where(a)}${dockedToo ? `: it's docked, which close_tool with docked closes` : ""}`;
      },
      target,
      run: (a): ToolResult => {
        const shut = openWhere(a);
        if (!shut.length) throw new Error(`${nameOf(a.kind)} isn't open ${where(a)}`);
        const rev = d.patchLandscape({ tools: Object.fromEntries(shut.map(([id]) => [id, null])) });
        // put back only over a landscape no one has changed since: a window placed back could overlap what's there now
        const still = () => d.landscapeState().rev === rev;
        return {
          text: `Closed ${nameOf(a.kind)} ${where(a)}.`,
          stillUndoable: still,
          undo: () => {
            if (!still()) throw new Error("The landscape has changed since, so the window can't be put back where it was");
            d.patchLandscape({ tools: Object.fromEntries(shut) });
            return `Put ${nameOf(a.kind)} back`;
          },
        };
      },
    }),
  ];
}
