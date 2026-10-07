/**
 * The UI preview's stand-in for the main process: `window.mb` answering from
 * fixture data, so the real interface runs in a plain browser
 * (`npm run ui-preview`) with nothing real behind it — no sessions, files,
 * git, ADO or agents are touched.
 *
 * Calls it doesn't simulate answer the way a real failure does
 * ({ error }) and are logged, so a view shows its error state instead of
 * crashing on a made-up shape. Every call is recorded in window.__mbCalls for
 * scripted checks. Add `?reset` to the URL to start from the fixtures again;
 * the query can also pick the screen (see the end of this file).
 */
import type { AdoBoard, AdoWorkItem, GraphCommit, Meters, SessionInfo, Settings, TicketPipeline, TicketStage, UsageReport } from "../shared/types";
import { DEFAULT_SETTINGS } from "../shared/types";
import type { TeamStatus } from "../shared/team/types";
import type { PlanChange, PlanOp, PlanView, WorkPackage } from "../shared/team/plan"; // team rooms: plan board

const w = window as any;
const calls: { fn: string; args: unknown[] }[] = (w.__mbCalls = []);
const now = Date.now();
const min = 60_000;

// ---- fixtures ----------------------------------------------------------------

const REPO = "/Users/you/Code/backoffice";
const WT = (b: string) => `/Users/you/Code/worktrees/backoffice/${b}`;
const session = (id: string, over: Partial<SessionInfo>): SessionInfo => ({
  id,
  title: id,
  repoPath: REPO,
  cwd: REPO,
  branch: null,
  ticketId: null,
  ticketTitle: null,
  taskGroup: null,
  status: "idle",
  createdAt: now - 90 * min,
  kind: "work",
  extraDirs: [],
  waitingReason: null,
  waitingSince: null,
  agent: "claude",
  ...over,
});

let sessions: SessionInfo[] = [
  session("s1", { title: "#5101 — Org dropdowns remember the last org", ticketId: "5101", ticketTitle: "Org dropdowns remember the last org", taskGroup: "5101", branch: "5101-orgDropdowns", cwd: WT("5101-orgDropdowns"), status: "working", model: "opus" }),
  session("s2", { title: "API: last org per user", ticketId: "5101", ticketTitle: "API: last org per user", taskGroup: "5101/api", branch: "5101-orgDropdowns", cwd: WT("5101-orgDropdowns"), status: "waiting", waitingReason: "Claude needs your permission to use Bash", waitingSince: now - 4 * min }),
  session("s3", { title: "API tests", taskGroup: "5101/api", branch: "5101-orgDropdowns", cwd: WT("5101-orgDropdowns"), agent: "codex", status: "idle" }),
  session("s4", { title: "test runner", taskGroup: "5101", shell: true, agent: undefined, status: "idle" }),
  session("s8", { title: "Release notes for #5101", taskGroup: "5101", branch: "5101-orgDropdowns", cwd: WT("5101-orgDropdowns"), status: "idle" }),
  session("s5", { title: "#5102 — Pathways quick view freezes", ticketId: "5102", ticketTitle: "Pathways quick view freezes", taskGroup: "5102", branch: "5102-quickViewFreeze", cwd: WT("5102-quickViewFreeze"), status: "idle" }),
  session("s6", { title: "Crashed session", taskGroup: "5102", status: "dead", exitCode: 1 }),
  session("s7", { title: "assistant", repoPath: null, cwd: "/Users/you", kind: "assistant", taskGroup: null, status: "idle" }),
];
const previous: SessionInfo[] = [session("p1", { title: "Yesterday's spike", status: "dead", taskGroup: null })];

const C = { dim: "\x1b[2m", reset: "\x1b[0m", bold: "\x1b[1m", amber: "\x1b[38;5;214m", teal: "\x1b[38;5;43m", red: "\x1b[31m", green: "\x1b[32m" };
const buffers: Record<string, string> = {
  s1: `${C.bold}> Make the org dropdown remember the last org each user picked${C.reset}\r\n\r\n${C.teal}⏺${C.reset} I'll store the choice per user and preselect it.\r\n\r\n${C.teal}⏺${C.reset} Update(src/org/Dropdown.tsx)\r\n  ⎿  Updated with 12 additions and 3 removals\r\n\r\n${C.amber}✻${C.reset} Writing the API change… ${C.dim}(42s · esc to interrupt)${C.reset}\r\n`,
  s2: `${C.bold}> Add GET/PUT /api/users/me/last-org${C.reset}\r\n\r\n${C.teal}⏺${C.reset} Bash(pytest tests/api/test_orgs.py)\r\n\r\n  Do you want to proceed?\r\n  ${C.bold}❯ 1. Yes${C.reset}\r\n    2. No, and tell Claude what to do differently\r\n`,
  s3: `${C.dim}codex${C.reset}\r\n› Write tests for the last-org endpoint\r\n\r\n• Added tests/api/test_last_org.py (4 tests)\r\n• All passing\r\n\r\n› `,
  s4: `you@mac backoffice % npm test -- --watch\r\n\r\n ${C.green}✓${C.reset} src/org/Dropdown.test.tsx (6)\r\n ${C.green}✓${C.reset} src/org/lastOrg.test.ts (3)\r\n\r\n Test Files  2 passed (2)\r\n      Tests  9 passed (9)\r\n`,
  s8: `${C.bold}> Draft the release note for the last-org dropdown${C.reset}\r\n\r\n${C.teal}⏺${C.reset} Org pickers now open on the org you used last.\r\n`,
  s5: `${C.bold}> Why does the quick view freeze with many tags?${C.reset}\r\n\r\n${C.teal}⏺${C.reset} The tag list re-renders on every keystroke; memoizing it fixes the freeze.\r\n`,
  s6: `${C.red}Error: connect ECONNREFUSED 127.0.0.1:5432${C.reset}\r\n`,
  s7: `${C.bold}> What's on my plate today?${C.reset}\r\n\r\n${C.teal}⏺${C.reset} Two tickets in progress (#5101, #5102) and one PR waiting on review.\r\n`,
};

const files: Record<string, string> = {
  "README.md": "# backoffice\n\nThe admin site.\n",
  "package.json": '{\n  "name": "backoffice",\n  "scripts": { "test": "vitest" }\n}\n',
  "tsconfig.json": '{\n  "compilerOptions": { "strict": true }\n}\n',
  "src/org/Dropdown.tsx": 'import { lastOrg } from "./lastOrg";\n\nexport function OrgDropdown({ orgs }: { orgs: string[] }) {\n  const initial = lastOrg() ?? orgs[0];\n  return <select defaultValue={initial}>{orgs.map((o) => <option key={o}>{o}</option>)}</select>;\n}\n',
  "src/org/lastOrg.ts": 'export function lastOrg(): string | null {\n  return localStorage.getItem("lastOrg");\n}\n',
  "src/api/orgs.py": "from fastapi import APIRouter\n\nrouter = APIRouter()\n\n@router.get('/users/me/last-org')\ndef last_org():\n    return {'org': None}\n",
};
const headFiles: Record<string, string> = { ...files, "src/org/Dropdown.tsx": 'export function OrgDropdown({ orgs }: { orgs: string[] }) {\n  return <select>{orgs.map((o) => <option key={o}>{o}</option>)}</select>;\n}\n' };
delete headFiles["src/org/lastOrg.ts"];
const mtimes: Record<string, number> = {};

const commits: GraphCommit[] = [
  { sha: "a1b2c3d", parents: ["b2c3d4e"], refs: [{ name: "HEAD", kind: "head" }, { name: "5101-orgDropdowns", kind: "local" }], subject: "Remember the last org per user", author: "You", at: now - 30 * min },
  { sha: "b2c3d4e", parents: ["c3d4e5f"], refs: [{ name: "origin/5101-orgDropdowns", kind: "remote" }], subject: "Org dropdown: preselect", author: "You", at: now - 3 * 60 * min },
  { sha: "c3d4e5f", parents: ["d4e5f60"], refs: [{ name: "origin/dev", kind: "remote" }], subject: "Merge PR 87: tenant tags", author: "Sam", at: now - 26 * 60 * min },
  { sha: "d4e5f60", parents: [], refs: [], subject: "Initial import", author: "Sam", at: now - 30 * 24 * 60 * min },
];

const tickets: AdoWorkItem[] = [
  { id: 5101, title: "Org dropdowns remember the last org", state: "Active", type: "User Story", assignedTo: "You", changed: new Date(now - 2 * 60 * min).toISOString(), description: "Users pick the same org every time. Remember it.", url: "https://dev.azure.com/acme/Backoffice/_workitems/edit/5101", boardColumn: "In Progress" },
  { id: 5102, title: "Pathways quick view freezes with many tags", state: "Active", type: "Bug", assignedTo: "You", changed: new Date(now - 26 * 60 * min).toISOString(), description: "Typing in the tag filter freezes the page.", url: "https://dev.azure.com/acme/Backoffice/_workitems/edit/5102", boardColumn: "In Progress" },
  { id: 5110, title: "Export donors to CSV", state: "New", type: "User Story", assignedTo: "You", changed: new Date(now - 3 * 24 * 60 * min).toISOString(), description: "", url: "https://dev.azure.com/acme/Backoffice/_workitems/edit/5110", boardColumn: "New" },
  { id: 5098, title: "Login redirect loops on Safari", state: "Resolved", type: "Bug", assignedTo: "Sam", changed: new Date(now - 5 * 24 * 60 * min).toISOString(), description: "", url: "https://dev.azure.com/acme/Backoffice/_workitems/edit/5098", boardColumn: "Testing" },
];
const board: AdoBoard = {
  id: "b1",
  name: "Stories",
  columnField: "WEF_Kanban.Column",
  columns: [
    { name: "New", type: "incoming", stateMappings: { "User Story": "New", Bug: "New" } },
    { name: "In Progress", type: "inProgress", stateMappings: { "User Story": "Active", Bug: "Active" } },
    { name: "Testing", type: "inProgress", stateMappings: { "User Story": "Resolved", Bug: "Resolved" } },
    { name: "Done", type: "outgoing", stateMappings: { "User Story": "Closed", Bug: "Closed" } },
  ],
};

let settings: Settings = { ...DEFAULT_SETTINGS, setupDone: true, teamName: "You", signalingUrl: "https://mockingbird-signaling.you.workers.dev", presets: [{ id: "p-review", name: "Review on dev", launch: "claude", repoPath: REPO, branch: { mode: "new", pattern: "review-{date}", base: "dev" }, useWorktree: true, kickoff: "Review the latest changes on dev for bugs and missing tests." }] };

const pipelines: Record<string, TicketPipeline> = {
  "5101": {
    ticketId: "5101",
    title: "Org dropdowns remember the last org",
    stage: "local-test",
    history: [{ at: now - 26 * 60 * min, stage: "coding" }, { at: now - 60 * min, stage: "local-test" }],
    prs: [],
    feedback: [],
    drafts: [{ id: "d1", stage: "local-test", text: "Development is done; testing locally.", at: now - 60 * min }],
    checks: { "dev:tests": true },
  },
};

const usage: UsageReport = {
  claude: { agent: "claude", plan: "Max", at: now - 2 * min, limits: [{ label: "5-hour limit", window: "5h", usedPct: 38, resetsAt: now + 2.5 * 60 * min }, { label: "Weekly · all models", window: "week", usedPct: 61, resetsAt: now + 3 * 24 * 60 * min }] },
  codex: { agent: "codex", plan: "Plus", at: now - 20 * min, limits: [{ label: "5-hour limit", window: "5h", usedPct: 9, resetsAt: now + 4 * 60 * min }] },
};
const tokens = (input: number, output: number, cacheRead: number) => ({ input, output, cacheRead, cacheWrite: Math.round(input / 3), replies: 40 });
const meters: Meters = {
  at: now,
  today: { claude: tokens(2_100_000, 380_000, 48_000_000), codex: tokens(210_000, 40_000, 0) },
  sessions: {
    s1: { agent: "claude", tokens: tokens(900_000, 120_000, 21_000_000), window: { tokens: 6_000_000, sharePct: 14, usedPct: 38, resetsAt: now + 2.5 * 60 * min } },
    s2: { agent: "claude", tokens: tokens(300_000, 60_000, 7_000_000), window: { tokens: 1_000_000, sharePct: 2.4, usedPct: 38, resetsAt: now + 2.5 * 60 * min } },
  },
};

// team rooms: 5101 is shared with Nick (connected) and Sam (offline); 5110 was joined and has no session here yet
const ME = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const NICK = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const SAM = "5a5a5a5a6b6b6b6b7c7c7c7c8d8d8d8d";
const SIGNAL = "https://mockingbird-signaling.you.workers.dev";
const team: TeamStatus = {
  self: { id: ME, name: "You", fingerprint: ME.replace(/(.{4})(?=.)/g, "$1 ") },
  signalingUrl: SIGNAL,
  rooms: [
    { id: "R5101aaaaaaaaaaaaaaaaa", name: "#5101 Org dropdowns remember the last org", groupKey: "5101", members: [{ id: ME, name: "You", self: true }, { id: NICK, name: "Nick Smith", self: false }, { id: SAM, name: "Sam", self: false }], online: [NICK], signalingUrl: SIGNAL, signaling: "online" },
    { id: "R5110bbbbbbbbbbbbbbbbb", name: "#5110 Donor entities", groupKey: "5110", members: [{ id: NICK, name: "Nick Smith", self: false }, { id: ME, name: "You", self: true }], online: [NICK], signalingUrl: SIGNAL, signaling: "online" },
  ],
  pending: [],
  peers: [
    { id: NICK, name: "Nick Smith", state: "turn", since: now - 40 * min },
    { id: SAM, name: "Sam", state: "offline", since: now - 3 * 60 * min },
  ],
  problems: [],
};
// team rooms: plan board — 5101's board is kept in backoffice and has a package in every column; 5110 has none yet and no repo
const pkg = (id: string, over: Partial<WorkPackage>): WorkPackage => ({ id, title: id, description: "", owner: null, status: "open", statusNote: "", paths: [], provides: "", uses: "", tests: "", createdBy: ME, createdAt: now - 5 * 60 * min, updatedBy: ME, updatedAt: now - 60 * min, ...over });
const plans: Record<string, PlanView> = {
  R5101aaaaaaaaaaaaaaaaa: {
    roomId: "R5101aaaaaaaaaaaaaaaaa",
    room: "#5101 Org dropdowns remember the last org",
    self: ME,
    members: [{ id: ME, name: "You", self: true, online: true }, { id: NICK, name: "Nick Smith", self: false, online: true }, { id: SAM, name: "Sam", self: false, online: false }],
    plan: {
      repo: { origin: "git@github.com:acme/backoffice.git", name: "backoffice" },
      packages: [
        pkg("p-api0last", { title: "Last-org API", owner: NICK, status: "in-progress", paths: ["src/api/orgs/", "src/shared/org.ts"], provides: "GET/PUT /api/users/me/last-org → { orgId } (src/shared/org.ts)", tests: "pytest tests/api/test_orgs.py", createdBy: NICK }),
        pkg("p-ui00drop", { title: "Org dropdown remembers the last org", owner: ME, status: "claimed", paths: ["src/org/Dropdown.tsx", "src/org/**/*.test.tsx"], uses: "GET /api/users/me/last-org", tests: "Dropdown.test.tsx; manual check in the org switcher" }),
        pkg("p-mig0fill", { title: "Backfill each user's last org", paths: ["migrations/"], description: "One-off migration from the audit log.", tests: "migration dry run on a staging copy" }),
        pkg("p-doc0note", { title: "Release notes and help article", owner: SAM, status: "blocked", statusNote: "waiting on the API's final shape", paths: ["docs/releases/"], uses: "Last-org API" }),
        pkg("p-spk0tent", { title: "Spike: per-tenant defaults", owner: NICK, status: "done", paths: ["spikes/tenant-defaults/"] }),
      ],
      changes: [
        { at: now - 5 * 60 * min, by: ME, kind: "repo", repo: "backoffice" },
        { at: now - 4 * 60 * min, by: NICK, kind: "created", pkg: "p-api0last", title: "Last-org API" },
        { at: now - 3 * 60 * min, by: NICK, kind: "claimed", pkg: "p-api0last", title: "Last-org API" },
        { at: now - 70 * min, by: SAM, kind: "status", pkg: "p-doc0note", title: "Release notes and help article", status: "blocked", note: "waiting on the API's final shape" },
        { at: now - 40 * min, by: NICK, via: "#5101 — API: last org per user", kind: "status", pkg: "p-api0last", title: "Last-org API", status: "in-progress" },
        { at: now - 6 * min, by: ME, kind: "claimed", pkg: "p-ui00drop", title: "Org dropdown remembers the last org" },
      ],
      removed: [],
      updatedAt: now - 6 * min,
    },
    git: { repo: { origin: "git@github.com:acme/backoffice.git", name: "backoffice" }, clones: [REPO], state: "synced", commit: { sha: "4f9c2e1d8b7a6c5e4d3c2b1a0f9e8d7c6b5a4f3e", at: now - 6 * min, pushed: true }, copies: 3 },
    teammates: [
      { member: NICK, name: "Nick Smith", branch: "5101-lastOrgApi", repo: REPO, files: ["src/api/orgs/last.py", "src/org/Dropdown.tsx", "src/shared/org.ts"] },
      { member: SAM, name: "Sam", branch: "5101-releaseNotes", repo: REPO, files: [], problem: "5101-releaseNotes isn't on origin (not pushed yet)" },
    ],
    fetchedAt: now - 3 * min,
  },
  R5110bbbbbbbbbbbbbbbbb: {
    roomId: "R5110bbbbbbbbbbbbbbbbb",
    room: "#5110 Donor entities",
    self: ME,
    members: [{ id: NICK, name: "Nick Smith", self: false, online: true }, { id: ME, name: "You", self: true, online: true }],
    plan: { repo: null, packages: [], changes: [], removed: [], updatedAt: 0 },
    git: { repo: null, clones: [], state: "unbound", copies: 0 },
    teammates: [],
    fetchedAt: 0,
  },
};
const inviteCode = (roomId: string) => `MBR1-${btoa(JSON.stringify({ r: roomId, u: SIGNAL, t: Math.random().toString(36).slice(2), f: ME, n: "preview" })).replace(/=+$/, "")}`;

// ---- event plumbing ------------------------------------------------------------

const listeners: Record<string, Set<(...a: any[]) => void>> = {};
const on = (name: string) => (cb: (...a: any[]) => void) => {
  (listeners[name] ??= new Set()).add(cb);
  return () => listeners[name].delete(cb);
};
const emit = (name: string, ...args: unknown[]) => listeners[name]?.forEach((cb) => cb(...args));
const sessionsChanged = () => emit("onSessionsChanged", sessions.map((s) => ({ ...s })));
const teamChanged = () => emit("onTeamChanged", JSON.parse(JSON.stringify(team)));
// team rooms: plan board
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const planChanged = (roomId: string) => emit("onPlanChanged", clone(plans[roomId]));
const byId = (id: string) => sessions.find((s) => s.id === id);
const later = <T,>(v: T, ms = 120) => new Promise<T>((r) => setTimeout(() => r(v), ms));
const err = (message: string) => ({ error: message });

/** The ticket's pipeline, started at the first stage when it has none yet. */
const pipelineOf = (id: string) => (pipelines[id] ??= { ticketId: id, stage: "ba", history: [], prs: [], feedback: [], drafts: [], checks: {} });
/** Tell the window, with a copy as the IPC boundary would hand it over. */
const pipelinesChanged = () => emit("onPipelineChanged", JSON.parse(JSON.stringify(pipelines)));
const setStage = (id: string, stage: TicketStage) => {
  const p = pipelineOf(id);
  p.stage = stage;
  p.history.push({ at: Date.now(), stage });
  pipelinesChanged();
  return p;
};

const dirEntries = (rel: string) => {
  const prefix = rel ? `${rel.replace(/\/$/, "")}/` : "";
  const seen = new Map<string, boolean>();
  for (const p of Object.keys(files)) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const [head, ...tail] = rest.split("/");
    seen.set(head, tail.length > 0 || seen.get(head) === true);
  }
  return [...seen].map(([name, dir]) => ({ name, path: prefix + name, dir })).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
};
const unifiedDiff = (path: string) => {
  const a = (headFiles[path] ?? "").split("\n");
  const b = (files[path] ?? "").split("\n");
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, `@@ -1,${a.length} +1,${b.length} @@`, ...a.map((l) => `-${l}`), ...b.map((l) => `+${l}`)].join("\n");
};

// ---- the API -------------------------------------------------------------------

const api: Record<string, (...a: any[]) => any> = {
  // sessions and the grid
  listSessions: async () => sessions.map((s) => ({ ...s })),
  resumableSessions: async () => previous,
  openExternal: async (url: string) => console.info(`[preview] would open ${url} in the browser`),
  collabProblems: async () => [],
  readClaudeMd: async (p: string) => `# ${p}\n\n- Run the tests before calling anything done.\n`,
  saveClaudeMd: async () => true,
  listImportable: async () => [
    { sessionId: "c-import-1", agent: "claude", cwd: REPO, title: "Why does the org picker reset on save?", mtimeMs: now - 50 * min },
    { sessionId: "x-import-2", agent: "codex", cwd: REPO, title: "Speed up the pathways query", mtimeMs: now - 3 * 60 * min },
  ],
  sessionBuffer: async (id: string) => buffers[id] ?? "",
  sessionWrite: async (id: string, text: string) => {
    // typing is echoed; nothing runs
    const out = text.replace(/\r/g, `\r\n${C.dim}(UI preview: nothing runs here)${C.reset}\r\n> `);
    buffers[id] = (buffers[id] ?? "") + out;
    emit("onSessionData", id, out);
  },
  sessionResize: async () => undefined,
  // synchronous in the preload too: an async stand-in would hand back a Promise.
  // A browser gives a dropped file no path, so a drop types nothing.
  getFilePath: () => null,
  auditWrite: () => undefined,
  setGroup: async (id: string, group: string | null) => {
    sessions = sessions.map((s) => (s.id === id ? { ...s, taskGroup: group } : s));
    sessionsChanged();
  },
  renameSession: async (id: string, title: string) => {
    sessions = sessions.map((s) => (s.id === id ? { ...s, title, ticketTitle: s.ticketTitle ? title : null } : s));
    sessionsChanged();
  },
  renameGroup: async (from: string, to: string) => {
    sessions = sessions.map((s) => (s.taskGroup === from || s.taskGroup?.startsWith(`${from}/`) ? { ...s, taskGroup: to + s.taskGroup.slice(from.length) } : s));
    sessionsChanged();
  },
  killSession: async (id: string) => {
    sessions = sessions.filter((s) => s.id !== id);
    sessionsChanged();
  },
  clearWaiting: async (id: string) => {
    sessions = sessions.map((s) => (s.id === id ? { ...s, status: "idle", waitingReason: null, waitingSince: null } : s));
    sessionsChanged();
  },
  sessionMute: async (id: string, muted: boolean) => {
    sessions = sessions.map((s) => (s.id === id ? { ...s, muted: muted || undefined } : s));
    sessionsChanged();
  },
  createSession: async (req: any) => {
    const id = `n${Date.now().toString(36)}`;
    const s = session(id, { title: req.title ?? (req.ticketTitle ? `#${req.ticketId} — ${req.ticketTitle}` : "new session"), taskGroup: req.taskGroup ?? req.ticketId ?? null, agent: req.shell ? undefined : req.agent ?? "claude", shell: req.shell || undefined, status: req.shell ? "idle" : "working", createdAt: Date.now() });
    sessions = [...sessions, s];
    buffers[id] = `${C.dim}(UI preview: a new session would start here)${C.reset}\r\n> `;
    sessionsChanged();
    return s;
  },
  relaunchSession: async (id: string) => {
    const p = previous.find((x) => x.id === id) ?? byId(id);
    if (!p) return null;
    sessions = [...sessions.filter((s) => s.id !== id), { ...p, status: "idle" }];
    sessionsChanged();
    return p;
  },
  sessionRestart: async (id: string) => byId(id) ?? err("Session is no longer running"),
  restartAllSessions: async () => ({ restarted: sessions.filter((s) => !s.shell).map((s) => s.id), skipped: [], failed: [] }),
  // main's rule: idle panes are given it, busy ones queue it, terminals and debriefs never get it
  broadcast: async (req: { message: string; sessionIds: string[] }) =>
    (req.sessionIds.length ? req.sessionIds : sessions.filter((s) => s.kind === "work" && !s.shell).map((s) => s.id)).map((id) => {
      const s = byId(id);
      const outcome = !s || s.status === "dead" || s.shell || s.debrief ? "skipped" : s.status === "idle" ? "delivered" : "queued";
      return { id, outcome };
    }),
  hooksInstalled: async () => true,
  appVersion: async () => "1.3.0",
  getSettings: async () => settings,
  setSettings: async (patch: Partial<Settings>) => {
    settings = { ...settings, ...patch }; // main merges what it's sent
  },
  usageGet: async () => usage,
  metersGet: async () => meters,
  worktreeState: async (cwd: string) =>
    cwd.includes("5101") ? { dirty: true, dirtyFiles: 2, branch: "5101-orgDropdowns", upstream: "origin/5101-orgDropdowns", ahead: 1, behind: 0, insertions: 18, deletions: 3 } : { dirty: false, dirtyFiles: 0, branch: "dev", upstream: "origin/dev", ahead: 0, behind: 2, insertions: 0, deletions: 0 },
  watchFolders: async () => ({ watching: [] }),
  prStatus: async (cwd: string) =>
    cwd.includes("5101")
      ? { branch: "5101-orgDropdowns", pr: { id: 88, url: "https://dev.azure.com/acme/Backoffice/_git/backoffice/pullrequest/88", title: "#5101 Org dropdowns remember the last org", base: "dev", state: "approved", conflicts: false, reviews: ["Sam: approved"] }, at: Date.now() }
      : { branch: null, pr: null, at: Date.now() },
  overlapsGet: async () => ({ s1: [{ other: "s5", otherTitle: "Pathways quick view freezes", otherBranch: "5102-quickViewFreeze", files: ["src/org/Dropdown.tsx"] }], s5: [{ other: "s1", otherTitle: "Org dropdowns remember the last org", otherBranch: "5101-orgDropdowns", files: ["src/org/Dropdown.tsx"] }] }),
  healthUpdates: async () => [{ agent: "claude", installed: "2.1.290", sessions: [{ id: "s1", title: "Org dropdowns remember the last org", version: "2.1.289" }] }],
  messagesList: async () => [
    { at: now - 25 * min, from: "s1", fromTitle: "Org dropdowns remember the last org", to: "s2", toTitle: "API: last org per user", text: "The dropdown reads GET /api/users/me/last-org — return { org } or { org: null }.", outcome: "delivered" },
    { at: now - 20 * min, from: "s2", fromTitle: "API: last org per user", to: "s1", toTitle: "Org dropdowns remember the last org", text: "Done — the endpoint returns { org: string | null }.", outcome: "placed in its prompt for the user to send" },
  ],
  messagesGroupMode: async (group: string, mode: string | null) => {
    const next = { ...(settings.agentMessagesByGroup ?? {}) };
    if (mode === "send" || mode === "prompt") next[group] = mode;
    else delete next[group];
    settings = { ...settings, agentMessagesByGroup: next };
    return next;
  },
  groupStatusCheck: async (group: string) => ({ asked: sessions.filter((s) => s.taskGroup?.split("/")[0] === group && !s.shell).length }),
  runStates: async () => [],
  debugSessions: async () => [],
  debugBreakpoints: async () => ({ breakpoints: {} }),
  collabList: async () => [],
  collabModels: async () => {
    const presets = [
      { key: "opus", label: "Claude Opus", agent: "claude", model: "opus" },
      { key: "sonnet", label: "Claude Sonnet", agent: "claude", model: "sonnet" },
      { key: "gpt6", label: "GPT-6 Astra", agent: "codex", model: "gpt-6" },
    ];
    return { presets, defaults: presets.slice(0, 2).concat(presets[2]), efforts: { claude: ["low", "medium", "high", "max"], codex: ["low", "medium", "high"] } };
  },
  listRepos: async () => [
    { name: "backoffice", path: REPO, root: "/Users/you/Code" },
    { name: "client-portal", path: "/Users/you/Code/client-portal", root: "/Users/you/Code" },
  ],
  repoBranches: async () => ({ branches: ["dev", "main", "5101-orgDropdowns"], defaultBase: "dev" }),
  listWorktrees: async () => [],

  // files, editor, Source Control
  filesList: async (_id: string, rel: string) => dirEntries(rel ?? ""),
  filesRead: async (_id: string, rel: string) => (rel in files ? { binary: false, size: files[rel].length, content: files[rel], truncated: false, mtimeMs: (mtimes[rel] ??= now) } : err(`${rel} doesn't exist`)),
  filesWrite: async (_id: string, rel: string, text: string) => {
    files[rel] = text;
    mtimes[rel] = Date.now();
    return { saved: true, mtimeMs: mtimes[rel] };
  },
  filesAll: async () => ({ files: Object.keys(files), truncated: false }),
  filesSearch: async (_id: string, q: string) => {
    const hits = Object.entries(files).flatMap(([path, text]) => text.split("\n").flatMap((line, i) => (q && line.toLowerCase().includes(q.toLowerCase()) ? [{ path, line: i + 1, text: line }] : [])));
    return { hits, files: new Set(hits.map((h) => h.path)).size, stopped: null, warning: null };
  },
  filesChanges: async () => ({ changes: [{ path: "src/org/Dropdown.tsx", status: "M" }, { path: "src/org/lastOrg.ts", status: "U" }], base: "origin/dev" }),
  filesDiff: async (_id: string, rel: string) => unifiedDiff(rel),
  scmStatus: async () => ({ branch: "5101-orgDropdowns", upstream: "origin/5101-orgDropdowns", published: true, ahead: 1, behind: 0, staged: [], unstaged: [{ path: "src/org/Dropdown.tsx", status: "M" }, { path: "src/org/lastOrg.ts", status: "U" }], conflicted: [] }),
  scmDiff: async (_id: string, rel: string) => unifiedDiff(rel),
  scmGraph: async () => ({ commits, head: "a1b2c3d", refs: ["HEAD", "origin/dev"], more: false }),
  scmCommitFiles: async () => [{ path: "src/org/Dropdown.tsx", status: "M" }],
  scmCommitDiff: async () => unifiedDiff("src/org/Dropdown.tsx"),
  scmCommitMessage: async () => later({ message: "Remember the last org each user picked", scope: "all", agent: "claude" }, 800),
  scmFetch: async () => later(undefined, 400),
  scmPull: async () => later(err("This branch and origin/dev have both moved, so they can't be fast-forwarded."), 400),
  scmPush: async () => later({ upstream: "origin/5101-orgDropdowns" }, 400),
  lspOpen: async () => ({ server: null, state: "none" }),

  // board and tickets
  adoList: async () => ({ items: tickets, total: tickets.length, me: "You" }),
  adoMe: async () => ({ display: "You", email: "you@example.com", org: "acme", project: "Backoffice" }),
  adoStates: async () => ["New", "Active", "Resolved", "Closed"],
  adoBoards: async () => ({ team: "Backoffice Team", boards: [board] }),
  adoComments: async () => [{ id: 1, author: "Sam", date: new Date(now - 3 * 60 * min).toISOString(), text: "Can it remember per tenant too?" }],
  adoAddComment: async (_id: number, text: string) => ({ id: Date.now(), author: "You", date: new Date().toISOString(), text }),
  adoUpdate: async (id: number) => ({ id }),
  adoMoveToColumn: async (id: number, _type: string, _board: string, column: string) => ({ id, state: column }),
  pipelineAll: async () => JSON.parse(JSON.stringify(pipelines)),
  pipelineStage: async (id: string, stage: TicketStage) => setStage(id, stage),
  pipelineFeedback: async (id: string, text: string) => {
    pipelineOf(id).feedback.push({ at: Date.now(), text });
    return setStage(id, "local-test");
  },
  pipelineCheck: async (id: string, key: string, value: boolean) => {
    const p = pipelineOf(id);
    if (value) p.checks[key] = true;
    else delete p.checks[key];
    pipelinesChanged();
    return p;
  },
  pipelineDraftDrop: async (id: string, draftId: string) => {
    const p = pipelineOf(id);
    p.drafts = p.drafts.filter((d) => d.id !== draftId);
    pipelinesChanged();
    return p;
  },
  pipelineDraftPost: async (id: string, draftId: string) => api.pipelineDraftDrop(id, draftId),
  pipelinePrPreflight: async () => ({ branch: "5101-orgDropdowns", base: "dev", bases: ["dev", "main"], dirtyFiles: 2, commits: 1, remote: { provider: "ado", repo: "Backoffice/backoffice" }, docs: null, existing: null, lookupError: null }),
  pipelinePrDescribe: async () => later({ description: "## Summary\nThe org dropdown remembers each user's last org.\n\n## Changes\n- Store and read the last org\n\n## Testing\nNot stated", agent: "claude" }, 800),
  pipelinePrCreate: async () => err("UI preview: no pull request is opened"),
  presetStart: async () => err("UI preview: presets don't start sessions"),

  // undo, handoff, review, rollup
  turnsList: async () => ({ snapshots: [{ n: 2, sha: "x", at: now - 10 * min, prompt: "Make the org dropdown remember the last org each user picked", skipped: [], beforeUndo: false }, { n: 1, sha: "y", at: now - 70 * min, prompt: "Look at the org dropdown and plan the change", skipped: [], beforeUndo: false }], lastError: null }),
  turnsChanges: async () => [{ path: "src/org/Dropdown.tsx", action: "restore" }, { path: "src/org/lastOrg.ts", action: "remove" }],
  turnsRestore: async () => err("UI preview: no files are restored"),
  handoffDraft: async () => later({ handoff: "## Goal\nThe org dropdown remembers the last org per user.\n\n## Done\n- Dropdown preselects from lastOrg()\n\n## Next steps\n1. Add the API endpoint", from: "claude", to: "codex" }, 900),
  handoffStart: async () => err("UI preview: no session starts"),
  reviewStart: async () => err("UI preview: no review session starts"),
  rollupWrite: async () => later({ file: "/Users/you/Code/WorkTracker/session-digests/rollup-week-of-preview.md", markdown: "# Weekly rollup — preview\n\n## Summary\n- Active time: 12h 40m across 21 conversations (Claude 11h, Codex 1h 40m)\n\n## Tickets\n\n### #5101 Org dropdowns remember the last org — now: Local testing\n- Time: 6h 10m (Mon 2h, Tue 3h, Wed 1h 10m)\n" }, 500),

  // search, updates, setup
  searchTranscripts: async () => ({ hits: [], conversations: 128, files: 131, indexing: null, lastSync: now, problem: null }),
  updateCheck: async () => later({ latest: "1.3.1", current: "1.3.0", newer: true, url: "https://github.com/", source: "branch" }, 600),
  updateStatus: async () => ({ state: "idle", done: [], log: [] }),
  updateOutcome: async () => null,
  updateSource: async () => ({ configured: null, found: "/Users/you/Code/Mockingbird" }),
  setupStatus: async () => ({
    claude: { found: true, path: "/opt/homebrew/bin/claude", version: "2.1.290", signedIn: true },
    codex: { found: true, path: "/opt/homebrew/bin/codex", version: "0.156.1", signedIn: true },
    hooks: { claude: true, codex: true },
    repoRoots: [{ path: "~/Code", exists: true, repos: 12 }],
    workTrackerPath: "~/Code/WorkTracker",
    ado: { connected: true, display: "You", detail: "acme / Backoffice" },
  }),
  adoConfigGet: async () => ({ orgUrl: "https://dev.azure.com/acme", project: "Backoffice", patFile: "secrets/ado.pat" }),
  modelCatalog: async () => err("UI preview: no model catalog"),

  // team rooms: sharing, invites and joins are simulated; nothing connects
  teamStatus: async () => JSON.parse(JSON.stringify(team)),
  teamShareGroup: async (groupKey: string, title: string) => {
    // ?refuse: the signaling Worker refuses new rooms, as one without this key on ALLOWED_CREATORS does
    if (new URLSearchParams(location.search).has("refuse") && !team.rooms.some((r) => r.groupKey === groupKey)) {
      return later(err(`This signaling Worker doesn't allow new rooms yet — add your fingerprint (${team.self!.fingerprint}) to ALLOWED_CREATORS.\n\nOn the Worker, once: …`), 300);
    }
    let room = team.rooms.find((r) => r.groupKey === groupKey);
    if (!room) {
      room = { id: `R${groupKey}`.padEnd(22, "c").slice(0, 22), name: title, groupKey, members: [{ id: ME, name: "You", self: true }], online: [], signalingUrl: SIGNAL, signaling: "online" };
      team.rooms.push(room);
      teamChanged();
    }
    return later({ roomId: room.id, invite: inviteCode(room.id) }, 300);
  },
  teamCreateInvite: async (roomId: string) => ({ invite: inviteCode(roomId) }),
  teamJoin: async (code: string) => {
    if (!/^MBR1-/.test(code.trim())) return err("That isn't a Mockingbird room code — it starts with MBR1-");
    const roomId = "Rjoinedddddddddddddddd";
    team.pending.push({ roomId, name: "#5120 Gift aid", inviter: SAM, state: "waiting", since: Date.now() });
    teamChanged();
    setTimeout(() => {
      team.pending = team.pending.map((p) => (p.roomId === roomId ? { ...p, state: "syncing" } : p));
      teamChanged();
    }, 1200);
    setTimeout(() => {
      team.pending = team.pending.filter((p) => p.roomId !== roomId);
      team.rooms.push({ id: roomId, name: "#5120 Gift aid", groupKey: "5120", members: [{ id: SAM, name: "Sam", self: false }, { id: ME, name: "You", self: true }], online: [SAM], signalingUrl: SIGNAL, signaling: "online" });
      teamChanged();
    }, 2400);
    return { roomId, name: "#5120 Gift aid" };
  },
  teamCancelJoin: async (roomId: string) => {
    team.pending = team.pending.filter((p) => p.roomId !== roomId);
    teamChanged();
  },
  teamCheckSignaling: async () => later({ protocol: 1, relay: true, creators: 2, problem: null }, 400),

  // team rooms: plan board — changes apply to the fixture board; nothing reaches git
  planGet: async (roomId: string) => (plans[roomId] ? clone(plans[roomId]) : err(`Not a member of room ${roomId}`)),
  planRepos: async () => later([{ path: REPO, name: "backoffice", origin: "git@github.com:acme/backoffice.git", inRoom: true }, { path: "/Users/you/Code/donor-service", name: "donor-service", origin: "git@github.com:acme/donor-service.git", inRoom: false }], 150),
  planSync: async (roomId: string) => {
    const v = plans[roomId];
    if (!v) return err(`Not a member of room ${roomId}`);
    if (v.git.commit) v.git.commit.at = Date.now();
    v.fetchedAt = Date.now();
    planChanged(roomId);
    return later(clone(v), 500);
  },
  planApply: async (roomId: string, op: PlanOp) => {
    const v = plans[roomId];
    if (!v) return err(`Not a member of room ${roomId}`);
    const p = "id" in op ? v.plan.packages.find((x) => x.id === op.id) : undefined;
    if ("id" in op && !p) return err(`There's no package ${op.id} on the board`);
    const change = (c: Omit<PlanChange, "at" | "by">) => v.plan.changes.push({ at: Date.now(), by: ME, ...c });
    switch (op.kind) {
      case "create": {
        const id = `p-${Math.random().toString(36).slice(2, 10)}`;
        v.plan.packages.push(pkg(id, { ...op, title: op.title, createdAt: Date.now(), updatedAt: Date.now() }));
        change({ kind: "created", pkg: id, title: op.title });
        break;
      }
      case "edit":
        Object.assign(p!, Object.fromEntries(Object.entries(op).filter(([k]) => k !== "kind" && k !== "id")));
        change({ kind: "edited", pkg: p!.id, title: p!.title });
        break;
      case "claim":
        p!.owner = op.owner ?? ME;
        if (p!.status === "open") p!.status = "claimed";
        change({ kind: "claimed", pkg: p!.id, title: p!.title });
        break;
      case "release":
        p!.owner = null;
        if (p!.status !== "done") p!.status = "open";
        change({ kind: "released", pkg: p!.id, title: p!.title });
        break;
      case "status":
        p!.status = op.status;
        p!.statusNote = op.note ?? "";
        if (op.status === "open") p!.owner = null;
        else p!.owner ??= ME;
        change({ kind: "status", pkg: p!.id, title: p!.title, status: op.status, note: op.note });
        break;
      case "remove":
        v.plan.packages = v.plan.packages.filter((x) => x.id !== op.id);
        change({ kind: "removed", pkg: op.id, title: p!.title });
        break;
      case "repo":
        v.plan.repo = { origin: op.origin, name: op.name };
        v.git = { repo: v.plan.repo, clones: [REPO], state: "synced", commit: { sha: "9a8b7c6d5e4f30211a2b3c4d5e6f708192a3b4c5", at: Date.now(), pushed: true }, copies: 2 };
        change({ kind: "repo", repo: op.name });
        break;
    }
    planChanged(roomId);
    return { pkg: "id" in op ? op.id : null };
  },
};

w.mb = new Proxy(api, {
  get(target, name: string) {
    if (name in target) {
      return (...args: unknown[]) => {
        calls.push({ fn: name, args });
        return target[name](...args);
      };
    }
    if (name.startsWith("on")) return on(name);
    return async (...args: unknown[]) => {
      calls.push({ fn: name, args });
      console.warn(`[ui-preview] window.mb.${name} isn't simulated — answering with an error`);
      return err(`Not simulated in the UI preview: ${name}`);
    };
  },
});
w.__mbEmit = emit; // drive events from a script: __mbEmit("onSessionData", "s1", "text")

// a first visit (or ?reset) starts from a useful layout
const params = new URLSearchParams(location.search);
const set = (key: string, value: unknown) => localStorage.setItem(key, JSON.stringify(value));
if (params.has("reset") || !localStorage.getItem("mb.preview")) {
  localStorage.clear();
  localStorage.setItem("mb.preview", "1");
  localStorage.setItem("mb.helpSeen", "true");
  set("mb.tab", "sessions");
  set("mb.sideView", "sessions");
  set("mb.shown", ["s1", "s2", "s3", "s4"]);
}
// the screen to open on, for screenshots and links:
// ?tab=dashboard · ?view=scm (explorer, search, run) · ?section=about (a Settings section) · ?theme=light
// · ?shown=s1,s4 (the panes on screen: group 5101 has s1, s4, s8 and the workspace s2/s3; 5102 has s5, s6)
const tab = params.get("tab");
const view = params.get("view");
const section = params.get("section");
const theme = params.get("theme");
const shown = params.get("shown");
if (tab) set("mb.tab", tab);
if (view) set("mb.sideView", view);
if (section) {
  set("mb.tab", "settings");
  set("mb.setSection", section);
}
if (theme === "light" || theme === "dark") set("mb.theme", theme);
if (shown) set("mb.shown", shown.split(","));
// screenshots show the settled screen: no transition caught halfway (a theme switch fades colors)
if (params.has("shot")) {
  const still = document.createElement("style");
  still.textContent = "*, *::before, *::after { transition: none !important; animation: none !important; }";
  document.head.appendChild(still);
}
// team rooms: plan board — ?plan=1 opens the first shared group's plan board (2: the second); ?planWarning adds a claim warning
if (params.has("plan") || params.has("planWarning")) {
  let tries = 0;
  const open = setInterval(() => {
    const n = Number(params.get("plan")) || 1;
    const button = document.querySelectorAll('button[title^="Plan board"]')[n - 1] as HTMLElement | undefined;
    if (!button && ++tries < 50) return;
    clearInterval(open);
    if (params.has("plan")) button?.click();
    if (params.has("planWarning")) {
      const hit = { roomId: "R5101aaaaaaaaaaaaaaaaa", room: "#5101 Org dropdowns remember the last org", pkg: "p-api0last", title: "Last-org API", status: "in-progress", owner: { id: NICK, name: "Nick Smith" }, pattern: "src/api/orgs/" };
      emit("onPlanWarning", { at: Date.now(), sessionId: "s1", sessionTitle: "Org dropdowns remember the last org", decision: "deny", tool: "Edit", conflicts: [{ file: "src/api/orgs/last.py", root: WT("5101-orgDropdowns"), hits: [hit] }] });
    }
  }, 100);
}
if (params.has("reset")) {
  params.delete("reset");
  history.replaceState(null, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
}
