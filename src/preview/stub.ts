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
import { DEFAULT_SETTINGS, splitGroupKey } from "../shared/types";
import type { TeamStatus } from "../shared/team/types";
// team rooms: the House board
import { HOUSE_TOKEN_HOW, type HouseHistoryEntry, type HouseOwner, type HouseRow, type HouseTicket, type HouseTicketDetail, type HouseTicketView, type HouseView, type HouseWrite } from "../shared/team/house";
// team rooms: team chat
import { parseMentions, unreadCounts, type ChatEntry, type ReadMarks } from "../shared/team/chat";
// team rooms: take-over
import { NOT_PUSHED, type RoomSessionBackupView, type TakeoverPlan, type TakeoverView } from "../shared/team/takeover";
// team rooms: live panes
import { remotePaneId, type LivePanesState, type RoomSessionTag } from "../shared/team/livePanes";
// team rooms: artifacts
import { artifactRef, linkLabel, parseArtifactRefs, type ArtifactContent, type ArtifactLocal, type ArtifactSummary, type ArtifactView, type RoomArtifactsView } from "../shared/team/artifacts";

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
  session("s3", { title: "API tests", taskGroup: "5101/api", branch: "5101-orgDropdowns", cwd: WT("5101-orgDropdowns"), agent: "codex", agentVersion: "0.131.0", status: "idle" }),
  session("s4", { title: "test runner", taskGroup: "5101", shell: true, agent: undefined, status: "idle" }),
  session("s8", { title: "Release notes for #5101", taskGroup: "5101", branch: "5101-orgDropdowns", cwd: WT("5101-orgDropdowns"), status: "idle" }),
  session("s5", { title: "#5102 — Pathways quick view freezes", ticketId: "5102", ticketTitle: "Pathways quick view freezes", taskGroup: "5102", branch: "5102-quickViewFreeze", cwd: WT("5102-quickViewFreeze"), status: "idle" }),
  session("s6", { title: "Crashed session", taskGroup: "5102", status: "dead", exitCode: 1 }),
  session("s7", { title: "assistant", repoPath: null, cwd: "/Users/you", kind: "assistant", taskGroup: null, status: "idle" }),
  // continued on Nick's laptop: its agent stopped here (team rooms: take-over)
  session("y1", { title: "Donor entity model", taskGroup: "5110", branch: "5110-donor-entities", cwd: WT("5110-donor-entities"), status: "dead" }),
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
  y1: `${C.bold}> Model the donor entity and its gifts${C.reset}\r\n\r\n${C.teal}⏺${C.reset} Added Donor and Gift with a one-to-many relation.\r\n`,
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
// removed from 5101 by you (team rooms: leaving and removing)
const ALEX = "9e9e9e9e8d8d8d8d7c7c7c7c6b6b6b6b";
const SIGNAL = "https://mockingbird-signaling.you.workers.dev";
const teamQuery = new URLSearchParams(location.search);
// ?oldWorker: the signaling Worker predates revoke and approve, so removals can't cut anyone off there, and joiners aren't held at its door
const workerRevoke = !teamQuery.has("oldWorker");
const workerApprove = !teamQuery.has("oldWorker");
// ?joinRequest: Lee asks to join 5101 with Sam's code (you're its admin: the prompt shows); you passed Kim's request
// to 5110 on to its admin, Nick. ?joinRequest=later also presses Later, leaving Lee's in Settings → Team.
const LEE = "3c3c3c3c4d4d4d4d5e5e5e5e6f6f6f6f";
const KIM = "7a7a7a7a8b8b8b8b9c9c9c9cadadadad";
const fp = (id: string) => id.replace(/(.{4})(?=.)/g, "$1 ");
const asks = teamQuery.has("joinRequest");
const team: TeamStatus = {
  self: { id: ME, name: "You", fingerprint: fp(ME) },
  signalingUrl: SIGNAL,
  rooms: [
    {
      id: "R5101aaaaaaaaaaaaaaaaa", name: "#5101 Org dropdowns remember the last org", groupKey: "5101", members: [{ id: ME, name: "You", self: true }, { id: NICK, name: "Nick Smith", self: false }, { id: SAM, name: "Sam", self: false }], admin: ME, creator: ME, former: [{ id: ALEX, name: "Alex" }], online: [NICK], signalingUrl: SIGNAL, signaling: "online", workerRevoke, workerApprove,
      requests: asks ? [{ roomId: "R5101aaaaaaaaaaaaaaaaa", id: LEE, name: "Lee Park", fingerprint: fp(LEE), inviter: SAM, inviterName: "Sam", admin: ME, adminName: "You", role: "admin", state: "waiting", at: now - 3 * min, expiresAt: now + 6 * 24 * 60 * min }] : [],
    },
    {
      id: "R5110bbbbbbbbbbbbbbbbb", name: "#5110 Donor entities", groupKey: "5110", members: [{ id: NICK, name: "Nick Smith", self: false }, { id: ME, name: "You", self: true }], admin: NICK, creator: NICK, former: [], online: [NICK], signalingUrl: SIGNAL, signaling: "online", workerRevoke, workerApprove,
      requests: asks ? [{ roomId: "R5110bbbbbbbbbbbbbbbbb", id: KIM, name: "Kim", fingerprint: fp(KIM), inviter: ME, inviterName: "You", admin: NICK, adminName: "Nick Smith", role: "inviter", state: "waiting", at: now - 12 * min, expiresAt: now + 5 * 24 * 60 * min }] : [],
    },
  ],
  pending: [],
  peers: [
    { id: NICK, name: "Nick Smith", state: "turn", since: now - 40 * min },
    { id: SAM, name: "Sam", state: "offline", since: now - 3 * 60 * min },
  ],
  problems: [],
  // ?notice: Nick removed you from a room, and its backup couldn't be deleted from origin
  notices: teamQuery.has("notice")
    ? [{ id: "n1", roomId: "R5099ccccccccccccccccc", roomName: "#5099 Gift aid export", kind: "removed", by: "Nick Smith", at: now - 4 * min, problems: ["The backup of “Gift aid CSV” couldn't be deleted from origin (refs/mockingbird/rooms/R5099ccccccccccccccccc/s9): remote: Permission denied"] }]
    : [],
};
// team rooms: the House board — 5101 works in atticus-backoffice (a slice with a ticket in every state, and two the
// room added); 5110 has no project yet. ?houseMissing: this Mac has no token for 5101's project
const houseTicket = (n: number, title: string, status: string, claim: HouseTicket["claim"] = null, over: Partial<HouseTicket> = {}): HouseTicket => ({ n, title, status, priority: "medium", kind: "engineering", tags: [], claim, ...over });
const houseTickets: Record<number, HouseTicket> = {
  141: houseTicket(141, "Last-org API: GET/PUT /api/users/me/last-org", "in_progress", { by: "Nick Smith", branch: "5101-lastOrgApi", at: null }, { priority: "high" }),
  142: houseTicket(142, "Backfill each user's last org from the audit log", "ready"),
  143: houseTicket(143, "Org dropdown remembers the last org", "review", { by: "You", branch: "5101-orgDropdowns", at: null }),
  144: houseTicket(144, "Release notes and help article", "in_progress", { by: "Sam", branch: "5101-releaseNotes", at: null }, { tags: ["needs-human"], priority: "low" }),
  145: houseTicket(145, "Spike: per-tenant defaults", "parked", null, { kind: "investigation", priority: "investigate" }),
  150: houseTicket(150, "Org switcher flickers on slow connections", "parked"),
  151: houseTicket(151, "Dropdown keyboard navigation", "in_progress", { by: "You", branch: "5101-orgDropdowns", at: null }),
};
// team rooms: artifacts — their ids (the fixtures are further down)
const artId = (s: string) => s.padEnd(22, "0");
const ART = {
  spec: artId("Aspec"), copy: artId("Aspeccopy"), shot: artId("Ashot"), csv: artId("Acsv"), pdf: artId("Apdf"), repo: artId("Arepo"), link: artId("Alink"),
  env: artId("Aenv"), har: artId("Ahar"), mov: artId("Amov"), key: artId("Akey"), dump: artId("Adump"), log: artId("Alog"), gone: artId("Agone"),
};
const houseHistory: Record<number, HouseHistoryEntry[]> = {
  141: [
    { kind: "created", text: "", by: "Ryan", at: new Date(now - 26 * 60 * min).toISOString(), status: "parked", reference: null },
    { kind: "claim", text: "Claimed on 5101-lastOrgApi", by: "Nick Smith", at: new Date(now - 4 * 60 * min).toISOString(), status: "in_progress", reference: null },
    { kind: "progress", text: "GET works; PUT validates the org belongs to the user. Tests in tests/api/test_orgs.py.", by: "Nick Smith", at: new Date(now - 40 * min).toISOString(), status: null, reference: "https://github.com/acme/backoffice/pull/412" },
  ],
  144: [{ kind: "question", text: "Should the help article mention the per-tenant default, or wait for the spike?", by: "Sam", at: new Date(now - 70 * min).toISOString(), status: null, reference: null }],
};
const houseDetail = (n: number): HouseTicketDetail => ({
  ...houseTickets[n],
  url: null,
  detail: n === 141 ? "Store the last org a user picked per user, server side, so every device opens on it.\n\nThe dropdown (#143) reads it on load and writes it on change." : "",
  acceptance: n === 141 ? "GET returns the org last PUT by that user; PUT with an org the user can't see is a 403." : "",
  blockedBy: [],
  history: houseHistory[n] ?? [],
});
const houseOwner = (t: HouseTicket): HouseOwner | null => (t.claim ? { name: t.claim.by === "You" ? "You" : t.claim.by ?? "Someone", member: t.claim.by === "You" ? ME : t.claim.by === "Sam" ? SAM : NICK, self: t.claim.by === "You" } : null);
const houseRow = (n: number, addedBy?: string): HouseRow => ({ n, ticket: houseTickets[n] ?? null, owner: houseTickets[n] ? houseOwner(houseTickets[n]) : null, ...(addedBy ? { addedBy } : {}) });
const houseRooms: Record<string, { project: string | null; slice: number[]; added: { n: number; by: string }[]; isAdmin: boolean; admin: string }> = {
  R5101aaaaaaaaaaaaaaaaa: { project: "atticus-backoffice", slice: [141, 142, 143, 144, 145], added: [{ n: 150, by: "Nick Smith" }, { n: 151, by: "You" }], isAdmin: true, admin: "You" },
  R5110bbbbbbbbbbbbbbbbb: { project: null, slice: [], added: [], isAdmin: true, admin: "You" },
};
const houseView = (roomId: string): HouseView => {
  const r = houseRooms[roomId];
  const missing = teamQuery.has("houseMissing") && !!r.project;
  return {
    roomId,
    room: team.rooms.find((x) => x.id === roomId)?.name ?? roomId,
    project: r.project,
    admin: r.admin,
    isAdmin: r.isAdmin,
    envFile: r.project ? `~/.config/radley-house/${r.project}.env` : null,
    connection: !r.project
      ? { state: "unset" }
      : missing
        ? { state: "missing", file: `~/.config/radley-house/${r.project}.env`, message: `There's no ~/.config/radley-house/${r.project}.env on this Mac. ${HOUSE_TOKEN_HOW} Save it there (mode 600) as HOUSE_API_URL, HOUSE_PROJECT_ID and HOUSE_BUILD_TOKEN.` }
        : { state: "ok" },
    slice: r.project && !missing ? { name: "Slice 3 — org memory", listsTickets: true, rows: r.slice.map((n) => houseRow(n)) } : null,
    added: missing ? [] : r.added.filter((a) => !r.slice.includes(a.n)).map((a) => houseRow(a.n, a.by)),
    fetchedAt: r.project && !missing ? now - 40_000 : 0,
    refreshing: false,
    branches: roomId === "R5101aaaaaaaaaaaaaaaaa" ? ["5101-orgDropdowns"] : [],
  };
};
let houseNext = 160;
// team rooms: team chat — 5101's chat has a mention of you, agent updates, an assistant answer and one unread message from Sam
let lamport = 0;
const chatEntry = (over: Partial<ChatEntry> & Pick<ChatEntry, "kind" | "author" | "at">): ChatEntry => ({ id: `c${++lamport}`, lamport, text: "", ...over });
const chats: Record<string, ChatEntry[]> = {
  R5101aaaaaaaaaaaaaaaaa: [
    chatEntry({ kind: "message", author: NICK, at: now - 40 * min, text: "Morning! I'll take the **dropdown UI** — @You can you own the `last-org` endpoint?", mentions: [ME] }),
    chatEntry({ kind: "message", author: ME, at: now - 38 * min, text: "On it. Branch `5101-orgDropdowns`; the API session is going now.", mentions: [] }),
    chatEntry({ kind: "update", author: NICK, at: now - 30 * min, items: [
      { session: "n1", title: "Dropdown UI", kind: "finished", at: now - 30 * min },
      { session: "n2", title: "Dropdown tests", kind: "waiting", detail: "Claude needs your permission to use Bash", at: now - 30 * min },
    ] }),
    chatEntry({ kind: "update", author: NICK, at: now - 22 * min, items: [{ session: "", title: "Org dropdown UI", kind: "board", detail: "Nick claimed", at: now - 22 * min }] }),
    chatEntry({ kind: "message", author: NICK, at: now - 12 * min, text: "@assistant what's left before we can open the PR?", mentions: ["assistant"] }),
    chatEntry({ kind: "assistant", author: NICK, at: now - 11 * min, replyTo: "c5", state: "answer", text: "Two things:\n- **API**: `GET /api/users/me/last-org` is in; the PUT still needs a test (the *API tests* session is on it).\n- **UI**: Nick's dropdown tests wait on a Bash permission.\nOnce both are green, open the PR against `dev`." }),
    chatEntry({ kind: "update", author: ME, at: now - 6 * min, items: [{ session: "s2", title: "API: last org per user", kind: "waiting", detail: "Claude needs your permission to use Bash", at: now - 6 * min }] }),
    chatEntry({ kind: "message", author: SAM, at: now - 3 * min, text: "Heads up: `dev` moved this morning — rebase before the PR. Notes: https://dev.azure.com/acme/Backoffice/_wiki/rebase", mentions: [] }),
    chatEntry({ kind: "member", author: ME, at: now - 2 * min, member: ALEX, change: "removed" }),
    // team rooms: artifacts — a message naming two artifacts, and one since removed
    chatEntry({
      kind: "message",
      author: NICK,
      at: now - 90_000,
      text: `Spec's in ${artifactRef(ART.spec, "Last-org spec")} and the mock is ${artifactRef(ART.shot, "dropdown.png")} — ignore ${artifactRef(ART.gone, "old-mock.png")}, it's superseded.`,
      mentions: [],
      artifacts: [ART.spec, ART.shot, ART.gone],
    }),
  ],
  // 5110: an assistant turn that failed, and one still thinking
  R5110bbbbbbbbbbbbbbbbb: (() => {
    const draft = chatEntry({ kind: "message", author: NICK, at: now - 90 * min, text: "Donor entities: the schema draft is in docs/donors.md — @You have a look when you can.", mentions: [ME] });
    const asked = chatEntry({ kind: "message", author: ME, at: now - 5 * min, text: "@assistant which tables does the draft add?", mentions: ["assistant"] });
    const failed = chatEntry({ kind: "assistant", author: ME, at: now - 5 * min, replyTo: asked.id, state: "error", text: "Claude Code isn't installed (not found on your shell's PATH)" });
    const again = chatEntry({ kind: "message", author: NICK, at: now - 20_000, text: "@assistant summarize the draft for @You, then", mentions: ["assistant", ME] });
    return [draft, asked, failed, again, chatEntry({ kind: "assistant", author: NICK, at: now - 18_000, replyTo: again.id, state: "thinking" })];
  })(),
};
const chatRead: Record<string, ReadMarks> = { R5101aaaaaaaaaaaaaaaaa: { [NICK]: 6, [ME]: 7 } };
const chatJoined = now - 2 * 24 * 60 * min;
const chatView = (roomId: string) => {
  const entries = chats[roomId] ?? [];
  return { roomId, self: ME, joinedAt: chatJoined, entries, read: chatRead[roomId] ?? {}, ...unreadCounts(entries, ME, chatRead[roomId], chatJoined) };
};
const chatChanged = (roomId: string) => emit("onTeamChatChanged", roomId);
// team rooms: artifacts — 5101 has one of every kind and every transfer state: a note Sam edited (and the copy your crossing edit
// became), a screenshot, a CSV, a PDF, a repo file changed since, an ADO link, a secret-named file, and files downloading,
// waiting on an offline teammate, failed, fetched on demand and queued. 5110 has none yet.
const specText = `# Last-org spec

Each user's org pickers open on the **org they used last**, on every page that has one.

## API
- \`GET /api/users/me/last-org\` → \`{ orgId }\` (404 when there's none yet)
- \`PUT /api/users/me/last-org\` with \`{ orgId }\`; 403 when the user isn't in that org

## UI
1. Preselect the last org; fall back to the first
2. Save the choice on change, not on submit
- [x] Remembers within a session
- [ ] Remembers across devices (needs the API)

> Out of scope: per-tenant defaults — see the spike.

| Page | Picker | Done |
| --- | --- | :-: |
| Gifts | Org | ✓ |
| Pathways | Org + tag | |

The mock: ${artifactRef(ART.shot, "dropdown.png")} · ticket: [ADO #5101](https://dev.azure.com/acme/Backoffice/_workitems/edit/5101)
`;
const artTexts: Record<string, string> = {
  [ART.spec]: specText,
  [ART.copy]: specText.replace("Save the choice on change, not on submit", "Save the choice on change, debounced 500 ms"),
  [ART.csv]: 'org_id,name,members,last_used\n42,"Acme Foundation",318,2026-10-11\n7,"Bright Futures, Inc.",54,2026-10-09\n19,Cedar Grove Trust,121,2026-09-30\n23,"Delta ""Arts"" Council",12,\n',
  [ART.env]: "DATABASE_URL=postgres://staging-db.internal/backoffice\nFEATURE_LAST_ORG=1\nSENTRY_DSN=(in the vault)\n",
};
const KB = 1024;
const art = (over: Partial<ArtifactSummary> & Pick<ArtifactSummary, "id" | "kind" | "name" | "addedBy" | "addedAt">): ArtifactSummary => ({
  addedByName: over.addedBy === ME ? "You" : over.addedBy === NICK ? "Nick Smith" : "Sam",
  agentsBlocked: null,
  ...over,
});
const present = (view: ArtifactView, mime: string): ArtifactLocal => ({ state: "present", view, mime });
const artifactRooms: Record<string, RoomArtifactsView> = {
  R5101aaaaaaaaaaaaaaaaa: {
    roomId: "R5101aaaaaaaaaaaaaaaaa",
    self: ME,
    items: [
      art({ id: ART.spec, kind: "note", name: "Last-org spec", addedBy: NICK, addedAt: now - 3 * 60 * min, updatedByName: "Sam", updatedAt: now - 25 * min, rev: "r-spec-2", chars: specText.length }),
      art({ id: ART.copy, kind: "note", name: "Last-org spec (your edit)", addedBy: ME, addedAt: now - 24 * min, rev: "r-copy-1", chars: artTexts[ART.copy].length, conflictOf: ART.spec }),
      art({ id: ART.shot, kind: "file", name: "dropdown.png", addedBy: NICK, addedAt: now - 2 * 60 * min, size: 48 * KB, local: present("image", "image/png") }),
      art({ id: ART.csv, kind: "file", name: "orgs-export.csv", addedBy: SAM, addedAt: now - 5 * 60 * min, size: artTexts[ART.csv].length, local: present("csv", "text/csv") }),
      art({ id: ART.pdf, kind: "file", name: "Org picker review.pdf", addedBy: ME, addedAt: now - 26 * 60 * min, size: 1_240 * KB, local: present("pdf", "application/pdf") }),
      art({ id: ART.repo, kind: "repo", name: "Dropdown.tsx:1–3", addedBy: ME, addedAt: now - 40 * min, origin: "https://github.com/acme/backoffice", path: "src/org/Dropdown.tsx", commit: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", lines: [1, 3] }),
      art({ id: ART.link, kind: "link", name: "Export donors to CSV", addedBy: NICK, addedAt: now - 4 * 60 * min, url: "https://dev.azure.com/acme/Backoffice/_workitems/edit/5110", host: "dev.azure.com", label: "ADO #5110" }),
      art({ id: ART.env, kind: "file", name: ".env.staging", addedBy: SAM, addedAt: now - 60 * min, size: artTexts[ART.env].length, local: present("text", "text/plain"), agentsBlocked: "it's named like a secret (.env.staging)" }),
      art({ id: ART.har, kind: "file", name: "last-org-api.har", addedBy: NICK, addedAt: now - 10 * min, size: 6_350 * KB, local: { state: "downloading", received: 2_540 * KB, from: "Nick Smith" } }),
      art({ id: ART.mov, kind: "file", name: "picker-walkthrough.mov", addedBy: SAM, addedAt: now - 3 * 60 * min, size: 21_400 * KB, local: { state: "waiting", problem: "Sam added it and is offline; no connected teammate has it yet" } }),
      art({ id: ART.key, kind: "file", name: "Q4 roadmap.key", addedBy: NICK, addedAt: now - 28 * 60 * min, size: 8_800 * KB, local: { state: "failed", problem: "Nick's Mockingbird needs an update to share files" } }),
      art({ id: ART.dump, kind: "file", name: "db-sample.sql.gz", addedBy: SAM, addedAt: now - 2 * 24 * 60 * min, size: 24_600 * KB, local: { state: "on-demand" } }),
      art({ id: ART.log, kind: "file", name: "api-errors.log", addedBy: NICK, addedAt: now - min, size: 380 * KB, local: { state: "queued" } }),
    ],
    notices: [{ id: "an1", at: now - 24 * min, text: "Your edit of “Last-org spec” crossed Sam's; yours is kept as “Last-org spec (your edit)”.", artifact: ART.copy }],
    problems: [],
  },
  R5110bbbbbbbbbbbbbbbbb: { roomId: "R5110bbbbbbbbbbbbbbbbb", self: ME, items: [], notices: [], problems: [] },
};
const artBytes: Record<string, Uint8Array> = {};
const artifactsChanged = (roomId: string) => emit("onArtifactsChanged", roomId);
const artifactRoom = (roomId: string) => artifactRooms[roomId] ?? (team.rooms.some((r) => r.id === roomId) ? (artifactRooms[roomId] = { roomId, self: ME, items: [], notices: [], problems: [] }) : null);
const artifactOf = (roomId: string, id: string) => artifactRoom(roomId)?.items.find((a) => a.id === id);
let artSeq = 0;
const newArtId = () => `Anew${++artSeq}`.padEnd(22, "x");
const SECRET_NAME = /^\.env(\..*)?$|\.pem$|\.key$|^id_(rsa|ed25519)$/i;
/** What main's sniff would call a file, by its name here (the preview has no bytes to sniff). */
const sniffByName = (name: string): ArtifactLocal => {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return present("image", `image/${ext === "jpg" ? "jpeg" : ext}`);
  if (ext === "pdf") return present("pdf", "application/pdf");
  if (ext === "csv") return present("csv", "text/csv");
  if (ext === "md") return present("markdown", "text/markdown");
  if (["txt", "log", "json", "ts", "tsx", "py"].includes(ext)) return present("text", "text/plain");
  return present("binary", "application/octet-stream");
};
/** A fake screenshot of the org dropdown, drawn once: the viewer gets real PNG bytes. */
let mockPng: Promise<Uint8Array> | null = null;
const mockScreenshot = () =>
  (mockPng ??= new Promise<Uint8Array>((resolve, reject) => {
    const c = document.createElement("canvas");
    c.width = 720;
    c.height = 440;
    const g = c.getContext("2d")!;
    const box = (x: number, y: number, w: number, h: number, fill: string, stroke?: string) => {
      g.fillStyle = fill;
      g.beginPath();
      g.roundRect(x, y, w, h, 8);
      g.fill();
      if (stroke) {
        g.strokeStyle = stroke;
        g.stroke();
      }
    };
    const text = (s: string, x: number, y: number, font: string, color: string) => {
      g.font = font;
      g.fillStyle = color;
      g.fillText(s, x, y);
    };
    g.fillStyle = "#e9e5db";
    g.fillRect(0, 0, 720, 440);
    box(36, 28, 648, 384, "#fbf9f5", "#d8d2c4");
    g.fillStyle = "#efebe2";
    g.fillRect(37, 29, 646, 34);
    ["#cf6a5a", "#e0a34a", "#8fb573"].forEach((col, i) => box(52 + i * 18, 40, 11, 11, col));
    text("Gifts · New gift", 300, 51, "600 13px Helvetica", "#4f4a3f");
    text("Organization", 76, 104, "600 12px Helvetica", "#7b7466");
    box(76, 114, 300, 38, "#ffffff", "#1c8576");
    text("Acme Foundation", 90, 138, "14px Helvetica", "#2b2820");
    text("▾", 352, 138, "14px Helvetica", "#7b7466");
    box(76, 158, 300, 170, "#ffffff", "#d8d2c4");
    box(80, 162, 292, 38, "#e3f1ee");
    text("Acme Foundation", 92, 186, "14px Helvetica", "#2b2820");
    text("last used", 300, 186, "11px Helvetica", "#1d7a6c");
    ["Bright Futures, Inc.", "Cedar Grove Trust", "Delta Arts Council"].forEach((o, i) => text(o, 92, 228 + i * 38, "14px Helvetica", "#4f4a3f"));
    box(420, 114, 230, 92, "#f6ead2");
    text("Opens on the org", 438, 146, "600 14px Helvetica", "#8a6520");
    text("you used last", 438, 168, "600 14px Helvetica", "#8a6520");
    text("(per user, all pages)", 438, 190, "12px Helvetica", "#97824f");
    c.toBlob((b) => (b ? b.arrayBuffer().then((ab) => resolve(new Uint8Array(ab))) : reject(new Error("The canvas made no PNG"))), "image/png");
  }));
/** A transfer that runs to the end, as main's fetcher would. */
const runDownload = (roomId: string, a: ArtifactSummary) => {
  a.local = { state: "downloading", received: a.local?.state === "downloading" ? a.local.received : 0, from: a.addedByName };
  artifactsChanged(roomId);
  const step = setInterval(() => {
    if (a.local?.state !== "downloading") return clearInterval(step);
    const received = Math.min(a.size ?? 0, a.local.received + (a.size ?? 0) / 8);
    a.local = received >= (a.size ?? 0) ? sniffByName(a.name) : { ...a.local, received };
    artifactsChanged(roomId);
  }, 400);
};
// team rooms: take-over — 5101 backs up to origin (you turned it on as its admin): Nick's session backed up; Sam (offline) couldn't push, but his newest
// snapshot was copied here. 5110 keeps backups peer to peer (the default; Nick is its admin): one of yours taken over by Nick.
// ?p2p: 5101 keeps its backups peer to peer too — Sam's copy here is older than his last turn
const p2p = teamQuery.has("p2p");
const takeoverView: TakeoverView = (() => {
  const sha = (c: string) => c.repeat(40).slice(0, 40);
  const base = (o: Partial<RoomSessionBackupView> & Pick<RoomSessionBackupView, "sessionId" | "owner" | "ownerName">): RoomSessionBackupView => {
    const v: RoomSessionBackupView = {
      roomId: "R5101aaaaaaaaaaaaaaaaa",
      session: { title: "", agent: "claude", branch: "5101-orgDropdowns", originUrl: "https://dev.azure.com/acme/Backoffice/_git/backoffice", cwd: "/Users/nick/Code/worktrees/backoffice/5101-orgDropdowns", conversationId: "c0ffee00-0000-4000-8000-000000000001" },
      latest: { sha: sha("a1"), takenAt: now - 2 * min },
      toOrigin: true,
      push: { ok: true, at: now - 2 * min, sha: sha("a1") },
      pushed: { sha: sha("a1"), takenAt: now - 2 * min, at: now - 2 * min },
      transcriptBytes: 412_000,
      takenOver: null,
      dropped: null,
      ownerOnline: true,
      self: false,
      takenOverByName: null,
      peerCopy: { sha: sha("a1"), takenAt: now - 2 * min },
      heldBy: [],
      transcript: { have: 412_000, of: 412_000 },
      problem: null,
      ...o,
    };
    // a room that keeps backups peer to peer pushes nothing: its sessions say where their copies are
    return v.roomId === "R5110bbbbbbbbbbbbbbbbb" || p2p ? { ...v, toOrigin: false, push: { ok: false, at: v.latest.takenAt, error: NOT_PUSHED, sha: v.latest.sha }, pushed: null } : v;
  };
  const mine = (o: Partial<RoomSessionBackupView> & Pick<RoomSessionBackupView, "sessionId">) =>
    base({ owner: ME, ownerName: "You", self: true, peerCopy: null, transcript: null, session: { ...base({ sessionId: "", owner: ME, ownerName: "" }).session, cwd: WT("5101-orgDropdowns") }, ...o });
  return {
    sessions: [
      base({ sessionId: "n1", owner: NICK, ownerName: "Nick Smith", session: { ...base({ sessionId: "", owner: NICK, ownerName: "" }).session, title: "Donor export: CSV writer", branch: "5101-csvExport" } }),
      mine({ sessionId: "s1", latest: { sha: sha("e5"), takenAt: now - 1 * min }, push: { ok: true, at: now - 1 * min, sha: sha("e5") }, pushed: { sha: sha("e5"), takenAt: now - 1 * min, at: now - 1 * min }, heldBy: ["Nick Smith"] }),
      mine({ sessionId: "s2", latest: { sha: sha("f6"), takenAt: now - 5 * min }, push: { ok: false, at: now - 5 * min, error: "fatal: unable to access origin: Could not resolve host", sha: sha("f6") }, pushed: { sha: sha("e5"), takenAt: now - 40 * min, at: now - 40 * min } }),
      base({ roomId: "R5110bbbbbbbbbbbbbbbbb", sessionId: "n7", owner: NICK, ownerName: "Nick Smith", session: { ...base({ sessionId: "", owner: NICK, ownerName: "" }).session, title: "Donor entity model", branch: "5110-donor-entities", originUrl: "git@github.com:acme/donors.git" }, latest: { sha: sha("d5"), takenAt: now - 3 * min }, peerCopy: { sha: sha("d5"), takenAt: now - 3 * min } }),
      base({
        sessionId: "m1",
        owner: SAM,
        ownerName: "Sam",
        ownerOnline: false,
        session: { ...base({ sessionId: "", owner: SAM, ownerName: "" }).session, title: "Last-org API tests", agent: "codex", branch: "5101-api-tests", conversationId: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b" },
        latest: { sha: sha("b2"), takenAt: now - 4 * min },
        push: { ok: false, at: now - 4 * min, error: "remote: TF401027: You need the Git 'ForcePush' permission", sha: sha("b2") },
        pushed: { sha: sha("c3"), takenAt: now - 31 * min, at: now - 31 * min },
        peerCopy: p2p ? { sha: sha("c3"), takenAt: now - 31 * min } : { sha: sha("b2"), takenAt: now - 4 * min },
        transcriptBytes: 980_000,
        transcript: { have: 640_000, of: 980_000 },
      }),
      base({
        roomId: "R5110bbbbbbbbbbbbbbbbb",
        sessionId: "y1",
        owner: ME,
        ownerName: "You",
        self: true,
        session: { ...base({ sessionId: "", owner: ME, ownerName: "" }).session, title: "Donor entity model", branch: "5110-donor-entities" },
        takenOver: { by: NICK, at: now - 12 * min, newSessionId: "n7", snapshot: { sha: sha("d4"), takenAt: now - 15 * min, source: "peer" }, conversation: "full" },
        takenOverByName: "Nick Smith",
        peerCopy: null,
        transcript: null,
      }),
    ],
    rooms: [
      { roomId: "R5101aaaaaaaaaaaaaaaaa", toOrigin: !p2p, changed: { byName: "You", self: true, at: now - 3 * 24 * 60 * min }, adminName: "You", canChange: true, remote: "Azure DevOps" },
      { roomId: "R5110bbbbbbbbbbbbbbbbb", toOrigin: false, changed: null, adminName: "Nick Smith", canChange: false, remote: "GitHub" },
    ],
    unbacked: [],
    cleanup: [{ roomId: "R5101aaaaaaaaaaaaaaaaa", sessionId: "s0", title: "Spike: org cache", problem: "remote: TF401027: You need the Git 'ForcePush' permission to delete the backup" }],
    // ?handover: Nick asks to continue s1 on his laptop
    asks: new URLSearchParams(location.search).has("handover")
      ? [{ askId: "a1b2c3d4e5f60718293a4b5c", roomId: "R5101aaaaaaaaaaaaaaaaa", sessionId: "s1", title: "#5101 — Org dropdowns remember the last org", from: NICK, fromName: "Nick Smith", at: now, deadline: now + 120_000, state: "waiting" as const }]
      : [],
    asking: [],
    // y1 was continued on Nick's laptop: stopped here, with three files he doesn't have
    left: [
      {
        roomId: "R5110bbbbbbbbbbbbbbbbb",
        sessionId: "y1",
        title: "Donor entity model",
        by: NICK,
        byName: "Nick Smith",
        at: now - 12 * min,
        now: { owner: NICK, ownerName: "Nick Smith", sessionId: "n7", self: false, online: true },
        takeBack: true,
        unsent: { files: ["src/donors/gift.ts", "src/donors/donor.test.ts", "notes/donor-model.md"], checkedAt: now - min },
        sent: null,
        sending: false,
      },
    ],
    // s8 continues Sam's session; Sam sent what his copy had after that
    received: [
      {
        id: "0f1e2d3c4b5a6978",
        roomId: "R5101aaaaaaaaaaaaaaaaa",
        sessionId: "s8",
        fromSessionId: "m0",
        from: SAM,
        fromName: "Sam",
        title: "Release notes for #5101",
        files: [
          { path: "docs/release-notes.md", status: "modified" },
          { path: "docs/release-checklist.md", status: "added" },
        ],
        bytes: 2_310,
        at: now - 3 * min,
        applied: null,
      },
    ],
  };
})();
const receivedPatch = `diff --git a/docs/release-notes.md b/docs/release-notes.md
index 3b18e51..a1c9f04 100644
--- a/docs/release-notes.md
+++ b/docs/release-notes.md
@@ -1,4 +1,6 @@
 # Release notes

-- Org pickers open on the org you used last.
+- Org pickers now open on the org you used last, on every page that has one.
+- The choice is kept per user, across devices.
+
diff --git a/docs/release-checklist.md b/docs/release-checklist.md
new file mode 100644
index 0000000..5d1e2f3
--- /dev/null
+++ b/docs/release-checklist.md
@@ -0,0 +1,3 @@
+- [ ] The org dropdown remembers the last org on every page
+- [ ] Release note reviewed
+- [ ] Screenshots updated
`;
const takeoverPlans: Record<string, TakeoverPlan> = {
  n1: { roomId: "R5101aaaaaaaaaaaaaaaaa", sessionId: "n1", title: "Donor export: CSV writer", agent: "claude", branch: "5101-csvExport", ownerName: "Nick Smith", ownerOnline: true, originUrl: "https://dev.azure.com/acme/Backoffice/_git/backoffice", clone: REPO, snapshot: { sha: "a1".repeat(20), takenAt: now - 2 * min, source: p2p ? "peer" : "origin", skipped: [] }, other: null, toOrigin: !p2p, originProblem: null, latestMissing: false, conversation: { kind: "full", bytes: 412_000 } },
  // ?p2p: only the copy that reached this Mac half an hour ago, a turn behind Sam's laptop
  m1: p2p
    ? { roomId: "R5101aaaaaaaaaaaaaaaaa", sessionId: "m1", title: "Last-org API tests", agent: "codex", branch: "5101-api-tests", ownerName: "Sam", ownerOnline: false, originUrl: "https://dev.azure.com/acme/Backoffice/_git/backoffice", clone: REPO, snapshot: { sha: "c3".repeat(20), takenAt: now - 31 * min, source: "peer", skipped: [] }, other: null, toOrigin: false, originProblem: null, latestMissing: true, conversation: { kind: "partial", have: 640_000, of: 980_000 } }
    : { roomId: "R5101aaaaaaaaaaaaaaaaa", sessionId: "m1", title: "Last-org API tests", agent: "codex", branch: "5101-api-tests", ownerName: "Sam", ownerOnline: false, originUrl: "https://dev.azure.com/acme/Backoffice/_git/backoffice", clone: REPO, snapshot: { sha: "b2".repeat(20), takenAt: now - 4 * min, source: "peer", skipped: [] }, other: { sha: "c3".repeat(20), takenAt: now - 31 * min, source: "origin" }, toOrigin: true, originProblem: null, latestMissing: false, conversation: { kind: "partial", have: 640_000, of: 980_000 } },
  // 5110 keeps backups peer to peer: what Nick's laptop sent while connected
  n7: { roomId: "R5110bbbbbbbbbbbbbbbbb", sessionId: "n7", title: "Donor entity model", agent: "claude", branch: "5110-donor-entities", ownerName: "Nick Smith", ownerOnline: true, originUrl: "git@github.com:acme/donors.git", clone: REPO, snapshot: { sha: "d5".repeat(20), takenAt: now - 3 * min, source: "peer", skipped: [] }, other: null, toOrigin: false, originProblem: null, latestMissing: false, conversation: { kind: "full", bytes: 412_000 } },
};
const takeoverChanged = () => emit("onTeamTakeoverChanged", JSON.parse(JSON.stringify(takeoverView)));
const inviteCode = (roomId: string) => `MBR1-${btoa(JSON.stringify({ r: roomId, u: SIGNAL, t: Math.random().toString(36).slice(2), f: ME, n: "preview" })).replace(/=+$/, "")}`;

// team rooms: live panes — Nick's session in the shared 5101 room, shown here as a copy;
// he has your s1 open and is in it. 5101's own sessions are room sessions: the terminal,
// and the Codex one on a Codex too old for the room's permission profile, run without
// the secret deny rules, and say so.
const ROOM_5101 = "R5101aaaaaaaaaaaaaaaaa";
const NICK_PANE = remotePaneId(NICK, "n1");
const SAM_PANE = remotePaneId(SAM, "m1");
const ROOM_5110 = "R5110bbbbbbbbbbbbbbbbb";
const roomTag = (over: Partial<RoomSessionTag>): RoomSessionTag => ({
  roomId: ROOM_5101, sessionId: "", owner: ME, ownerName: "You", remote: false, online: true, live: true, lookers: [], cols: 120, rows: 32,
  git: null, repo: "https://github.com/acme/backoffice.git", repoName: "backoffice", guards: { secrets: true, coauthors: true }, ...over,
});
const nickGit = { branch: "5101-csvExport", upstream: "origin/5101-csvExport", ahead: 2, behind: 0, dirtyFiles: 3, insertions: 41, deletions: 6 };
const live: LivePanesState = {
  remote: [
    session(NICK_PANE, {
      title: "Donor export: CSV writer", taskGroup: "5101", branch: "5101-csvExport", repoPath: null, cwd: "(on Nick Smith's Mockingbird) backoffice", status: "working", model: "sonnet",
      room: roomTag({ sessionId: "n1", owner: NICK, ownerName: "Nick Smith", remote: true, cols: 110, rows: 30, git: nickGit, lookers: [{ id: NICK, name: "Nick Smith", focused: false }] }),
    }),
    session(SAM_PANE, {
      title: "Last-org API tests", taskGroup: "5101/api", branch: "5101-api-tests", repoPath: null, cwd: "(on Sam's Mockingbird) backoffice", status: "idle", agent: "codex",
      room: roomTag({ sessionId: "m1", owner: SAM, ownerName: "Sam", remote: true, online: false, guards: { secrets: false, coauthors: true } }),
    }),
    session(remotePaneId(NICK, "n7"), {
      title: "Donor entity model", taskGroup: "5110", branch: "5110-donor-entities", repoPath: null, cwd: "(on Nick Smith's Mockingbird) backoffice", status: "working",
      room: roomTag({ roomId: ROOM_5110, sessionId: "n7", owner: NICK, ownerName: "Nick Smith", remote: true }),
    }),
  ],
  own: {
    s1: roomTag({ sessionId: "s1", lookers: [{ id: NICK, name: "Nick Smith", focused: true }] }),
    s2: roomTag({ sessionId: "s2" }),
    s3: roomTag({ sessionId: "s3", guards: { secrets: false, coauthors: true } }),
    s4: roomTag({ sessionId: "s4", guards: { secrets: false, coauthors: true } }),
    s8: roomTag({ sessionId: "s8" }),
    y1: roomTag({ roomId: ROOM_5110, sessionId: "y1", live: true, takenOver: { by: NICK, byName: "Nick Smith", at: now - 12 * min } }),
  },
  views: [{ member: NICK, name: "Nick Smith", shown: ["s1", NICK_PANE], focused: "s1", at: now }],
  problems: [],
};
buffers[SAM_PANE] = `${C.dim}codex${C.reset}\r\n› Cover the last-org endpoint's error cases\r\n\r\n• Added 3 tests for 404 and 403\r\n`;
buffers[remotePaneId(NICK, "n7")] = `${C.bold}> Carry on with the donor entity: add the gift aid flag${C.reset}\r\n\r\n${C.teal}⏺${C.reset} Update(src/donors/entity.ts)\r\n`;
buffers[NICK_PANE] = `${C.bold}> Write the donor CSV export (UTF-8 BOM, one row per gift)${C.reset}\r\n\r\n${C.teal}⏺${C.reset} Write(src/donors/exportCsv.ts)\r\n  ⎿  Wrote 64 lines\r\n\r\n${C.amber}✻${C.reset} Running the export tests… ${C.dim}(18s · esc to interrupt)${C.reset}\r\n`;

// ---- event plumbing ------------------------------------------------------------

const listeners: Record<string, Set<(...a: any[]) => void>> = {};
const on = (name: string) => (cb: (...a: any[]) => void) => {
  (listeners[name] ??= new Set()).add(cb);
  return () => listeners[name].delete(cb);
};
const emit = (name: string, ...args: unknown[]) => listeners[name]?.forEach((cb) => cb(...args));
const sessionsChanged = () => emit("onSessionsChanged", sessions.map((s) => ({ ...s })));
const teamChanged = () => emit("onTeamChanged", JSON.parse(JSON.stringify(team)));
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
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
    // team rooms: a session started in a room's group is one of that room's sessions, as main tags it
    const room = s.taskGroup ? team.rooms.find((r) => r.groupKey === splitGroupKey(s.taskGroup!).top) : undefined;
    if (room) {
      live.own[id] = roomTag({ roomId: room.id, sessionId: id });
      emit("onTeamLive", JSON.parse(JSON.stringify(live)));
    }
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
  overlapsGet: async () => ({ s1: [{ other: "s5", otherTitle: "Pathways quick view freezes", otherBranch: "5102-quickViewFreeze", files: ["src/org/Dropdown.tsx"] }, { other: `team:${NICK}:5101-lastOrgApi`, otherTitle: "Nick Smith's pushed branch", otherBranch: "5101-lastOrgApi", files: ["src/org/Dropdown.tsx"], teammate: { id: NICK, name: "Nick Smith", roomId: ROOM_5101 } }], s5: [{ other: "s1", otherTitle: "Org dropdowns remember the last org", otherBranch: "5101-orgDropdowns", files: ["src/org/Dropdown.tsx"] }] }),
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
  // a few conversations to find (any age), so a search shows hits; \u0001…\u0002 mark the match
  searchTranscripts: async (q: string) => {
    const words = q.trim().toLowerCase();
    const all = [
      { id: "c-old-1", agent: "claude", cwd: "/Users/you/Code/worktrees/backoffice/5098-donorExport", title: "Donor export times out on big orgs", text: "the donor export query does a full scan — add an index on org_id", open: { how: "resume" } },
      { id: "c-old-2", agent: "codex", cwd: "/Users/you/Code/backoffice", title: "Org picker remembers nothing", text: "store the last org per user and preselect it in the org picker", open: { how: "resume" } },
      { id: "c-old-3", agent: "claude", cwd: "/Users/you/Code/client-portal", title: "Portal login loop", text: "MSAL redirect loops when the org cookie is missing", open: { how: "pane", sessionId: "s5" } },
    ];
    const hits = words
      ? all
          .filter((c) => `${c.title} ${c.text}`.toLowerCase().includes(words))
          .map((c, i) => {
            const at = c.text.toLowerCase().indexOf(words);
            const snippet = at < 0 ? c.text : `${c.text.slice(0, at)}\u0001${c.text.slice(at, at + words.length)}\u0002${c.text.slice(at + words.length)}`;
            return { id: c.id, agent: c.agent, cwd: c.cwd, title: c.title, started: now - (i + 3) * 86_400_000, updated: now - (i + 2) * 86_400_000, model: null, snippet, at: now - (i + 2) * 86_400_000, kind: "message", open: c.open };
          })
      : [];
    return { hits, conversations: 128, files: 131, indexing: null, lastSync: now, problem: null };
  },
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
  // the inviter passes it on to the room's admin (Sam), who accepts after a moment;
  // ?joining=wait: Sam doesn't answer · ?joining=declined: Sam declines
  teamJoin: async (code: string) => {
    if (!/^MBR1-/.test(code.trim())) return err("That isn't a Mockingbird room code — it starts with MBR1-");
    const roomId = "Rjoinedddddddddddddddd";
    const outcome = teamQuery.get("joining");
    const set = (patch: Partial<TeamStatus["pending"][number]>) => {
      team.pending = team.pending.map((p) => (p.roomId === roomId ? { ...p, ...patch } : p));
      teamChanged();
    };
    team.pending.push({ roomId, name: "#5120 Gift aid", inviter: SAM, state: "waiting", since: Date.now() });
    teamChanged();
    setTimeout(() => set({ state: "approval", admin: "Sam" }), 500);
    if (outcome === "wait") return { roomId, name: "#5120 Gift aid" };
    if (outcome === "declined") {
      setTimeout(() => set({ state: "declined", reason: "Sam declined your request to join #5120 Gift aid" }), 1500);
      return { roomId, name: "#5120 Gift aid" };
    }
    setTimeout(() => set({ state: "syncing" }), 2500);
    setTimeout(() => {
      team.pending = team.pending.filter((p) => p.roomId !== roomId);
      team.rooms.push({ id: roomId, name: "#5120 Gift aid", groupKey: "5120", members: [{ id: SAM, name: "Sam", self: false }, { id: ME, name: "You", self: true }], admin: SAM, creator: SAM, online: [SAM], signalingUrl: SIGNAL, signaling: "online", workerApprove });
      teamChanged();
    }, 3500);
    return { roomId, name: "#5120 Gift aid" };
  },
  teamAnswerJoin: async (roomId: string, joinerId: string, accept: boolean) => {
    const room = team.rooms.find((r) => r.id === roomId);
    const r = room?.requests?.find((q) => q.id === joinerId && q.role === "admin");
    if (!room || !r) return err("Nobody with that key is asking to join");
    room.requests = room.requests!.filter((q) => q !== r);
    if (accept) {
      room.members = [...room.members, { id: r.id, name: r.name, self: false }];
      (chats[roomId] ??= []).push(chatEntry({ kind: "member", author: ME, at: Date.now(), member: r.id, change: "accepted" }));
      chatChanged(roomId);
    }
    teamChanged();
    const worker = accept || workerApprove ? null : `Your signaling Worker is older: it let ${r.name} connect before you answered (they got nothing of the room). Update it (cd signaling && npx wrangler deploy) to also hold joiners at the door.`;
    return later({ name: r.name, accepted: accept, worker }, 500);
  },
  teamCancelJoin: async (roomId: string) => {
    team.pending = team.pending.filter((p) => p.roomId !== roomId);
    teamChanged();
  },
  // team rooms: leaving and removing — the room or member goes from the fixture; nothing is deleted
  teamLeaveRoom: async (roomId: string) => {
    const room = team.rooms.find((r) => r.id === roomId);
    if (!room) return err("You're not in that room");
    const others = room.members.filter((m) => !m.self);
    team.rooms = team.rooms.filter((r) => r.id !== roomId);
    teamChanged();
    const worker = workerRevoke ? null : "Your signaling Worker is older and doesn't know how to cut members off. Update your signaling Worker (cd signaling && npx wrangler deploy) to also cut this Mockingbird off at the Worker.";
    return later({ roomName: room.name, told: others.filter((m) => room.online.includes(m.id)).map((m) => m.name), notTold: others.filter((m) => !room.online.includes(m.id)).map((m) => m.name), worker, problems: [] }, 700);
  },
  teamRemoveMember: async (roomId: string, memberId: string) => {
    const room = team.rooms.find((r) => r.id === roomId);
    const member = room?.members.find((m) => m.id === memberId) ?? room?.former?.find((m) => m.id === memberId);
    if (!room || !member) return err("They aren't in that room");
    if (room.admin !== ME) return err("Only the room's admin can remove members");
    if (room.members.some((m) => m.id === memberId)) {
      room.members = room.members.filter((m) => m.id !== memberId);
      room.former = [...(room.former ?? []), { id: member.id, name: member.name }];
      (chats[roomId] ??= []).push(chatEntry({ kind: "member", author: ME, at: Date.now(), member: memberId, change: "removed" }));
      teamChanged();
      chatChanged(roomId);
    }
    const worker = workerRevoke ? null : "Your signaling Worker is older and doesn't know how to cut members off. Update your signaling Worker (cd signaling && npx wrangler deploy) to also cut them off at the Worker.";
    return later({ name: member.name, delivered: room.online.includes(memberId), worker }, 600);
  },
  teamDismissNotice: async (id: string) => {
    team.notices = (team.notices ?? []).filter((n) => n.id !== id);
    teamChanged();
  },
  teamCheckSignaling: async () => later({ protocol: 1, relay: true, creators: 2, problem: null }, 400),

  // team rooms: the House board — reads and writes apply to the fixture tickets; nothing reaches the House
  houseGet: async (roomId: string) => (houseRooms[roomId] ? houseView(roomId) : err(`Not a member of room ${roomId}`)),
  houseWatch: async (roomId: string) => (houseRooms[roomId] ? houseView(roomId) : err(`Not a member of room ${roomId}`)),
  houseRefresh: async (roomId: string) => (houseRooms[roomId] ? later(houseView(roomId), 400) : err(`Not a member of room ${roomId}`)),
  houseTicket: async (roomId: string, n: number): Promise<HouseTicketView> => {
    const r = houseRooms[roomId];
    if (!houseTickets[n]) return later({ error: `The House answered 404: no work item #${n} in this project` }, 200);
    return later({ detail: houseDetail(n), owner: houseOwner(houseTickets[n]), onBoard: r?.slice.includes(n) ? "slice" : r?.added.some((a) => a.n === n) ? "added" : null }, 200);
  },
  houseWrite: async (roomId: string, w: HouseWrite) => {
    const r = houseRooms[roomId];
    if (!r) return err(`Not a member of room ${roomId}`);
    const at = new Date().toISOString();
    const log = (n: number, e: Omit<HouseHistoryEntry, "at" | "by" | "reference" | "status"> & Partial<HouseHistoryEntry>) => (houseHistory[n] ??= []).push({ at, by: "You", reference: null, status: null, ...e });
    switch (w.kind) {
      case "project":
        r.project = w.project;
        break;
      case "track":
        if (!houseTickets[w.n]) return err(`The House answered 404: no work item #${w.n} in this project`);
        if (!r.added.some((a) => a.n === w.n)) r.added.push({ n: w.n, by: "You" });
        break;
      case "untrack":
        r.added = r.added.filter((a) => a.n !== w.n);
        break;
      case "claim":
        houseTickets[w.n] = { ...houseTickets[w.n], status: "in_progress", claim: { by: "You", branch: w.branch, at } };
        log(w.n, { kind: "claim", text: `Claimed on ${w.branch}`, status: "in_progress" });
        break;
      case "release":
        houseTickets[w.n] = { ...houseTickets[w.n], status: "ready", claim: null };
        log(w.n, { kind: "release", text: "" });
        break;
      case "event":
        if (w.status) houseTickets[w.n] = { ...houseTickets[w.n], status: w.status };
        if (w.event === "question") houseTickets[w.n] = { ...houseTickets[w.n], tags: [...houseTickets[w.n].tags.filter((t) => t !== "needs-agent" && t !== "needs-human"), "needs-human"] };
        log(w.n, { kind: w.event === "status" ? "progress" : w.event, text: w.text, status: w.status ?? null });
        break;
      case "create": {
        const n = houseNext++;
        houseTickets[n] = houseTicket(n, w.title, "parked");
        r.added.push({ n, by: "You" });
        log(n, { kind: "created", text: w.description, status: "parked" });
        break;
      }
    }
    emit("onHouseChanged", houseView(roomId));
    return later({ message: "Saved to the House" }, 250);
  },
  houseOpen: async () => later(undefined, 50),
  // team rooms: team chat — posting works; @assistant thinks, then answers
  teamChatView: async (roomId: string) => (team.rooms.some((r) => r.id === roomId) ? chatView(roomId) : err("You're not in that room")),
  teamChatUnread: async () => Object.fromEntries(team.rooms.map((r) => [r.id, (({ unread, mentions }) => ({ unread, mentions }))(chatView(r.id))])),
  teamChatViewing: async () => undefined,
  teamChatRead: async (roomId: string) => {
    const marks = { ...(chatRead[roomId] ?? {}) };
    for (const e of chats[roomId] ?? []) marks[e.author] = Math.max(marks[e.author] ?? 0, e.lamport);
    chatRead[roomId] = marks;
    chatChanged(roomId);
    const { unread, mentions } = chatView(roomId);
    return { unread, mentions };
  },
  teamChatPost: async (roomId: string, text: string) => {
    const room = team.rooms.find((r) => r.id === roomId);
    if (!room) return err("You're not in that room");
    if (!text.trim()) return err("The message is empty");
    const message = chatEntry({ kind: "message", author: ME, at: Date.now(), text: text.trim(), mentions: parseMentions(text, room.members) });
    // team rooms: artifacts — the live ones it names, as main records them
    const named = parseArtifactRefs(text).filter((id) => artifactOf(roomId, id));
    if (named.length) message.artifacts = named;
    (chats[roomId] ??= []).push(message);
    chatChanged(roomId);
    if (message.mentions!.includes("assistant")) {
      const thinking = chatEntry({ kind: "assistant", author: ME, at: Date.now(), replyTo: message.id, state: "thinking" });
      chats[roomId].push(thinking);
      chatChanged(roomId);
      setTimeout(() => {
        chats[roomId] = chats[roomId].filter((e) => e !== thinking);
        chats[roomId].push(chatEntry({ kind: "assistant", author: ME, at: Date.now(), replyTo: message.id, state: "answer", text: "In the UI preview the assistant only pretends — in the app it answers from the room's chat, board, sessions and docs." }));
        chatChanged(roomId);
      }, 1500);
    }
    return { id: message.id };
  },

  // team rooms: artifacts — adds, edits and transfers apply to the fixtures; Quick Look, Reveal and Save as only log
  artifactsList: async (roomId: string) => (artifactRoom(roomId) ? clone(artifactRoom(roomId)) : err("You're not in that room")),
  artifactsPickFiles: async () => later(["/Users/you/Desktop/org-picker-v2.png", "/Users/you/Desktop/.env.local"], 200),
  artifactsAddFiles: async (roomId: string, paths: string[], confirmSecret?: boolean) => {
    const room = artifactRoom(roomId);
    if (!room) return err("You're not in that room");
    const added: { id: string; name: string; warnings: string[] }[] = [];
    const refused: { name: string; reason: string; needsConfirm?: "secret" }[] = [];
    for (const p of paths) {
      const name = p.slice(p.lastIndexOf("/") + 1);
      if (SECRET_NAME.test(name) && !confirmSecret) {
        refused.push({ name, reason: "named like a secret", needsConfirm: "secret" });
        continue;
      }
      const id = newArtId();
      room.items.push(art({ id, kind: "file", name, addedBy: ME, addedAt: Date.now(), size: 96 * KB, local: sniffByName(name), agentsBlocked: SECRET_NAME.test(name) ? `it's named like a secret (${name})` : null }));
      if (!name.endsWith(".png")) artTexts[id] = `${name}: added in the UI preview — nothing was read from disk.\n`;
      added.push({ id, name, warnings: [] });
    }
    artifactsChanged(roomId);
    return later({ added, refused }, 250);
  },
  artifactsAddBytes: async (roomId: string, name: string, bytes: Uint8Array, confirmSecret?: boolean) => {
    const room = artifactRoom(roomId);
    if (!room) return err("You're not in that room");
    if (SECRET_NAME.test(name) && !confirmSecret) return { added: [], refused: [{ name, reason: "named like a secret", needsConfirm: "secret" }] };
    const id = newArtId();
    artBytes[id] = bytes;
    room.items.push(art({ id, kind: "file", name, addedBy: ME, addedAt: Date.now(), size: bytes.length, local: sniffByName(name) }));
    artifactsChanged(roomId);
    return { added: [{ id, name, warnings: [] }], refused: [] };
  },
  artifactsAddNote: async (roomId: string, name: string, text: string) => {
    const room = artifactRoom(roomId);
    if (!room) return err("You're not in that room");
    const id = newArtId();
    artTexts[id] = text;
    room.items.push(art({ id, kind: "note", name, addedBy: ME, addedAt: Date.now(), rev: id, chars: text.length }));
    artifactsChanged(roomId);
    return { id, name, warnings: [] };
  },
  artifactsAddRepo: async (roomId: string, req: { sessionId: string; path: string; lines?: [number, number] | null; name?: string }) => {
    const room = artifactRoom(roomId);
    const s = byId(req.sessionId);
    if (!room || !s) return err(!room ? "You're not in that room" : "That session has ended");
    if (!(req.path in files)) return err(`${req.path} isn't tracked by git — commit it first`);
    const id = newArtId();
    const name = req.name ?? req.path.slice(req.path.lastIndexOf("/") + 1);
    room.items.push(art({ id, kind: "repo", name, addedBy: ME, addedAt: Date.now(), origin: "https://github.com/acme/backoffice", path: req.path, commit: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", lines: req.lines ?? undefined }));
    artifactsChanged(roomId);
    const warnings = files[req.path] !== headFiles[req.path] ? [`${req.path} has uncommitted changes — the reference is HEAD a1b2c3d`] : [];
    return later({ id, name, warnings: [...warnings, "teammates can't see a1b2c3d until you push"] }, 200);
  },
  artifactsAddLink: async (roomId: string, url: string, title: string) => {
    const room = artifactRoom(roomId);
    const l = linkLabel(url);
    if (!room || !l) return err(!room ? "You're not in that room" : "Only https links");
    const id = newArtId();
    room.items.push(art({ id, kind: "link", name: title, addedBy: ME, addedAt: Date.now(), url, host: l.host, label: l.label ?? undefined }));
    artifactsChanged(roomId);
    return { id, name: title, warnings: [] };
  },
  artifactsRename: async (roomId: string, id: string, name: string) => {
    const a = artifactOf(roomId, id);
    if (!a) return err("That artifact was removed");
    a.name = name;
    if (SECRET_NAME.test(name)) a.agentsBlocked = `it was named like a secret (${name})`;
    artifactsChanged(roomId);
    return null;
  },
  artifactsRemove: async (roomId: string, id: string) => {
    const room = artifactRoom(roomId);
    if (!room?.items.some((a) => a.id === id)) return err("That artifact was removed");
    room.items = room.items.filter((a) => a.id !== id);
    artifactsChanged(roomId);
    return null;
  },
  artifactsSaveNote: async (roomId: string, id: string, text: string, base: string, mode: "save" | "overwrite" | "copy") => {
    const room = artifactRoom(roomId);
    const a = artifactOf(roomId, id);
    if (!room || !a || a.kind !== "note") return err("That note was removed");
    if (mode === "copy") {
      const copy = newArtId();
      artTexts[copy] = text;
      room.items.push(art({ id: copy, kind: "note", name: `${a.name} (copy)`, addedBy: ME, addedAt: Date.now(), rev: copy, chars: text.length }));
      artifactsChanged(roomId);
      return { copy };
    }
    if (mode === "save" && base !== a.rev) return { stale: { rev: a.rev!, byName: a.updatedByName ?? a.addedByName, at: a.updatedAt ?? a.addedAt } };
    artTexts[id] = text;
    Object.assign(a, { rev: `r${Date.now()}`, chars: text.length, updatedByName: "You", updatedAt: Date.now() });
    artifactsChanged(roomId);
    return { rev: a.rev };
  },
  artifactsRead: async (roomId: string, id: string): Promise<ArtifactContent | { error: string }> => {
    const a = artifactOf(roomId, id);
    if (!a) return err("That artifact was removed");
    if (a.kind === "note") return { view: "note", text: artTexts[id] ?? "", rev: a.rev! };
    if (a.kind === "link") return { view: "link", url: a.url! };
    if (a.kind === "repo") return err("A repo file is resolved, not read");
    if (a.local?.state !== "present") return { view: "missing", local: a.local! };
    const { view, mime } = a.local;
    if (view === "image") return { view, mime, bytes: artBytes[id] ?? (await mockScreenshot()) };
    if (view === "pdf" || view === "binary") return { view, mime, size: a.size ?? 0 };
    return { view, text: artTexts[id] ?? "", truncated: false };
  },
  artifactsDownload: async (roomId: string, id: string) => {
    const a = artifactOf(roomId, id);
    if (!a || a.kind !== "file") return err("That file was removed");
    if (a.local?.state !== "present") runDownload(roomId, a);
    return null;
  },
  artifactsResolveRepo: async (roomId: string, id: string) => {
    const a = artifactOf(roomId, id);
    if (!a || a.kind !== "repo") return err("That repo file was removed");
    const s1 = byId("s1")!;
    return later(
      {
        origin: a.origin!,
        path: a.path!,
        commit: a.commit!,
        lines: a.lines ?? null,
        clone: REPO,
        open: { sessionId: s1.id, root: s1.cwd, path: a.path!, line: a.lines?.[0] ?? null },
        commitPresent: true,
        changedSince: files[a.path!] !== headFiles[a.path!],
        atCommit: a.path! in headFiles ? { text: headFiles[a.path!], truncated: false } : null,
        problem: a.path! in headFiles ? null : `${a.path} isn't in a1b2c3d in your clone`,
      },
      300
    );
  },
  artifactsQuickLook: async (_roomId: string, id: string) => console.info(`[preview] would open ${id} in Quick Look`) ?? null,
  artifactsReveal: async (_roomId: string, id: string) => console.info(`[preview] would reveal ${id} in Finder`) ?? null,
  artifactsSaveAs: async (roomId: string, id: string) => ({ path: `/Users/you/Downloads/${artifactOf(roomId, id)?.name ?? id}` }),
  artifactsDismissNotice: async (roomId: string, noticeId: string) => {
    const room = artifactRoom(roomId);
    if (room) room.notices = room.notices.filter((n) => n.id !== noticeId);
    artifactsChanged(roomId);
    return null;
  },

  // team rooms: take-over — plans and the take-over are simulated; nothing is copied or launched
  teamTakeover: async () => JSON.parse(JSON.stringify(takeoverView)),
  teamSetBackupsToOrigin: async (roomId: string, on: boolean) => {
    const r = takeoverView.rooms.find((x) => x.roomId === roomId);
    if (!r) return err("You're not in that room");
    if (!r.canChange) return err(`Only the room's admin (${r.adminName}) can change where its backups go`);
    r.toOrigin = on;
    r.changed = { byName: "You", self: true, at: Date.now() };
    for (const s of takeoverView.sessions) if (s.roomId === roomId) s.toOrigin = on;
    takeoverChanged();
    return later(null, 400);
  },
  teamTakeoverPlan: async (_roomId: string, sessionId: string) => (takeoverPlans[sessionId] ? later(takeoverPlans[sessionId], 500) : err("No backup of that session has reached this Mac yet")),
  teamTakeOver: async (_roomId: string, sessionId: string) => {
    const s = takeoverView.sessions.find((x) => x.sessionId === sessionId);
    const plan = takeoverPlans[sessionId];
    if (!s || !plan?.snapshot) return err("No backup of that session has reached this Mac yet");
    s.takenOver = { by: ME, at: Date.now(), newSessionId: `t-${sessionId}`, snapshot: plan.snapshot, conversation: plan.conversation.kind === "full" ? "full" : "digest" };
    s.takenOverByName = "You";
    setTimeout(takeoverChanged, 50);
    return later({ sessionId: `t-${sessionId}`, cwd: `/Users/you/Code/worktrees/backoffice/${plan.branch}`, branch: plan.branch, renamedFrom: null, snapshot: plan.snapshot, conversation: s.takenOver.conversation }, 900);
  },
  teamTakeoverAnswer: async (askId: string, answer: string) => {
    const a = takeoverView.asks.find((x) => x.askId === askId);
    if (!a) return err("That request was withdrawn, answered, or timed out");
    if (answer === "keep") takeoverView.asks = takeoverView.asks.filter((x) => x !== a);
    else a.state = "handing-over";
    takeoverChanged();
    if (answer === "handover") {
      setTimeout(() => {
        takeoverView.asks = takeoverView.asks.filter((x) => x !== a);
        takeoverChanged();
      }, 2500);
    }
    return null;
  },
  teamTakeoverCheckLeft: async () => null,
  teamTakeoverSendLeft: async (_roomId: string, sessionId: string) => {
    const l = takeoverView.left.find((x) => x.sessionId === sessionId);
    if (!l || !l.unsent || "error" in l.unsent) return err("That session wasn't continued by a teammate");
    const files = l.unsent.files.length;
    l.sending = true;
    takeoverChanged();
    await later(null, 900);
    l.sending = false;
    l.sent = { at: Date.now(), files };
    l.unsent = { files: [], checkedAt: Date.now() };
    takeoverChanged();
    return { files };
  },
  teamTakeoverReceivedPatch: async (_roomId: string, id: string) =>
    takeoverView.received.some((r) => r.id === id) ? later({ patch: receivedPatch, truncated: false, file: `/Users/you/.mockingbird/team/rooms/R5101/received/${id}.patch` }, 300) : err("Those changes aren't here any more"),
  teamTakeoverApplyReceived: async (_roomId: string, id: string) => {
    const r = takeoverView.received.find((x) => x.id === id);
    if (!r) return err("Those changes aren't here any more");
    r.applied = Date.now();
    takeoverChanged();
    return later({ files: r.files.length }, 600);
  },
  teamTakeoverDismissReceived: async (_roomId: string, id: string) => {
    takeoverView.received = takeoverView.received.filter((x) => x.id !== id);
    takeoverChanged();
    return null;
  },

  // team rooms: live panes — Nick's session is a fixture; typing into it echoes like the others
  teamLive: async () => {
    const state: LivePanesState = JSON.parse(JSON.stringify(live));
    for (const tag of Object.values(state.own)) tag.inlineOnStart = settings.roomSessionsInline !== false; // as main answers
    return state;
  },
  teamLiveView: () => undefined,
  teamPaneResync: async (id: string) => emit("onSessionData", id, `\x1bc${buffers[id] ?? ""}`),
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
// team rooms: team chat — ?chat=<room id> picks the room the Team room view shows (when the grid's group isn't shared)
if (params.get("chat")) set("mb.roomChat.room", params.get("chat"));
// screenshots show the settled screen: no transition caught halfway (a theme switch fades colors)
if (params.has("shot")) {
  const still = document.createElement("style");
  still.textContent = "*, *::before, *::after { transition: none !important; animation: none !important; }";
  document.head.appendChild(still);
}
// team rooms: the House board — ?house=1 opens the first shared group's board (2: the second); ?houseTicket=141 opens
// that ticket on it, ?houseClaim=142 starts claiming it, ?houseAdd (=new) opens + Add ticket; ?houseWarning adds a claim warning
if (["house", "houseTicket", "houseClaim", "houseAdd", "houseWarning"].some((k) => params.has(k))) {
  let tries = 0;
  const open = setInterval(() => {
    const n = Number(params.get("house")) || 1;
    const button = document.querySelectorAll('button[title^="House board"]')[n - 1] as HTMLElement | undefined;
    if (!button && ++tries < 50) return;
    clearInterval(open);
    if (!params.has("houseWarning") || params.has("house")) button?.click();
    const ticket = params.get("houseTicket") ?? params.get("houseClaim");
    let boardTries = 0;
    const board = setInterval(() => {
      const r = ticket ? ([...document.querySelectorAll(".house-row-main")].find((x) => x.querySelector(".house-n")?.textContent === `#${ticket}`) as HTMLElement | undefined) : (document.querySelector(".house-modal") as HTMLElement | null) ?? undefined;
      if (!r && ++boardTries < 50) return;
      clearInterval(board);
      if (params.has("houseTicket")) r?.click();
      if (params.has("houseClaim")) (r?.querySelector(".house-claim-btn") as HTMLElement | null)?.click();
      if (params.has("houseAdd")) {
        ([...document.querySelectorAll(".house-head button")].find((x) => x.textContent === "+ Add ticket") as HTMLElement | undefined)?.click();
        if (params.get("houseAdd") === "new") setTimeout(() => ([...document.querySelectorAll(".house-tabs button")].find((x) => x.textContent === "New ticket") as HTMLElement | undefined)?.click(), 50);
      }
    }, 100);
    if (params.has("houseWarning")) {
      const hit = { roomId: "R5101aaaaaaaaaaaaaaaaa", room: "#5101 Org dropdowns remember the last org", n: 141, title: "Last-org API: GET/PUT /api/users/me/last-org", status: "in_progress", owner: { id: NICK, name: "Nick Smith" }, branch: "5101-lastOrgApi" };
      emit("onHouseWarning", { at: Date.now(), sessionId: "s1", sessionTitle: "Org dropdowns remember the last org", decision: "deny", tool: "Edit", conflicts: [{ file: "src/api/orgs/last.py", root: WT("5101-orgDropdowns"), hits: [hit] }] });
    }
  }, 100);
}
// team rooms: leaving and removing — ?teamDialog=leave opens Settings → Team's first Leave room…, =remove its first
// Remove…; ?chatMenu opens the room chat's ⋯ menu (=leave: and picks Leave room…)
if (params.has("teamDialog") || params.has("chatMenu")) {
  let tries = 0;
  const open = setInterval(() => {
    const want = params.has("chatMenu") ? "button.rc-more" : params.get("teamDialog") === "remove" ? ".team-member button.link.danger" : ".team-room .set-row-ctl button:last-child";
    const button = document.querySelector(want) as HTMLElement | null;
    if (!button && ++tries < 50) return;
    clearInterval(open);
    button?.click();
    if (params.get("chatMenu") === "leave") setTimeout(() => (document.querySelector(".mb-menu [role=menuitem], .mb-menu button") as HTMLElement | null)?.click(), 200);
  }, 100);
}
// team rooms: ?norooms — this Mac is in no team room yet; ?nosignal — no signaling URL is set, so no new rooms
if (params.has("norooms")) team.rooms = [];
if (params.has("nosignal")) {
  team.signalingUrl = "";
  settings = { ...settings, signalingUrl: "" };
}
const click = (selector: string) => (document.querySelector(selector) as HTMLElement | null)?.click();
/** Type into an input as a person would, so React sees the change. */
const typeInto = (selector: string, text: string) => {
  const input = document.querySelector(selector) as HTMLInputElement | null;
  if (!input) return;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};
// ?new opens New session, as ⌘N does; ?new=connected switches it to the first team room;
// ?new=room opens it from the first shared group's + instead
if (params.get("new") === "room") setTimeout(() => click('button[title^="New connected session"]'), 500);
else if (params.has("new")) {
  setTimeout(() => emit("onUiCommand", "new-session"), 300);
  if (params.get("new") === "connected") setTimeout(() => click(".ns-where button:last-child"), 700);
  // ?new=newroom picks + New room under Connected and names it (?name=, default "5120 Donor search");
  // ?new=newroom-start also presses Start, for the invite code
  if (params.get("new")?.startsWith("newroom")) {
    setTimeout(() => click(".ns-where button:last-child"), 700);
    setTimeout(() => click("button.ns-newroom"), 900);
    setTimeout(() => typeInto(".ns-newroom input", params.get("name") ?? "5120 Donor search"), 1100);
    if (params.get("new") === "newroom-start") setTimeout(() => click(".ns-foot button.cta"), 1400);
  }
  // ?new=import switches it to Import; ?new=import-pick also picks the first conversation
  if (params.get("new")?.startsWith("import")) setTimeout(() => click(".ns-mode button:last-child"), 700);
  if (params.get("new") === "import-pick") setTimeout(() => click(".ns-list .item:not(.blocked)"), 1100);
  // ?new=import&find=<words> types a search into Import
  if (params.get("find")) setTimeout(() => typeInto(".ns-body input[type=text]", params.get("find")!), 1100);
}
// team rooms: ?joinRequest=later puts the admin's join prompt off (Later), leaving the request in Settings → Team
if (params.get("joinRequest") === "later") setTimeout(() => click('.join-ask button[title^="Answer later"]'), 600);
// ?joining (with ?section=team) pastes a code into Join a room… and presses Join: the joiner's side (see teamJoin)
if (params.has("joining")) {
  setTimeout(() => click(".set-actions button.outline.strong"), 500);
  setTimeout(() => {
    const area = document.querySelector(".team-dlg textarea.team-code") as HTMLTextAreaElement | null;
    if (!area) return;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(area, inviteCode("Rjoinedddddddddddddddd"));
    area.dispatchEvent(new Event("input", { bubbles: true }));
  }, 700);
  setTimeout(() => click(".team-dlg .row button.primary"), 900);
}
// team rooms: artifacts (with view=room) — ?artifact=<n|name> opens the viewer for the nth row, or the row of that name;
// ?artifactEdit edits the note opened (=stale: and Sam saves an edit of it meanwhile); ?artifactAdd opens + Add (=note,
// =link, =repo picks that); ?artifactDrop holds a file over the Team tab; ?composer=<text> types into the message box
// (%23spec: the # completion); ?artifactsClosed starts with the section collapsed
const waitFor = (selector: string, then: (el: HTMLElement) => void, tries = 60) => {
  const t = setInterval(() => {
    const el = document.querySelector(selector) as HTMLElement | null;
    if (!el && --tries > 0) return;
    clearInterval(t);
    if (el) then(el);
  }, 100);
};
const typeArea = (area: HTMLTextAreaElement, text: string) => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(area, text);
  area.dispatchEvent(new Event("input", { bubbles: true }));
  area.focus();
  area.setSelectionRange(text.length, text.length);
};
const buttonNamed = (scope: string, text: string) => [...document.querySelectorAll<HTMLButtonElement>(`${scope} button`)].find((b) => b.textContent?.trim().startsWith(text));
if (params.has("artifactsClosed")) set("mb.roomArtifacts.open", false);
const openArtifact = params.get("artifact");
if (openArtifact) {
  waitFor(".art-row", () => {
    const rows = [...document.querySelectorAll<HTMLElement>(".art-row")];
    const row = /^\d+$/.test(openArtifact) ? rows[Number(openArtifact) - 1] : rows.find((r) => r.querySelector(".art-name")?.textContent === openArtifact);
    row?.click();
    if (!params.has("artifactEdit")) return;
    setTimeout(() => {
      buttonNamed(".art-head-acts", "Edit")?.click();
      setTimeout(() => {
        const area = document.querySelector(".art-note-text") as HTMLTextAreaElement | null;
        if (area) typeArea(area, `${area.value}- [ ] Debounce the save (500 ms)\n`);
        if (params.get("artifactEdit") !== "stale") return;
        const spec = artifactOf("R5101aaaaaaaaaaaaaaaaa", ART.spec)!;
        artTexts[ART.spec] = artTexts[ART.spec].replace("fall back to the first", "fall back to the user's home org");
        Object.assign(spec, { rev: "r-spec-3", updatedByName: "Sam", updatedAt: Date.now() });
        artifactsChanged("R5101aaaaaaaaaaaaaaaaa");
      }, 400);
    }, 500);
  });
}
const addWhat = params.get("artifactAdd");
// headless Chrome resizes the page as it takes the screenshot, and a resize closes an open menu
if (params.has("shot") && ((params.has("artifactAdd") && !addWhat) || (params.has("chatMenu") && !params.get("chatMenu")))) {
  window.addEventListener("resize", (e) => e.stopImmediatePropagation(), true);
}
if (params.has("artifactAdd")) {
  // after the chat has loaded and scrolled to its end: a scroll closes an open menu
  waitFor('button[title^="Share a file"]', (b) =>
    setTimeout(() => {
      b.click();
      const item = { note: "Note", link: "Link", repo: "Repo file" }[addWhat ?? ""];
      if (!item) return;
      setTimeout(() => {
        buttonNamed(".mb-menu", item)?.click();
        if (addWhat === "link") setTimeout(() => typeInto(".art-link-dlg input[type=text]", "https://github.com/acme/backoffice/pull/45"), 200);
      }, 200);
    }, 800)
  );
}
if (params.has("artifactDrop")) {
  waitFor(".rc", (el) => {
    const dt = new DataTransfer();
    dt.items.add(new File(["preview"], "org-picker-v2.png", { type: "image/png" }));
    el.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
}
const composerText = params.get("composer");
if (composerText) waitFor(".rc-bar textarea", (el) => setTimeout(() => typeArea(el as HTMLTextAreaElement, composerText), 300));
if (params.has("reset")) {
  params.delete("reset");
  history.replaceState(null, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
}
