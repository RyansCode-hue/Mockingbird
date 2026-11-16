import * as os from "os";
import * as path from "path";
import type { SessionInfo, WorktreeStateInfo } from "../src/shared/types";
import { isRemotePaneId } from "../src/shared/team/livePanes";
import type { AssistantDeps, AssistantWorkDeps } from "../src/main/assistant/deps";
import { buildRegistry, type AssistantTool } from "../src/main/assistant/registry";
import * as groups from "../src/main/assistant/tools";
import { worldGroups, worldRooms, worldSessions, type WorldRoom } from "../src/main/assistant/world";
import { SessionGuards } from "../src/main/sessionGuards";
import { takenOverWhy, UNTAKEN_CALLS } from "../src/main/takenOverGuard";
import { rulesFor } from "./assistantHarness";
import { unusedToolDeps } from "./assistantWorld";

/** The deps the sessions, start work, triage, git and diagnose tools add (deps.ts' last block). */
export type WorkDeps = AssistantWorkDeps;

/** Each of those deps throwing when called: for tests of other tools, which never reach them. */
export function unusedWorkDeps(): WorkDeps {
  const no =
    (name: string) =>
    (): never => {
      throw new Error(`${name} isn't faked in this test`);
    };
  // every dep, so the type says when one is missing
  const names: { [K in Exclude<keyof WorkDeps, "guards">]: true } = {
    takenOver: true, record: true, describeRelaunch: true, relaunchWith: true, close: true, resume: true, reopen: true, briefStart: true, handoffStart: true,
    presets: true, startPreset: true, templates: true, layOut: true, repos: true, createSession: true, houseBoards: true, adoItems: true, ticketPlan: true,
    startTicket: true, startReview: true, broadcast: true, lastReply: true, worktreeState: true, worktrees: true, removeWorktree: true, branchStat: true,
    prStatus: true, pushAsk: true, push: true, prPreflight: true, openPr: true, output: true, usage: true, meters: true, overlaps: true, turnFiles: true,
    searchTranscripts: true,
  };
  return {
    guards: { whyNot: no("guards.whyNot"), closeWarnings: no("guards.closeWarnings"), answerPrompt: no("guards.answerPrompt") },
    ...(Object.fromEntries(Object.keys(names).map((k) => [k, no(k)])) as unknown as Omit<WorkDeps, "guards">),
  };
}

/** One of this Mac's sessions, as main keeps it. */
export const info = (id: string, over: Partial<SessionInfo> = {}): SessionInfo =>
  ({
    id,
    title: id,
    ticketTitle: null,
    repoPath: "/code/atticus",
    branch: "main",
    taskGroup: "atticus",
    status: "idle",
    agent: "claude",
    cwd: `/w/${id}`,
    kind: "work",
    waitingReason: null,
    waitingSince: null,
    createdAt: Date.UTC(2026, 10, 16, 9),
    extraDirs: [],
    ...over,
  }) as SessionInfo;

/** ~/Helpdesk, where the Helpdesk tasks workspace runs: in the test file's own HOME. */
export const HELPDESK_DIR = (): string => path.join(os.homedir(), "Helpdesk");

/** The Helpdesk tasks workspace, as main keeps it. */
export const helpdesk = (id = "h1", over: Partial<SessionInfo> = {}): SessionInfo =>
  info(id, { title: "Helpdesk tasks", role: "tasks", taskGroup: "Helpdesk", repoPath: null, branch: null, cwd: HELPDESK_DIR(), ...over });

/** A teammate's room session, as this Mac shows it. */
export const teammate = (id = "r~nick~n1", over: Partial<SessionInfo> = {}): SessionInfo =>
  info(id, { title: "Nick's api", room: { roomId: "R1", sessionId: "n1", owner: "nick", ownerName: "Nick", remote: true, online: true, live: true, lookers: [], cols: 80, rows: 24 } as unknown as SessionInfo["room"], ...over });

export const PERMISSION = "Claude needs your permission to use Bash";

/**
 * A Mac for the Assistant's tools to act on: this Mac's open and closed sessions, teammates' room sessions, the rooms
 * and areas, and main's real session guards over them (sessionGuards.ts), so a tool's refusals are main's. Every action
 * a tool takes is written to `did`; a test replaces what it needs to answer otherwise (`mac.deps.x = …`).
 */
export function fakeMac() {
  const own: SessionInfo[] = [];
  const closed: SessionInfo[] = [];
  const remote: SessionInfo[] = [];
  const rooms: WorldRoom[] = [];
  const areas: string[] = ["atticus"];
  /** Copies a teammate took over. */
  const taken = new Set<string>();
  /** What may not run again here (main's relaunchGuard), by id. */
  const guarded = new Map<string, string>();
  /** Folders' git state. */
  const trees = new Map<string, WorktreeStateInfo>();
  /** What was typed into a pty, as [id, keys]. */
  const typed: [string, string][] = [];
  const did: string[] = [];

  const ownRefusal = (id: string, what: string) => (isRemotePaneId(id) ? `That's a teammate's session: only its owner can ${what}` : null);
  const takenRefusal = (id: string, doing: string) => (taken.has(id) ? `“${id}” continues on Nick's laptop — take it back rather than ${doing}` : null);
  const tree = (folder: string): WorktreeStateInfo => {
    const st = trees.get(folder);
    if (!st) throw new Error(`fatal: cannot change to '${folder}': No such file or directory`);
    return st;
  };

  const guards = new SessionGuards({
    sessions: {
      list: () => own,
      resumable: () => closed,
      planned: () => [],
      ownRefusal,
      restartRefusal: (id) => ownRefusal(id, "restart it") ?? guarded.get(id) ?? null,
      whyNotResume: (id) => {
        if (isRemotePaneId(id)) return "That's a teammate's session: only its owner can resume it";
        const pane = own.find((s) => s.id === id);
        if (!pane) return "It isn't an exited pane here: reopen it from its ghost card or Closed sessions";
        if (pane.status !== "dead") return "It's running already";
        return guarded.get(id) ?? null;
      },
      write: (id, keys) => void typed.push([id, keys]),
    } as ConstructorParameters<typeof SessionGuards>[0]["sessions"],
    takenOver: () => takenRefusal,
    worktreeState: async (folder) => tree(folder),
  });

  const find = (id: string) => own.find((s) => s.id === id) ?? closed.find((s) => s.id === id);
  const started = (title: string): SessionInfo => {
    const s = info(`new${did.length}`, { title });
    did.push(`started ${title}`);
    return s;
  };

  const deps: AssistantDeps = {
    sessions: () => worldSessions({ own, remote, rooms }),
    groups: () => worldGroups({ own, remote, areas, stacks: [], rooms }),
    rooms: () => worldRooms(rooms),
    rules: rulesFor({ sessions: () => worldSessions({ own, remote, rooms }), groups: () => worldGroups({ own, remote, areas, stacks: [], rooms }) }).engine,
    ...unusedToolDeps(),
    toWindow: (a) => void did.push(`window ${JSON.stringify(a)}`),
    rename: (id, title) => {
      did.push(`rename ${id} ${title}`);
      find(id)!.title = title;
    },
    relaunchRefusal: (id) => guards.whyNot("relaunch", id),
    relaunch: async (id) => void did.push(`restart ${id}`),

    guards,
    takenOver: (id, call) => takenOverWhy(id, UNTAKEN_CALLS[call], takenRefusal),
    record: (id) => {
      const o = own.find((s) => s.id === id);
      if (o) return { info: o, open: true };
      const c = closed.find((s) => s.id === id);
      return c ? { info: c, open: false } : null;
    },
    describeRelaunch: (id) => ({ blocked: guards.whyNot("relaunch", id), warnings: [] }),
    relaunchWith: async (id, change) => void did.push(`relaunchWith ${id} ${JSON.stringify(change)}`),
    close: (id) => {
      did.push(`close ${id}`);
      const i = own.findIndex((s) => s.id === id);
      if (i >= 0) closed.push(...own.splice(i, 1));
    },
    resume: async (id) => void did.push(`resume ${id}`),
    reopen: async (id) => void did.push(`reopen ${id}`),
    briefStart: async (id) => started(`${id} · fresh`),
    handoffStart: async (id) => started(`${id} · codex`),
    presets: () => [],
    startPreset: async (id) => started(`preset ${id}`),
    templates: () => ({ templates: [], refused: [] }),
    layOut: async () => ({ steps: [], wires: [], started: null, notes: [] }),
    repos: () => [{ name: "atticus", path: "/code/atticus", root: "/code" }],
    createSession: async (req) => started(req.title ?? "new"),
    houseBoards: () => [],
    adoItems: async () => ({ items: [], total: 0, me: "Ryan" }),
    ticketPlan: async () => {
      throw new Error("no House in this test");
    },
    startTicket: async () => ({ error: "no House in this test", step: "read" }),
    startReview: async (id) => started(`Review · ${id}`),
    broadcast: (text, ids) =>
      ids.map((id) => {
        did.push(`broadcast ${id} ${text}`);
        const s = own.find((x) => x.id === id);
        return { id, outcome: !s || s.status === "dead" || s.shell || s.role === "tasks" ? "skipped" : s.status === "idle" ? "delivered" : "queued" };
      }),
    lastReply: async (id) => ({ line: `${id} said done`, at: 1 }),
    worktreeState: async (folder) => tree(folder),
    worktrees: async () => [],
    removeWorktree: async (repo, folder) => void did.push(`remove ${repo} ${folder}`),
    branchStat: async () => ({ base: "origin/dev", files: 3, insertions: 10, deletions: 2 }),
    prStatus: async () => ({ branch: "main", pr: null, at: 1 }),
    pushAsk: async (id) => ({ branch: find(id)?.branch ?? null, why: null }),
    push: async (id, branch) => {
      did.push(`push ${id} ${branch}`);
      return { upstream: `origin/${branch}` };
    },
    prPreflight: async () => {
      throw new Error("no pull requests in this test");
    },
    openPr: async (id, ticket) => {
      did.push(`openPr ${id} ${ticket}`);
      return { url: "https://example.invalid/pr/1" };
    },
    output: (id) => {
      did.push(`output ${id}`);
      return "";
    },
    usage: () => ({ claude: null, codex: null }),
    meters: () => {
      throw new Error("the conversation index isn't available");
    },
    overlaps: () => ({ bySession: {}, unread: {} }),
    turnFiles: async () => [],
    searchTranscripts: () => [],
  };

  const registry = buildRegistry(deps, Object.values(groups));
  const tool = (name: string): AssistantTool => {
    const t = registry.get(name);
    if (!t) throw new Error(`no tool ${name}`);
    return t;
  };
  return { own, closed, remote, rooms, areas, taken, guarded, trees, typed, did, deps, guards, registry, tool };
}

/** A clean worktree's state, `over` changed. */
export const cleanTree = (over: Partial<WorktreeStateInfo> = {}): WorktreeStateInfo => ({ dirty: false, dirtyFiles: 0, branch: "main", upstream: "origin/main", ahead: 0, behind: 0, insertions: 0, deletions: 0, ...over });
