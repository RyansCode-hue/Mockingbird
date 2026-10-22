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
import type { AdoBoard, AdoWorkItem, CollabParticipant, CollabRoom, ContextWindow, GraphCommit, Meters, SessionInfo, Settings, TicketPipeline, TicketStage, UsageReport } from "../shared/types";
import { DEFAULT_SETTINGS, splitGroupKey } from "../shared/types";
import { CHANGELOG } from "../shared/changelog";
import { fitSize } from "../renderer/cachedTerm";
import type { SuggestProblem } from "../shared/suggestions";
import { changedTags, parseCardRules, type TagChange } from "../shared/cardRules";
import type { MigrationsView } from "../shared/team/migrations";
import type { TeamStatus } from "../shared/team/types";
// the version being built, and an update one patch above it
import { version } from "../../package.json";
const nextVersion = version.replace(/\d+$/, (n) => String(Number(n) + 1));
// team rooms: the House board
import { HOUSE_TOKEN_HOW, isOpenStatus, openBacklog, type HouseHistoryEntry, type HouseOwner, type HouseRow, type HouseTicket, type HouseTicketDetail, type HouseTicketView, type HouseView, type HouseWrite } from "../shared/team/house";
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
  session("s2", { title: "API: last org per user", ticketId: "5101", ticketTitle: "API: last org per user", taskGroup: "5101/api", branch: "5101-orgDropdowns", cwd: WT("5101-orgDropdowns"), status: "waiting", waitingReason: new URLSearchParams(location.search).has("houseApproval") ? "Claude needs your permission to use mockingbird - claim_house_ticket (MCP)" : "Claude needs your permission to use Bash", waitingSince: now - 4 * min }),
  session("s3", { title: "API tests", taskGroup: "5101/api", branch: "5101-orgDropdowns", cwd: WT("5101-orgDropdowns"), agent: "codex", agentVersion: "0.131.0", status: "idle" }),
  session("s4", { title: "test runner", taskGroup: "5101", shell: true, agent: undefined, status: "idle" }),
  session("s8", { title: "Release notes for #5101", taskGroup: "5101", branch: "5101-orgDropdowns", cwd: WT("5101-orgDropdowns"), status: "idle" }),
  session("s5", { title: "#5102 — Pathways quick view freezes", ticketId: "5102", ticketTitle: "Pathways quick view freezes", taskGroup: "5102", branch: "5102-quickViewFreeze", cwd: WT("5102-quickViewFreeze"), status: "idle" }),
  session("s6", { title: "Crashed session", taskGroup: "5102", status: "dead", exitCode: 1 }),
  session("s7", { title: "assistant", repoPath: null, cwd: "/Users/you", kind: "assistant", taskGroup: null, status: "idle" }),
  // continued on Nick's laptop: its agent stopped here (team rooms: take-over)
  session("y1", { title: "Donor entity model", taskGroup: "5110", branch: "5110-donor-entities", cwd: WT("5110-donor-entities"), status: "dead" }),
];
// ?stall=hooks: s1 shows the stall banner of a pane whose hooks never reported ("working" may be wrong, Mark idle);
// ?stall=quiet: of one that's gone quiet while working
const stallQ = new URLSearchParams(location.search).get("stall");
if (stallQ) sessions = sessions.map((s) => (s.id === "s1" ? { ...s, status: "working", stalledSince: now - 6 * min, hooksSilent: stallQ === "hooks" } : s));
const previous: SessionInfo[] = [session("p1",{ title: "Yesterday's spike", status: "dead", taskGroup: null })];

const C = { dim: "\x1b[2m", reset: "\x1b[0m", bold: "\x1b[1m", amber: "\x1b[38;5;214m", teal: "\x1b[38;5;43m", red: "\x1b[31m", green: "\x1b[32m" };
const buffers: Record<string, string> = {
  s1: `${C.bold}> Make the org dropdown remember the last org each user picked${C.reset}\r\n\r\n${C.teal}⏺${C.reset} I'll store the choice per user and preselect it.\r\n\r\n${C.teal}⏺${C.reset} Update(src/org/Dropdown.tsx)\r\n  ⎿  Updated with 12 additions and 3 removals\r\n\r\n${C.amber}✻${C.reset} Writing the API change… ${C.dim}(42s · esc to interrupt)${C.reset}\r\n`,
  s2: `${C.bold}> Add GET/PUT /api/users/me/last-org${C.reset}\r\n\r\n${C.teal}⏺${C.reset} Bash(pytest tests/api/test_orgs.py)\r\n\r\n  Do you want to proceed?\r\n  ${C.bold}❯ 1. Yes${C.reset}\r\n    2. No, and tell Claude what to do differently\r\n`,
  // ?houseApproval: the agent asks before a House write (Claude Code's own prompt, as this fixture draws it)
  ...(new URLSearchParams(location.search).has("houseApproval")
    ? {
        s2: `${C.bold}> Pick up the next needs-agent ticket on the board${C.reset}\r\n\r\n${C.teal}⏺${C.reset} #146 "Donor export skips archived donors" is unclaimed and tagged needs-agent; claiming it first.\r\n\r\n${C.teal}⏺${C.reset} mockingbird - claim_house_ticket (MCP)(n: 146, branch: "feature/146-donor-export-skips-archived")\r\n\r\n  Do you want to proceed?\r\n  ${C.bold}❯ 1. Yes${C.reset}\r\n    2. No, and tell Claude what to do differently ${C.dim}(esc)${C.reset}\r\n`,
      }
    : {}),
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

const P1 = "Microsoft.VSTS.Common.Priority";
const tickets: AdoWorkItem[] = [
  { id: 5101, title: "Org dropdowns remember the last org", state: "Active", type: "User Story", assignedTo: "You", changed: new Date(now - 2 * 60 * min).toISOString(), description: "Users pick the same org every time. Remember it.", url: "https://dev.azure.com/acme/Backoffice/_workitems/edit/5101", boardColumn: "In Progress", tags: ["frontend", "org-picker"], fields: { [P1]: "2" } },
  { id: 5102, title: "Pathways quick view freezes with many tags", state: "Active", type: "Bug", assignedTo: "You", changed: new Date(now - 26 * 60 * min).toISOString(), description: "Typing in the tag filter freezes the page.", url: "https://dev.azure.com/acme/Backoffice/_workitems/edit/5102", boardColumn: "In Progress", tags: ["Blocked", "perf", "pathways", "customer-reported", "regression"], fields: { [P1]: "2" } },
  { id: 5115, title: "Donor sync waits on the CRM's API keys", state: "Active", type: "User Story", assignedTo: "You", changed: new Date(now - 2 * 24 * 60 * min).toISOString(), description: "The CRM team hasn't issued production keys yet.", url: "https://dev.azure.com/acme/Backoffice/_workitems/edit/5115", boardColumn: "In Progress", tags: ["blocked-by-crm", "integration"], fields: { [P1]: "2" } },
  { id: 5110, title: "Export donors to CSV", state: "New", type: "User Story", assignedTo: "You", changed: new Date(now - 3 * 24 * 60 * min).toISOString(), description: "", url: "https://dev.azure.com/acme/Backoffice/_workitems/edit/5110", boardColumn: "New", tags: ["data-export"], fields: { [P1]: "1" } },
  { id: 5120, title: "Receipt PDFs cut off long names", state: "New", type: "Bug", assignedTo: "You", changed: new Date(now - 4 * 24 * 60 * min).toISOString(), description: "", url: "https://dev.azure.com/acme/Backoffice/_workitems/edit/5120", boardColumn: "New", tags: [], fields: { [P1]: "3", "Microsoft.VSTS.CMMI.Blocked": "Yes" } },
  { id: 5098, title: "Login redirect loops on Safari", state: "Resolved", type: "Bug", assignedTo: "Sam", changed: new Date(now - 5 * 24 * 60 * min).toISOString(), description: "", url: "https://dev.azure.com/acme/Backoffice/_workitems/edit/5098", boardColumn: "Testing", tags: [], fields: { [P1]: "2" } },
];
// the board's card styles, as Azure DevOps answers cardrulesettings: one rule Mockingbird can't check
const cardRuleSettings = {
  rules: {
    fill: [
      { name: "Blocked", isEnabled: "true", clauses: [{ fieldName: "System.Tags", index: 1, logicalOperator: "", operator: "Contains", value: "Blocked" }], settings: { "background-color": "#F4A3A3", "title-color": "#000000" } },
      { name: "Urgent", isEnabled: "true", clauses: [{ fieldName: P1, index: 1, logicalOperator: "", operator: "=", value: "1" }], settings: { "background-color": "#FBE74B" } },
      { name: "Stale", isEnabled: "true", clauses: [{ fieldName: "System.ChangedDate", index: 1, logicalOperator: "", operator: "<", value: "@Today - 30" }], settings: { "background-color": "#DDDDDD" } },
    ],
    tagStyle: [
      { name: "frontend", isEnabled: "true", settings: { "background-color": "#009CCC", color: "#FFFFFF" } },
      { name: "regression", isEnabled: "true", settings: { "background-color": "#CC293D", color: "#FFFFFF" } },
      { name: "integration", isEnabled: "true", settings: { "background-color": "#773B93", color: "#FFFFFF" } },
    ],
  },
};
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
  cardRules: parseCardRules(cardRuleSettings),
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
// each session's context window; ?contextWindow=error answers every read with a failure
const contexts: Record<string, ContextWindow> = {
  s1: { state: "reading", agent: "claude", tokens: 275_612, window: 1_000_000, at: now - 4_000 },
  s2: { state: "reading", agent: "claude", tokens: 183_400, window: 200_000, at: now - 40_000 },
  s3: { state: "reading", agent: "codex", tokens: 64_210, window: 272_000, at: now - 3 * min },
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
      // ?roomWarnings: what this Mac refused from Nick over a limit, and this install's key connected from another place
      ...(teamQuery.has("roomWarnings")
        ? {
            warnings: [
              { key: `rate:${NICK}`, text: "Nick Smith's Mockingbird sent more than 600 room events a minute; the rest are refused for now and asked for again shortly", since: now - 9 * min, at: now - 2 * min, count: 3 },
              { key: "replaced", text: "Your room identity connected from another place; this Mac was disconnected. If that wasn't you on another Mac, someone may hold a copy of this Mac's room identity: tell the room's admin.", since: now - min, at: now - min, count: 1 },
            ],
          }
        : {}),
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
// team rooms: the House board — 5101 works in atticus-backoffice: its backlog in the House's order (high priority
// first), a ticket in every status, both handoff tags, a blocked and a waiting one, and five the room added (two of
// them closed, so outside the open backlog); 5110 has no project yet. ?houseMissing: no token here for 5101's project.
// ?houseConsent: Nick (5101's admin) connected it, and you haven't allowed your token for it yet (=declined: you chose
// Not now); the window asks too. ?houseProblems: the board's problem lines (schema drift, an agent's failed write,
// a teammate's branch that couldn't be fetched or read, a worktree whose claims weren't updated)
const houseClaim = (by: string, branch: string): HouseTicket["claim"] => ({ by, branch, at: null });
const houseTicket = (n: number, title: string, status: string, priority: string, claim: HouseTicket["claim"] = null, over: Partial<HouseTicket> = {}): HouseTicket => ({ n, title, status, priority, kind: "engineering", tags: [], claim, blockedBy: [], waiting: null, ...over });
const houseTickets: Record<number, HouseTicket> = {
  141: houseTicket(141, "Last-org API: GET/PUT /api/users/me/last-org", "in_progress", "high", houseClaim("Nick Smith", "5101-lastOrgApi")),
  146: houseTicket(146, "Donor export skips archived donors", "ready", "high", null, { tags: ["needs-agent"] }),
  143: houseTicket(143, "Org dropdown remembers the last org", "review", "high", houseClaim("You", "5101-orgDropdowns")),
  152: houseTicket(152, "Gift aid CSV totals per tax year", "validating", "high", houseClaim("Nick Smith", "feature/152-gift-aid-totals")),
  142: houseTicket(142, "Backfill each user's last org from the audit log", "ready", "medium", null, { blockedBy: [141] }),
  144: houseTicket(144, "Release notes and help article", "in_progress", "medium", houseClaim("Sam", "5101-releaseNotes"), { tags: ["needs-human"] }),
  147: houseTicket(147, "How long audit rows are kept", "parked", "medium", null, { kind: "decision", waiting: { on: "the client" } }),
  148: houseTicket(148, "Org switcher lists archived orgs", "ready", "medium", null, { tags: ["needs-agent", "orgs"] }),
  151: houseTicket(151, "Dropdown keyboard navigation", "in_progress", "medium", houseClaim("You", "5101-orgDropdowns")),
  139: houseTicket(139, "Org list endpoint paginates", "done", "medium"),
  149: houseTicket(149, "Tidy the org switcher's empty state", "ready", "low"),
  150: houseTicket(150, "Org switcher flickers on slow connections", "parked", "low"),
  138: houseTicket(138, "Org picker in the top bar", "dropped", "low", null, { kind: "idea" }),
  145: houseTicket(145, "Spike: per-tenant defaults", "parked", "investigate", null, { kind: "investigation" }),
};
/** GET work-items' order: priority-sorted, high to low, closed tickets included. */
const houseOrder = [141, 146, 143, 152, 142, 144, 147, 148, 151, 139, 149, 150, 138, 145];
const houseOpen = () => openBacklog(houseOrder, (n) => houseTickets[n]);
// team rooms: artifacts — their ids (the fixtures are further down)
const artId = (s: string) => s.padEnd(22, "0");
const ART = {
  spec: artId("Aspec"), copy: artId("Aspeccopy"), shot: artId("Ashot"), csv: artId("Acsv"), pdf: artId("Apdf"), repo: artId("Arepo"), link: artId("Alink"),
  env: artId("Aenv"), har: artId("Ahar"), mov: artId("Amov"), key: artId("Akey"), dump: artId("Adump"), log: artId("Alog"), gone: artId("Agone"),
};
// history as the House records it: { at, actor, event, note?, to_status? } — a status change has a to_status and no note
const houseEvent = (kind: string, by: string, minsAgo: number, over: Partial<HouseHistoryEntry> = {}): HouseHistoryEntry => ({ kind, text: "", by, at: new Date(now - minsAgo * min).toISOString(), status: null, reference: null, ...over });
const houseHistory: Record<number, HouseHistoryEntry[]> = {
  141: [
    houseEvent("created", "Ryan", 26 * 60, { status: "parked" }),
    houseEvent("status_changed", "Ryan", 25 * 60, { status: "ready" }),
    houseEvent("claimed", "Nick Smith", 4 * 60, { status: "in_progress" }),
    houseEvent("progress", "Nick Smith", 40, { text: "GET works; PUT validates the org belongs to the user. Tests in tests/api/test_orgs.py.", reference: "https://github.com/acme/backoffice/pull/412" }),
  ],
  143: [
    houseEvent("created", "Ryan", 30 * 60, { status: "parked" }),
    houseEvent("claimed", "You", 5 * 60, { status: "in_progress" }),
    houseEvent("progress", "You", 50, { text: "The dropdown reads the last org on load and writes it on change; covered by the org picker tests.", reference: "https://github.com/acme/backoffice/pull/415" }),
    houseEvent("status_changed", "You", 48, { status: "review" }),
  ],
  144: [houseEvent("claimed", "Sam", 3 * 60, { status: "in_progress" }), houseEvent("question", "Sam", 70, { text: "Should the help article mention the per-tenant default, or wait for the spike?" })],
  146: [
    houseEvent("created", "Nick Smith", 2 * 24 * 60, { status: "parked" }),
    houseEvent("question", "Ryan", 6 * 60, { text: "Should archived donors be left out of the yearly totals too, or only the rows?" }),
    houseEvent("answered", "Priya (staff)", 90, { text: "Out of both: archived donors don't appear anywhere in the export." }),
    houseEvent("status_changed", "Priya (staff)", 89, { status: "ready" }),
  ],
};
const houseDetail = (n: number): HouseTicketDetail => ({
  ...houseTickets[n],
  url: null,
  detail:
    n === 141
      ? "Store the last org a user picked per user, server side, so every device opens on it.\n\nThe dropdown (#143) reads it on load and writes it on change."
      : n === 146
        ? "The donor export includes archived donors' rows and counts them in the totals."
        : "",
  acceptance: n === 141 ? "GET returns the org last PUT by that user; PUT with an org the user can't see is a 403." : n === 146 ? "An export test with an archived donor: no row, not in the totals." : "",
  history: houseHistory[n] ?? [],
});
const houseOwner = (t: HouseTicket): HouseOwner | null => (t.claim && isOpenStatus(t.status) ? { name: t.claim.by === "You" ? "You" : t.claim.by ?? "Someone", member: t.claim.by === "You" ? ME : t.claim.by === "Sam" ? SAM : NICK, self: t.claim.by === "You" } : null);
const houseRow = (n: number, addedBy?: string): HouseRow => ({ n, ticket: houseTickets[n] ?? null, owner: houseTickets[n] ? houseOwner(houseTickets[n]) : null, ...(addedBy ? { addedBy } : {}) });
/** Rooms' migration reservations (teamChanges.ts view): Nick's 0025 and yours 0026 in the 5101 room. */
const migrationViews: Record<string, MigrationsView> = {
  R5101aaaaaaaaaaaaaaaaa: {
    roomId: "R5101aaaaaaaaaaaaaaaaa",
    check: true,
    canChange: true,
    adminName: "You",
    repos: [{ key: "github:acme/backoffice", label: "acme/backoffice", detected: ["db/migrations"], override: null }],
    reservations: [
      { id: "res0025aaaaaaaaaaaaaaa", label: "0025", folder: "db/migrations", repo: "acme/backoffice", member: "Nick Smith", self: false, session: "Export API", ticket: "#447", branch: "feature/447-export", at: Date.now() - 3_600_000, clash: false },
      { id: "res0026aaaaaaaaaaaaaaa", label: "0026", folder: "db/migrations", repo: "acme/backoffice", member: "You", self: true, session: "Donor entities", ticket: "#453", branch: "feature/453-donors", at: Date.now() - 600_000, clash: false },
    ],
    problems: [],
  },
  R5110bbbbbbbbbbbbbbbbb: { roomId: "R5110bbbbbbbbbbbbbbbbb", check: true, canChange: false, adminName: "Nick Smith", repos: [], reservations: [], problems: [] },
};
const houseConsentQuery = teamQuery.get("houseConsent");
const houseRooms: Record<string, { project: string | null; added: { n: number; by: string }[]; isAdmin: boolean; admin: string; consent?: "pending" | "declined" }> = {
  R5101aaaaaaaaaaaaaaaaa: {
    project: "atticus-backoffice",
    added: [
      { n: 139, by: "You" },
      { n: 142, by: "Nick Smith" },
      { n: 150, by: "Nick Smith" },
      { n: 151, by: "You" },
      { n: 138, by: "Nick Smith" },
    ],
    isAdmin: houseConsentQuery === null,
    admin: houseConsentQuery === null ? "You" : "Nick Smith",
    ...(houseConsentQuery !== null ? { consent: houseConsentQuery === "declined" ? ("declined" as const) : ("pending" as const) } : {}),
  },
  R5110bbbbbbbbbbbbbbbbb: { project: null, added: [], isAdmin: true, admin: "You" },
};
const houseView = (roomId: string): HouseView => {
  const r = houseRooms[roomId];
  const consent = !!r.project && !!r.consent;
  const missing = (teamQuery.has("houseMissing") && !!r.project) || consent;
  return {
    roomId,
    room: team.rooms.find((x) => x.id === roomId)?.name ?? roomId,
    project: r.project,
    admin: r.admin,
    isAdmin: r.isAdmin,
    envFile: r.project ? `~/.config/radley-house/${r.project}.env` : null,
    connection: !r.project
      ? { state: "unset" }
      : consent
        ? { state: "consent", declined: r.consent === "declined" }
        : missing
        ? { state: "missing", file: `~/.config/radley-house/${r.project}.env`, message: `There's no ~/.config/radley-house/${r.project}.env on this Mac. ${HOUSE_TOKEN_HOW} Save it there (mode 600) as HOUSE_API_URL, HOUSE_PROJECT_ID and HOUSE_BUILD_TOKEN.` }
        : { state: "ok" },
    open: r.project && !missing ? houseOpen().map((n) => houseRow(n, r.added.find((a) => a.n === n)?.by)) : null,
    added: missing ? [] : r.added.filter((a) => !houseOpen().includes(a.n)).map((a) => houseRow(a.n, a.by)),
    fetchedAt: r.project && !missing ? now - 40_000 : 0,
    refreshing: false,
    branches: roomId === "R5101aaaaaaaaaaaaaaaaa" ? ["5101-orgDropdowns"] : [],
    ...(teamQuery.has("houseProblems") && r.project && !missing
      ? {
          drift: "The House's answer doesn't have the fields Mockingbird reads: its work items no longer have assignee (or another claim field), so every ticket shows as unclaimed and claims aren't enforced. Its API may have changed — tell whoever looks after Mockingbird.",
          writeProblems: [{ at: now - 3 * min, text: "Org dropdowns remember the last org couldn't claim #152: The House answered 409: #152 is already claimed by Nick Smith" }],
          branchProblems: [
            `Teammates' branches couldn't be fetched into ${REPO}, so their claimed files may be out of date: fatal: unable to access 'https://github.com/acme/backoffice.git/': Could not resolve host: github.com`,
            "Nick Smith's branch 5101-lastOrgApi wasn't read, so its files aren't claimed here: 5101-lastOrgApi isn't on origin (not pushed yet)",
          ],
          copiesProblem: `${WT("5101-orgDropdowns")}'s branch couldn't be read, so the room's claims there weren't updated: fatal: not a git repository`,
        }
      : {}),
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
  [ART.log]: [
    "2026-10-12T14:58:02Z INFO  GET /api/users/me/last-org 200 12ms",
    "2026-10-12T14:58:40Z ERROR PUT /api/users/me/last-org 500 41ms org_id=42",
    "  KeyError: 'org_id' in handlers/orgs.py:88 (save_last_org)",
    "2026-10-12T14:59:13Z WARN  GET /api/orgs 200 1.9s slow query: orgs_for_user",
    "2026-10-12T14:59:55Z ERROR PUT /api/users/me/last-org 500 38ms org_id=7",
    "  KeyError: 'org_id' in handlers/orgs.py:88 (save_last_org)",
    "",
  ].join("\n"),
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
  n1: { roomId: "R5101aaaaaaaaaaaaaaaaa", sessionId: "n1", title: "Donor export: CSV writer", agent: "claude", branch: "5101-csvExport", ownerName: "Nick Smith", ownerOnline: true, originUrl: "https://dev.azure.com/acme/Backoffice/_git/backoffice", clone: REPO, snapshot: { sha: "a1".repeat(20), takenAt: now - 2 * min, source: p2p ? "peer" : "origin", skipped: [] }, other: null, toOrigin: !p2p, originProblem: null, latestMissing: false, conversation: { kind: "full", bytes: 412_000 }, resumesOwn: false },
  // ?p2p: only the copy that reached this Mac half an hour ago, a turn behind Sam's laptop
  m1: p2p
    ? { roomId: "R5101aaaaaaaaaaaaaaaaa", sessionId: "m1", title: "Last-org API tests", agent: "codex", branch: "5101-api-tests", ownerName: "Sam", ownerOnline: false, originUrl: "https://dev.azure.com/acme/Backoffice/_git/backoffice", clone: REPO, snapshot: { sha: "c3".repeat(20), takenAt: now - 31 * min, source: "peer", skipped: [] }, other: null, toOrigin: false, originProblem: null, latestMissing: true, conversation: { kind: "partial", have: 640_000, of: 980_000 }, resumesOwn: false }
    : { roomId: "R5101aaaaaaaaaaaaaaaaa", sessionId: "m1", title: "Last-org API tests", agent: "codex", branch: "5101-api-tests", ownerName: "Sam", ownerOnline: false, originUrl: "https://dev.azure.com/acme/Backoffice/_git/backoffice", clone: REPO, snapshot: { sha: "b2".repeat(20), takenAt: now - 4 * min, source: "peer", skipped: [] }, other: { sha: "c3".repeat(20), takenAt: now - 31 * min, source: "origin" }, toOrigin: true, originProblem: null, latestMissing: false, conversation: { kind: "partial", have: 640_000, of: 980_000 }, resumesOwn: false },
  // 5110 keeps backups peer to peer: what Nick's laptop sent while connected
  n7: { roomId: "R5110bbbbbbbbbbbbbbbbb", sessionId: "n7", title: "Donor entity model", agent: "claude", branch: "5110-donor-entities", ownerName: "Nick Smith", ownerOnline: true, originUrl: "git@github.com:acme/donors.git", clone: REPO, snapshot: { sha: "d5".repeat(20), takenAt: now - 3 * min, source: "peer", skipped: [] }, other: null, toOrigin: false, originProblem: null, latestMissing: false, conversation: { kind: "full", bytes: 412_000 }, resumesOwn: false },
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

// ---- Council: a discussion two rounds in --------------------------------------

const seat = (key: string, label: string, agent: "claude" | "codex", model: string, color: number, readsCode: boolean): CollabParticipant => ({
  key, label, agent, model, color, readsCode, effort: null, conversationId: `conv-${key}`, lastSeen: 6,
});
const councils: CollabRoom[] = [
  {
    id: "k1",
    title: "CSV export for the donor list",
    brief: "We need a way to export the donor list to CSV from the backoffice. It has to respect the user's filters and handle 200k rows.",
    repoPath: REPO,
    participants: [seat("gpt6", "GPT-6 Astra", "codex", "gpt-6-astra", 0, true), seat("opus", "Claude Opus 5.5", "claude", "opus", 1, true), seat("fable", "Claude Fable 5.1", "claude", "fable", 2, false)],
    messages: [
      { id: "m0", speaker: "you", round: 0, at: now - 3_600_000, text: "We need a way to export the donor list to CSV from the backoffice. It has to respect the user's filters and handle 200k rows." },
      { id: "m1", speaker: "gpt6", round: 1, at: now - 3_500_000, stance: "continue", text: "Stream it: the list query already takes the filter DTO, so page through it 5k rows at a time and write each page to the response." },
      { id: "m2", speaker: "opus", round: 1, at: now - 3_400_000, stance: "continue", text: "Agree on streaming. For the largest orgs a background job that drops the file in blob storage avoids request timeouts." },
      { id: "m3", speaker: "fable", round: 1, at: now - 3_300_000, stance: "continue", text: "Keep one path: always stream, and only add the job if real orgs time out." },
      { id: "m4", speaker: "gpt6", round: 2, at: now - 3_200_000, stance: "agree", text: "Stream for everyone, measure the biggest org, add the job only if it times out." },
      { id: "m5", speaker: "opus", round: 2, at: now - 3_100_000, stance: "agree", text: "That works. Plan: streaming endpoint behind the existing filter DTO, a timing check on the biggest org." },
    ],
    mode: "consensus",
    maxRounds: 5,
    round: 2,
    running: false,
    speaking: null,
    plan: null,
    implementedIn: null,
    workspacePath: null,
    pending: [],
    allowKinds: [],
    createdAt: now - 3_600_000,
  },
];

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
const suggestQ = new URLSearchParams(location.search).get("suggest");
const suggestProblem = (): SuggestProblem | null =>
  suggestQ === "gh-missing"
    ? { problem: "gh-missing", message: "The GitHub CLI (gh) isn't installed, so Mockingbird can't file or list suggestions.", fix: "brew install gh && gh auth login" }
    : suggestQ === "signed-out"
      ? { problem: "signed-out", message: "The GitHub CLI isn't signed in to GitHub, so Mockingbird can't file or list suggestions.", fix: "gh auth login" }
      : suggestQ === "no-access"
        ? { problem: "no-access", message: "Your GitHub account can't see RyansCode-hue/Mockingbird. Ask the repository's owner for access, or copy the suggestion and send it another way." }
        : null;
const err = (message: string) => ({ error: message });
/** A Settings check failing as ?checks= says: `error` rejects the call (as a missing handler does), `reply` answers { error }. */
const checksFail = (channel: string): { error: string } | undefined => {
  const how = new URLSearchParams(location.search).get("checks");
  if (how === "error") throw new Error(`Error invoking remote method '${channel}': Error: No handler registered for '${channel}'`);
  if (how === "reply") return err("the login shell timed out after 15s");
  return undefined;
};

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
  // main answers { path, content } (the path with ~ expanded), or { error }; ?claudeMd=error rejects the call outright
  readClaudeMd: async (p: string) => {
    if (params.get("claudeMd") === "error") throw new Error("Error invoking remote method 'claudemd:read': EACCES: permission denied");
    return { path: p.replace(/^~/, "/Users/you"), content: `# Working here\n\n- Run the tests before calling anything done.\n- Keep commits small; one change each.\n` };
  },
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
  // a relaunch starts a new process under the same id, stamped with a new createdAt, as main's create() does
  relaunchSession: async (id: string) => {
    const p = previous.find((x) => x.id === id) ?? byId(id);
    if (!p) return null;
    const next: SessionInfo = { ...p, status: "idle", exitCode: undefined, createdAt: Date.now() };
    sessions = [...sessions.filter((s) => s.id !== id), next];
    sessionsChanged();
    return next;
  },
  sessionRestart: async (id: string) => {
    const s = byId(id);
    if (!s) return err("Session is no longer running");
    return api.relaunchSession(id);
  },
  restartAllSessions: async () => ({ restarted: sessions.filter((s) => !s.shell).map((s) => s.id), skipped: [], failed: [] }),
  // main's rule: idle panes are given it, busy ones queue it, terminals and debriefs never get it
  broadcast: async (req: { message: string; sessionIds: string[] }) =>
    (req.sessionIds.length ? req.sessionIds : sessions.filter((s) => s.kind === "work" && !s.shell).map((s) => s.id)).map((id) => {
      const s = byId(id);
      const outcome = !s || s.status === "dead" || s.shell || s.debrief ? "skipped" : s.status === "idle" ? "delivered" : "queued";
      return { id, outcome };
    }),
  hooksInstalled: async () => true,
  appVersion: async () => version,
  getSettings: async () => settings,
  setSettings: async (patch: Partial<Settings>) => {
    settings = { ...settings, ...patch }; // main merges what it's sent
  },
  usageGet: async () => usage,
  contextWindow: async (id: string): Promise<ContextWindow | { error: string }> =>
    new URLSearchParams(location.search).get("contextWindow") === "error"
      ? { error: `EACCES: permission denied, open '/Users/you/.mockingbird/context/${id}.json'` }
      : (contexts[id] ?? { state: "none", why: "No reply yet in this conversation" }),
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
  collabList: async () => councils,
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
  // tags change in the fixture, as Azure DevOps would keep them; ?tagFail makes every tag write fail, to see the revert
  adoSetTags: async (id: number, change: TagChange) => {
    if (new URLSearchParams(location.search).has("tagFail")) return later(err(`Azure DevOps 403 Forbidden: TF401289: You don't have permission to edit work item ${id}.`), 300);
    const t = tickets.find((x) => x.id === id);
    if (!t) return err(`Azure DevOps 404 Not Found: work item ${id} doesn't exist`);
    t.tags = changedTags(t.tags, change);
    return later({ id, tags: t.tags }, 300);
  },
  adoProjectTags: async () => ["accessibility", "backend", "customer-reported", "data-export", "frontend", "integration", "org-picker", "pathways", "perf", "regression", "security", "tech-debt"],
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
      { id: "c-old-4", agent: "codex", cwd: "/Users/you/Code/backoffice", title: "CSV export for the donor list", text: "stream the export in pages so a 200k-row org never holds it all in memory", open: { how: "room", roomId: "k1", roomTitle: "CSV export for the donor list" } },
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
  updateCheck: async () => later({ latest: nextVersion, current: version, newer: true, url: "https://github.com/", source: "branch" }, 600),
  updateStatus: async () => ({ state: "idle", done: [], log: [] }),
  updateOutcome: async () => null,
  updateSource: async () => ({ configured: null, found: "/Users/you/Code/Mockingbird" }),
  // What's new → Suggest something: nothing reaches GitHub. ?suggest=gh-missing|signed-out|no-access picks a problem,
  // =create the first suggestion on a repo without its labels, =posted a filing that worked, =list-error a failed read
  suggestPrepare: async () => {
    const p = suggestProblem();
    if (p) return later(p, 300);
    return later({ repo: "RyansCode-hue/Mockingbird", login: "you", labels: suggestQ === "create" ? "create" : "existing" }, 300);
  },
  suggestPost: async () => {
    if (suggestQ === "posted") return later({ number: 58, url: "https://github.com/RyansCode-hue/Mockingbird/issues/58", labelled: true }, 400);
    return later<SuggestProblem>({ problem: "dev-build", message: "UI preview: nothing is posted to GitHub." }, 300);
  },
  suggestList: async () => {
    const p = suggestProblem();
    if (p) return later(p, 300);
    if (suggestQ === "list-error") return later(err("gh: HTTP 502: Server Error (https://api.github.com/graphql)"), 300);
    const issue = (number: number, title: string, status: string, author: string) => ({ number, title, status, author, mine: author === "you", url: `https://github.com/RyansCode-hue/Mockingbird/issues/${number}`, createdAt: new Date(now - number * 3_600_000).toISOString() });
    return later(
      {
        repo: "RyansCode-hue/Mockingbird",
        login: "you",
        at: now,
        items: [
          issue(57, "Show the branch's CI status in the pane rail", "roadmap", "you"),
          issue(51, "Pin a council to the side bar", "open", "you"),
          issue(55, "A room's chat should keep my draft when I switch rooms", "shipped", "nick"),
          issue(49, "Hide the status bar's usage", "declined", "nick"),
          issue(46, "Keyboard shortcut to jump to the waiting session", "open", "sam"),
        ],
      },
      400
    );
  },
  // Settings' checks; ?checks=error rejects them outright, ?checks=reply answers { error }
  connectorsStatus: async () => checksFail("connectors:status") ?? { az: true, global: ["github"], project: [] },
  setupStatus: async () => checksFail("setup:status") ?? {
    claude: { found: true, path: "/opt/homebrew/bin/claude", version: "2.1.290", signedIn: true },
    codex: { found: true, path: "/opt/homebrew/bin/codex", version: "0.156.1", signedIn: true },
    hooks: { claude: true, codex: true },
    // every repo folder in Settings, as the app counts them: ~/Code holds the fixture repos, the rest none
    repoRoots: settings.repoRoots.map((path) => ({ path, exists: true, repos: path === "~/Code" ? 12 : 0 })),
    workTrackerPath: "~/Code/WorkTracker",
    ado: { connected: true, display: "You", detail: "acme / Backoffice" },
  },
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
    return later({ detail: houseDetail(n), owner: houseOwner(houseTickets[n]), open: houseOpen().includes(n), tracked: !!r?.added.some((a) => a.n === n) }, 200);
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
        log(w.n, { kind: "claimed", text: "", status: "in_progress" });
        break;
      case "release":
        houseTickets[w.n] = { ...houseTickets[w.n], status: "ready", claim: null };
        log(w.n, { kind: "released", text: "", status: "ready" });
        break;
      case "event":
        if (w.event === "question") houseTickets[w.n] = { ...houseTickets[w.n], tags: [...houseTickets[w.n].tags.filter((t) => t !== "needs-agent" && t !== "needs-human"), "needs-human"] };
        log(w.n, { kind: w.event === "note" ? "comment" : w.event === "status" ? "progress" : w.event, text: w.text });
        if (w.status && w.status !== houseTickets[w.n].status) {
          houseTickets[w.n] = { ...houseTickets[w.n], status: w.status };
          log(w.n, { kind: "status_changed", text: "", status: w.status });
        }
        break;
      case "create": {
        const n = houseNext++;
        houseTickets[n] = houseTicket(n, w.title, "parked", "medium");
        // the House lists it with the other medium-priority tickets
        const place = houseOrder.findIndex((x) => houseTickets[x].priority === "low" || houseTickets[x].priority === "investigate");
        houseOrder.splice(place < 0 ? houseOrder.length : place, 0, n);
        r.added.push({ n, by: "You" });
        log(n, { kind: "created", text: "", status: "parked" });
        break;
      }
    }
    emit("onHouseChanged", houseView(roomId));
    return later({ message: "Saved to the House" }, 250);
  },
  houseOpen: async () => later(undefined, 50),
  houseConsent: async (roomId: string, allow: boolean) => {
    const r = houseRooms[roomId];
    if (!r?.project) return err(`Room ${roomId} isn't connected to a House project`);
    r.consent = allow ? undefined : "declined";
    emit("onHouseChanged", houseView(roomId));
    return later(houseView(roomId), 150);
  },
  housePendingConsents: async () =>
    Object.entries(houseRooms)
      .filter(([, r]) => r.project && r.consent === "pending")
      .map(([roomId, r]) => ({ roomId, room: team.rooms.find((x) => x.id === roomId)?.name ?? roomId, project: r.project!, admin: r.admin })),
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
  // team rooms: migration number reservations
  teamChangesView: async (roomId: string) => (migrationViews[roomId] ? JSON.parse(JSON.stringify(migrationViews[roomId])) : err(`Not a member of room ${roomId}`)),
  teamChangesSetCheck: async (roomId: string, on: boolean) => {
    const v = migrationViews[roomId];
    if (!v) return err(`Not a member of room ${roomId}`);
    if (!v.canChange) return err(`Only the room's admin (${v.adminName}) turns the migration check on or off`);
    v.check = on;
    emit("onTeamChangesChanged", JSON.parse(JSON.stringify(v)));
    return later(JSON.parse(JSON.stringify(v)), 300);
  },
  teamChangesSetFolders: async (roomId: string, key: string, folders: string[]) => {
    const r = migrationViews[roomId]?.repos.find((x) => x.key === key);
    if (!r) return err("No such repository in the room");
    r.override = folders.length ? folders : null;
    emit("onTeamChangesChanged", JSON.parse(JSON.stringify(migrationViews[roomId])));
    return later(JSON.parse(JSON.stringify(migrationViews[roomId])), 300);
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
// ?motion=off|reduce|full|os: how much moves (Settings → Motion; off is for tests). Screenshots and layout checks
// (?shot, ?measure) default to off, since a box read mid-animation includes its transform
const motionQ = params.get("motion") ?? (params.has("shot") || params.has("measure") ? "off" : null);
if (motionQ === "off") (window as unknown as { __mbMotion?: string }).__mbMotion = "off";
else if (motionQ === "reduce" || motionQ === "full" || motionQ === "os") set("mb.motion", motionQ);
if (shown) set("mb.shown", shown.split(","));
// team rooms: team chat — ?chat=<room id> picks the room the Team room view shows (when the grid's group isn't shared);
// ?chat=list shows the room list, each room with its sessions
if (params.get("chat")) set("mb.roomChat.room", params.get("chat") === "list" ? "" : params.get("chat"));
// the House board and New session in a room are opened from the Team view's rooms: it opens on the room list
// (and, for ?chatMenu, on the first room) unless ?view says otherwise
const houseKeys = ["house", "houseTicket", "houseClaim", "houseAdd", "houseWarning", "houseAgent", "houseProblems"];
if (!view && (houseKeys.some((k) => params.has(k)) || params.get("new") === "room")) {
  set("mb.sideView", "room");
  if (!params.get("chat")) set("mb.roomChat.room", "");
}
if (!view && params.has("chatMenu")) {
  set("mb.sideView", "room");
  if (!params.get("chat")) set("mb.roomChat.room", "R5101aaaaaaaaaaaaaaaaa");
}
// ?ctx=row|pane|tab|artifact opens that element's right-click menu: the first teammate's session row in the Team
// view (=row), the first pane's header, the first workspace tab, the first artifact (with view=room); ?ctxKeys
// presses ↓ twice in it, from the keyboard
// ?paneControls shows every pane header's controls as a hover does, and every session row's actions, for screenshots
if (params.has("paneControls")) {
  const show = document.createElement("style");
  show.textContent = ".pane .pane-header .controls, .sess-item .sr-acts, .sess-item .sr-acts > * { display: inline-flex !important; }";
  document.head.appendChild(show);
}
const ctxOn = params.get("ctx");
if (ctxOn) {
  if (!view) set("mb.sideView", "room");
  if (!view && !params.get("chat")) set("mb.roomChat.room", ctxOn === "row" ? "" : "R5101aaaaaaaaaaaaaaaaa");
  const target = { row: ".room-sess-body .sess-item.remote", pane: ".pane-header", tab: ".ws-tab", artifact: ".art-row" }[ctxOn] ?? ctxOn;
  let tries = 0;
  const t = setInterval(() => {
    const el = document.querySelector(target) as HTMLElement | null;
    if (!el && ++tries < 50) return;
    clearInterval(t);
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + Math.min(60, r.width / 2), clientY: r.top + r.height / 2 }));
    if (params.has("ctxKeys"))
      setTimeout(() => {
        for (let i = 0; i < 2; i++) document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      }, 150);
  }, 100);
}
// screenshots show the settled screen: no transition caught halfway (a theme switch fades colors)
if (params.has("shot")) {
  const still = document.createElement("style");
  still.textContent = "*, *::before, *::after { transition: none !important; animation: none !important; }";
  document.head.appendChild(still);
}
// team rooms: the House board — ?house=1 opens the first shared group's board (2: the second); ?houseTicket=141 opens
// that ticket on it, ?houseClaim=142 starts claiming it, ?houseAdd (=new) opens + Add ticket; ?houseWarning adds a claim
// warning; ?houseAgent turns on the open backlog's "Needs an agent" filter
if (houseKeys.some((k) => params.has(k))) {
  let tries = 0;
  const open = setInterval(() => {
    const n = Number(params.get("house")) || 1;
    const button = document.querySelectorAll('button[title^="House board"]')[n - 1] as HTMLElement | undefined;
    // the Team view opened on the grid's shared room: its All rooms has every room's Board
    if (!button) (document.querySelector("button.rc-back") as HTMLElement | null)?.click();
    if (!button && ++tries < 50) return;
    clearInterval(open);
    if (!params.has("houseWarning") || params.has("house")) button?.click();
    const ticket = params.get("houseTicket") ?? params.get("houseClaim");
    let boardTries = 0;
    const board = setInterval(() => {
      const r = ticket ? ([...document.querySelectorAll(".house-row-main")].find((x) => x.querySelector(".house-n")?.textContent === `#${ticket}`) as HTMLElement | undefined) : (document.querySelector(".house-modal") as HTMLElement | null) ?? undefined;
      if (!r && ++boardTries < 50) return;
      clearInterval(board);
      if (params.has("houseAgent")) (document.querySelector(".house-filter") as HTMLElement | null)?.click();
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
    const want = params.has("chatMenu") ? '.rc-head .room-head [data-action="more"]' : params.get("teamDialog") === "remove" ? ".team-member button.link.danger" : ".team-room .set-row-ctl button:last-child";
    const button = document.querySelector(want) as HTMLElement | null;
    if (!button && ++tries < 50) return;
    clearInterval(open);
    button?.click();
    if (params.get("chatMenu") === "leave") setTimeout(() => ([...document.querySelectorAll(".mb-menu [role=menuitem]")].find((b) => b.textContent === "Leave room…") as HTMLElement | undefined)?.click(), 200);
  }, 100);
}
// team rooms: ?norooms — this Mac is in no team room yet; ?nosignal — no signaling URL is set, so no new rooms
if (params.has("norooms")) team.rooms = [];
if (params.has("nosignal")) {
  team.signalingUrl = "";
  settings = { ...settings, signalingUrl: "" };
}
const click = (selector: string) => (document.querySelector(selector) as HTMLElement | null)?.click();
// ?usagePop opens the status bar's plan-usage popover; =N first focuses the Nth pane on screen
if (params.has("usagePop")) {
  setTimeout(() => {
    const n = Number(params.get("usagePop")) || 0;
    if (n) document.querySelectorAll(".pane")[n - 1]?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    setTimeout(() => click(".statusbar .usage"), 200);
  }, 600);
}
/** Type into an input as a person would, so React sees the change. */
const typeInto = (selector: string, text: string) => {
  const input = document.querySelector(selector) as HTMLInputElement | null;
  if (!input) return;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};
// the Dashboard's work items: ?workItem=5102 opens its dialog — then ?tagAdd=a11y adds that tag, ?tagRemove=perf
// removes one, ?tagDraft=per types into Add tag, ?block presses Mark blocked / Unblock; ?cardMenu=5102 opens that
// card's right-click menu (add ?tagFail to make the writes fail)
const workItemQ = params.get("workItem") ?? params.get("cardMenu");
if (workItemQ) {
  set("mb.tab", "dashboard");
  let tries = 0;
  const open = setInterval(() => {
    const card = [...document.querySelectorAll(".bcard")].find((c) => c.querySelector(".wi-id")?.textContent === workItemQ) as HTMLElement | undefined;
    if (!card && ++tries < 50) return;
    clearInterval(open);
    if (!card) return;
    if (params.has("cardMenu")) {
      const r = card.getBoundingClientRect();
      card.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 20 }));
      return;
    }
    card.click();
    setTimeout(() => {
      const draft = params.get("tagAdd") ?? params.get("tagDraft");
      if (draft) typeInto("#bd-tag-in", draft);
      if (params.has("tagAdd")) setTimeout(() => click(".bd-tag-add button"), 50);
      const rm = params.get("tagRemove");
      if (rm) (document.querySelector(`.bd-side .tag-x[aria-label="Remove tag ${rm}"]`) as HTMLElement | null)?.click();
      if (params.has("block")) click(".bd-side .bd-block-btn");
    }, 150);
  }, 100);
}
// ?council opens the Council tab on its fixture discussion, its list as a first visit shows it (unfolded while short);
// ?council=list unfolds the list, ?council=rail folds it; ?council=new opens the New council form
if (params.has("council")) {
  set("mb.tab", "collaborate");
  const list = params.get("council");
  if (list === "list" || list === "rail") set("mb.collab.list", list === "list");
  if (list === "new") setTimeout(() => click(".collab-rail-new, .collab-new"), 500);
}
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
// team rooms: artifacts (with view=room) — ?artifact=<n|name> opens the viewer for the nth row (newest first:
// 1 is api-errors.log; ?artifact=Last-org%20spec for the note), or the row of that name;
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
if (params.has("shot") && ((params.has("artifactAdd") && !addWhat) || (params.has("chatMenu") && !params.get("chatMenu")) || params.has("ctx"))) {
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
// ?motionAudit (with ?motion=full or reduce) plays the moments that animate — minimizing the "api" workspace into
// its folder and restoring it, a dialog, a toast — finishing every animation rather than waiting on real time, then
// writes what's left into <script id="mb-motion-audit"> for test/uiMotion.test.ts (real time: pageResult): the folder's state after each
// step, the panes in the grid, copies left behind, animations left holding a frame, View Transitions started, and
// the longest animation that ran
if (params.has("motionAudit")) {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const finite = () => document.getAnimations().filter((a) => Number.isFinite(a.effect?.getComputedTiming().activeDuration ?? Infinity));
  // the longest one-shot animation (the waiting pulse repeats, and is checked on its own)
  let longest = 0;
  const note = () => {
    for (const a of finite()) if (a.effect?.getComputedTiming().iterations === 1) longest = Math.max(longest, Number(a.effect.getComputedTiming().activeDuration));
  };
  const settle = async () => {
    for (let i = 0; i < 6; i++) {
      await sleep(40);
      note();
      for (const a of finite()) a.finish();
    }
    await sleep(40);
  };
  let transitions = 0;
  const start = (document as unknown as { startViewTransition?: (cb: () => void) => unknown }).startViewTransition;
  if (start)
    (document as unknown as { startViewTransition: (cb: () => void) => unknown }).startViewTransition = function (cb: () => void) {
      transitions++;
      return start.call(document, cb);
    };
  const folder = () => document.querySelector(".sub-label[data-ws] .ico.folder");
  const state = () => ({
    folderOpen: !!folder()?.classList.contains("open"),
    cells: [...document.querySelectorAll<HTMLElement>(".grid > [data-cell]")].map((c) => c.dataset.cell),
    ghosts: document.querySelectorAll(".mb-ghost").length,
    // finished but still applying their last frame: a stuck fill
    holding: document.getAnimations().filter((a) => a.playState === "finished").length,
    named: document.querySelectorAll("[style*='view-transition-name']").length,
  });
  const clickRow = (el: Element) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  waitFor(".sub-label[data-ws]", async () => {
    await sleep(300);
    const out: Record<string, unknown> = { before: state() };
    clickRow(document.querySelector(".sub-label[data-ws]")!);
    await sleep(320); // a folder click waits out a double-click
    note();
    // panes that keep their size show only their live image; resized ones cross-fade from their snapshot
    const images = () =>
      [...document.querySelectorAll<HTMLElement>(".grid > [data-cell]")].flatMap((el) => {
        const name = el.style.getPropertyValue("view-transition-name");
        if (!name || name === "mb-fly") return [];
        const pseudo = (side: string) => getComputedStyle(document.documentElement, `::view-transition-${side}(${name})`);
        return [{ cell: el.dataset.cell, same: el.style.getPropertyValue("view-transition-class").split(" ").includes("mb-same"), oldOpacity: pseudo("old").opacity, newAnimation: pseudo("new").animationName }];
      });
    out.inFlight = { ...state(), move: document.documentElement.dataset.gridMove ?? null, images: images() };
    await settle();
    out.minimized = state();
    clickRow(document.querySelector(".sub-label[data-ws]")!);
    await sleep(320);
    out.lidOpening = state();
    await sleep(300);
    await settle();
    out.restored = state();
    ([...document.querySelectorAll<HTMLElement>(".topbar button")].find((b) => b.textContent?.startsWith("Import")) ?? null)?.click();
    await sleep(40);
    note();
    out.dialogOpen = document.querySelectorAll(".modal-back:not(.mb-ghost)").length;
    await settle();
    document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(10);
    out.dialogClosing = { real: document.querySelectorAll(".modal-back:not(.mb-ghost)").length, ghosts: document.querySelectorAll(".mb-ghost").length };
    await settle();
    out.dialogClosed = state();
    emit("onHouseWarning", { at: Date.now(), sessionId: "s1", sessionTitle: "Org dropdowns remember the last org", decision: "deny", tool: "Edit", conflicts: [{ file: "src/api/orgs/last.py", root: "/x", hits: [] }] });
    await sleep(40);
    note();
    await settle();
    (document.querySelector(".house-toast button.icon") as HTMLElement | null)?.click();
    await sleep(10);
    note();
    await settle();
    out.toastGone = { ...state(), toasts: document.querySelectorAll(".house-toast:not(.mb-ghost)").length };
    const dot = document.querySelector(".dot.waiting");
    out.waitingPulse = dot ? getComputedStyle(dot).animationName : null;
    out.transitions = transitions;
    out.longest = Math.round(longest);
    out.mode = document.documentElement.dataset.motion;
    const tag = document.createElement("script");
    tag.type = "application/json";
    tag.id = "mb-motion-audit";
    tag.textContent = JSON.stringify(out);
    document.body.appendChild(tag);
  });
}
// ?termAudit (with ?motion=full or off) does what re-fits or moves terminals — the side bar and the bottom panel
// shown and hidden, fullscreen and back, a group switch and back, a workspace minimized and restored, a pane opened,
// a workspace tab switched, a waiting banner and a stall banner each shown and gone — with panes full of history and output streaming, then
// a Repaint on the normal screen and on the alternate one, and a pane relaunched in place. It finishes animations
// rather than waiting on them, and writes into <script id="mb-term-audit"> for test/uiTerminal.test.ts what was
// wrong after each step: a terminal not at its holder's size, a pty not told its terminal's size, a size sent from a
// holder with no area; and the pty sizes each step sent. The pty sizes are as main has them: a relaunched session's new pty starts at 120×32.
if (params.has("termAudit")) {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  type Entry = import("../renderer/cachedTerm").SizedTerm;
  const terms = () => w.__mbTerms as Map<string, Entry> | undefined;
  const pty: Record<string, string> = {};
  const sent: { id: string; size: string }[] = [];
  const problems: string[] = [];
  const realResize = api.sessionResize;
  api.sessionResize = async (id: string, cols: number, rows: number) => {
    const holder = terms()?.get(id)?.term.element?.parentElement;
    const area = holder?.isConnected && holder.getClientRects().length ? holder.clientWidth * holder.clientHeight : 0;
    if (!area) problems.push(`${id} was sized ${cols}×${rows} from a holder with no area`);
    pty[id] = `${cols}×${rows}`;
    sent.push({ id, size: pty[id] });
    return realResize(id, cols, rows);
  };
  const settle = async () => {
    for (let i = 0; i < 8; i++) {
      await sleep(50);
      for (const a of document.getAnimations()) if (Number.isFinite(a.effect?.getComputedTiming().activeDuration ?? Infinity)) a.finish();
    }
    await sleep(250);
  };
  const check = (step: string) => {
    for (const [id, e] of terms() ?? []) {
      if (!e.term.element?.isConnected || !sessions.some((s) => s.id === id)) continue;
      const size = `${e.term.cols}×${e.term.rows}`;
      const fits = fitSize(e);
      if (!fits || `${fits.cols}×${fits.rows}` !== size) problems.push(`${step}: ${id} is ${size} in a holder that fits ${fits ? `${fits.cols}×${fits.rows}` : "nothing"}`);
      if (pty[id] !== size) problems.push(`${step}: ${id}'s pty is ${pty[id] ?? "unsized"} under a ${size} terminal`);
    }
  };
  const key = (k: string) => window.dispatchEvent(new KeyboardEvent("keydown", { key: k, metaKey: true, bubbles: true }));
  const press = (el: Element | null | undefined, what: string) => {
    if (!el) throw new Error(`the audit found no ${what}`);
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  };
  const row = (selector: string, text: string) => [...document.querySelectorAll(selector)].find((el) => el.textContent?.includes(text));
  const say = (id: string, text: string) => {
    buffers[id] = (buffers[id] ?? "") + text;
    emit("onSessionData", id, text);
  };
  const setSession = (id: string, patch: Partial<SessionInfo>) => {
    sessions = sessions.map((s) => (s.id === id ? { ...s, ...patch } : s));
    sessionsChanged();
  };
  const buffer = (id: string) => terms()?.get(id)?.term.buffer.active;
  waitFor(".grid > [data-cell=s1] .xterm", async () => {
    const out: Record<string, unknown> = {};
    try {
      for (const id of ["s1", "s2", "s3", "s4", "s5", "s8"]) say(id, Array.from({ length: 3000 }, (_, i) => `${id} history ${i}\r\n`).join(""));
      let n = 0;
      const stream = setInterval(() => {
        for (const id of ["s1", "s2", "s3", "s4", "s5", "s8"]) say(id, `${id} live ${n}\r\n`);
        n++;
      }, 20);
      await settle();
      check("start");
      const steps: [string, () => void][] = [
        ["side bar hidden", () => key("b")],
        ["side bar shown", () => key("b")],
        ["bottom panel shown", () => key("j")],
        ["bottom panel hidden", () => key("j")],
        ["fullscreen", () => press(document.querySelector(".pane[data-cell=s1] [data-action=zoom]"), "Full button")],
        ["back to the grid", () => press(document.querySelector("[data-action=zoom]"), "Grid button")],
        ["group switched", () => press(row(".sidebar .group-label", "#5102"), "group #5102")],
        ["group switched back", () => press(row(".sidebar .group-label", "#5101"), "group #5101")],
        ["workspace minimized", () => press(document.querySelector(".sidebar .sub-label[data-ws]"), "workspace folder")],
        ["workspace restored", () => press(document.querySelector(".sidebar .sub-label[data-ws]"), "workspace folder")],
        ["pane opened", () => press(row(".sidebar .sess-item", "Release notes"), "Release notes row")],
        ["workspace tab switched", () => press(document.querySelector(".ws-tab:not(.on)"), "workspace tab")],
        ["workspace tab switched back", () => press(document.querySelector(".ws-tab:not(.on)"), "workspace tab")],
        ["waiting banner shown", () => setSession("s1", { status: "waiting", waitingReason: "Claude needs your permission to use Bash", waitingSince: Date.now() })],
        ["waiting banner gone", () => setSession("s1", { status: "working", waitingReason: null, waitingSince: null })],
        ["stall banner shown", () => setSession("s1", { stalledSince: Date.now() - 5 * min, hooksSilent: true })],
        ["stall banner gone", () => setSession("s1", { stalledSince: null, hooksSilent: false })],
      ];
      const done: string[] = [];
      const resized: Record<string, string[]> = {};
      for (const [step, act] of steps) {
        const mark = sent.length;
        act();
        await sleep(400); // a folder or group click waits out a double-click
        await settle();
        check(step);
        done.push(step);
        resized[step] = sent.slice(mark).map((r) => `${r.id} ${r.size}`);
      }
      out.steps = done;
      out.resized = resized;
      clearInterval(stream);
      await sleep(100);
      // Repaint on the normal screen: an inline session's history is its scrollback
      const before = { lines: buffer("s1")?.length ?? 0, first: buffer("s1")?.getLine(0)?.translateToString(true) };
      let mark = sent.length;
      press(document.querySelector(".pane[data-cell=s1] [data-action=repaint]"), "s1's Repaint");
      await sleep(300);
      const s1 = terms()?.get("s1")?.term;
      out.repaint = { before, after: { lines: buffer("s1")?.length ?? 0, first: buffer("s1")?.getLine(0)?.translateToString(true) }, size: s1 ? `${s1.cols}×${s1.rows}` : null, sent: sent.slice(mark).filter((r) => r.id === "s1").map((r) => r.size) };
      // Repaint on the alternate screen, with the program's mouse tracking on
      say("s4", "\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[Ha full-screen program");
      await sleep(100);
      const s4 = terms()?.get("s4")?.term;
      const modes = () => ({ screen: s4?.buffer.active.type, mouse: s4?.modes.mouseTrackingMode });
      const altBefore = modes();
      press(document.querySelector(".pane[data-cell=s4] [data-action=repaint]"), "s4's Repaint");
      await sleep(300);
      out.repaintAlt = { before: altBefore, after: modes() };
      // the process dies, and is relaunched under the same id: main starts the new pty at 120×32
      const old = terms()?.get("s1")?.term;
      setSession("s1", { status: "dead", exitCode: 1 });
      await sleep(400);
      mark = sent.length;
      pty.s1 = "120×32";
      await api.relaunchSession("s1");
      await sleep(400);
      await settle();
      check("relaunched in place");
      out.relaunch = { newTerminal: !!terms()?.get("s1") && terms()?.get("s1")?.term !== old, sent: sent.slice(mark).filter((r) => r.id === "s1").map((r) => r.size) };
    } catch (err) {
      out.error = String(err);
    }
    out.problems = problems;
    out.mode = document.documentElement.dataset.motion;
    const tag = document.createElement("script");
    tag.type = "application/json";
    tag.id = "mb-term-audit";
    tag.textContent = JSON.stringify(out);
    document.body.appendChild(tag);
  });
}
// ?scrollAudit (with ?motion=full or off) checks that terminals follow their output: a pane whose view was at the
// bottom stays there through a group switch (output arriving while it's hidden, the pane shown again while its
// program is idle), a teammate's copy re-fitted to a wider owner screen at a smaller font, the side bar and the
// bottom panel hidden and shown, and a Repaint; one the user scrolled up stays where they put it while output goes
// on (a teammate's copy too, through its font change), with a "Jump to latest" control that brings it back. After each step it checks every shown terminal: at its bottom (xterm's and the page's
// scroll offsets agreeing), its rows within its holder's content box, nothing scrollable below it. It writes what was
// wrong into <script id="mb-scroll-audit"> for test/uiTerminal.test.ts.
if (params.has("scrollAudit")) {
  set("mb.shown", ["s1", "s4", NICK_PANE]);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  type Core = { _bufferService: { isUserScrolling: boolean }; viewport?: { _currentRowHeight?: number; syncScrollArea?: unknown; _innerRefresh?: unknown }; _renderService: { dimensions: { css: { cell: { height: number } } } } };
  type Term = import("@xterm/xterm").Terminal & { _core: Core };
  const terms = () => w.__mbTerms as Map<string, { term: Term }> | undefined;
  const ids = ["s1", "s2", "s3", "s4", "s5", "s8", NICK_PANE];
  const say = (id: string, text: string) => {
    buffers[id] = (buffers[id] ?? "") + text;
    emit("onSessionData", id, text);
  };
  const lines = (n: number, tag: string) => {
    for (const id of ids) say(id, Array.from({ length: n }, (_, i) => `${id} ${tag} ${i}\r\n`).join(""));
  };
  const settle = async () => {
    for (let i = 0; i < 8; i++) {
      await sleep(50);
      for (const a of document.getAnimations()) if (Number.isFinite(a.effect?.getComputedTiming().activeDuration ?? Infinity)) a.finish();
    }
    await sleep(300);
  };
  const press = (el: Element | null | undefined, what: string) => {
    if (!el) throw new Error(`the audit found no ${what}`);
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  };
  const row = (selector: string, text: string) => [...document.querySelectorAll(selector)].find((el) => el.textContent?.includes(text));
  const problems: string[] = [];
  const shownTerms = () => [...(terms() ?? [])].filter(([, e]) => e.term.element?.isConnected && (e.term.element.parentElement?.getClientRects().length ?? 0) > 0);
  const behind = (t: Term) => t.buffer.active.baseY - t.buffer.active.viewportY;
  const check = (step: string, scrolledUp: string[] = []) => {
    for (const [id, { term }] of shownTerms()) {
      const holder = term.element!.parentElement!;
      const vp = term.element!.querySelector<HTMLElement>(".xterm-viewport")!;
      const rowH = term._core.viewport?._currentRowHeight || term._core._renderService.dimensions.css.cell.height;
      const pad = getComputedStyle(holder);
      const content = holder.clientHeight - parseFloat(pad.paddingTop) - parseFloat(pad.paddingBottom);
      const pane = holder.closest(".pane");
      const toast = !!pane?.querySelector(".scroll-toast.jump");
      if (scrolledUp.includes(id)) {
        if (!behind(term)) problems.push(`${step}: ${id} was scrolled up, and its view went to the bottom`);
        if (!toast) problems.push(`${step}: ${id} is scrolled up with no Jump to latest`);
      } else {
        if (behind(term)) problems.push(`${step}: ${id} is ${behind(term)} lines above its bottom${term._core._bufferService.isUserScrolling ? ", no longer following its output" : ""}`);
        if (toast) problems.push(`${step}: ${id} is at its bottom and shows Jump to latest`);
        // the page's scroll offset is where xterm reads the next wheel move from: a screen short of the bottom, it jumps the view up
        const reach = Math.round((vp.scrollHeight - vp.clientHeight) / rowH);
        if (Math.abs(reach - term.buffer.active.baseY) > 0) problems.push(`${step}: ${id}'s page can scroll to line ${reach} of its ${term.buffer.active.baseY}`);
        if (Math.abs(vp.scrollTop / rowH - term.buffer.active.viewportY) >= 0.5) problems.push(`${step}: ${id}'s page is scrolled to line ${(vp.scrollTop / rowH).toFixed(1)}, its view at ${term.buffer.active.viewportY}`);
      }
      if (!holder.classList.contains("fixed") && term.rows * rowH > content + 0.5) problems.push(`${step}: ${id} has ${term.rows} rows (${(term.rows * rowH).toFixed(1)}px) in ${content}px`);
      // a holder that scrolls past its terminal shows blank space below the program's last line
      const below = holder.scrollHeight - holder.clientHeight - Math.max(0, term.element!.offsetHeight + parseFloat(pad.paddingTop) + parseFloat(pad.paddingBottom) - holder.clientHeight);
      if (below > 1) problems.push(`${step}: ${id}'s pane has ${below}px to scroll below its terminal`);
    }
  };
  waitFor(".grid > [data-cell=s1] .xterm", async () => {
    const out: Record<string, unknown> = {};
    const done: string[] = [];
    try {
      await sleep(500); // the teammate's copy opens with the rest
      lines(3000, "history");
      await settle();
      out.internals = shownTerms().every(([, e]) => typeof e.term._core.viewport?.syncScrollArea === "function" && typeof e.term._core.viewport?._innerRefresh === "function");
      out.shown = shownTerms().map(([id]) => id);
      check("start");
      done.push("start");
      // output while the group is hidden; shown again while its programs are idle
      press(row(".sidebar .group-label", "#5102"), "group #5102");
      await sleep(400);
      await settle();
      for (let i = 0; i < 10; i++) {
        lines(20, `hidden ${i}`);
        await sleep(30);
      }
      await settle();
      press(row(".sidebar .group-label", "#5101"), "group #5101");
      await sleep(400);
      await settle();
      check("group shown again, idle");
      lines(40, "after");
      await settle();
      check("output after the group came back");
      done.push("group switch");
      // the teammate's screen widens while their copy here is scrolled up: it re-fits at a smaller font and stays
      // where it was; then their screen narrows again, and the copy follows its output at the larger font
      const nick = live.remote.find((s) => s.id === NICK_PANE)!;
      const copy = terms()!.get(NICK_PANE)!.term;
      copy.element!.querySelector(".xterm-screen")!.dispatchEvent(new WheelEvent("wheel", { deltaY: -400, deltaMode: 0, bubbles: true, cancelable: true }));
      await settle();
      nick.room = { ...nick.room!, cols: 240, rows: 30 };
      emit("onTeamLive", JSON.parse(JSON.stringify(live)));
      await settle();
      lines(20, "small font");
      await settle();
      check("teammate's copy at a smaller font, scrolled up", [NICK_PANE]);
      const copyLatest = document.querySelector(`.pane[data-cell="${CSS.escape(NICK_PANE)}"] .scroll-toast.jump`);
      if (copyLatest) press(copyLatest, "the copy's Jump to latest");
      else copy.scrollToBottom(); // its problem is noted: the rest still runs
      nick.room = { ...nick.room!, cols: 110, rows: 30 };
      emit("onTeamLive", JSON.parse(JSON.stringify(live)));
      await settle();
      lines(20, "larger font");
      await settle();
      check("teammate's copy back at its larger font");
      done.push("teammate's screen grew");
      // the side bar hidden and shown: every pane re-fits, the teammate's copy at another font
      for (const step of ["side bar hidden", "side bar shown"]) {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", metaKey: true, bubbles: true }));
        lines(10, step);
        await settle();
        check(step);
        done.push(step);
      }
      // the bottom panel shown and hidden while the programs are idle: the panes get shorter and taller, every
      // program's cursor where it was
      for (const step of ["bottom panel shown", "bottom panel hidden"]) {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", metaKey: true, bubbles: true }));
        await settle();
        check(`${step}, idle`);
        done.push(step);
      }
      // the user scrolls a pane up; output goes on; it stays, until Jump to latest
      const s1 = terms()!.get("s1")!.term;
      s1.element!.querySelector(".xterm-screen")!.dispatchEvent(new WheelEvent("wheel", { deltaY: -600, deltaMode: 0, bubbles: true, cancelable: true }));
      await settle();
      const top = s1.buffer.active.getLine(s1.buffer.active.viewportY)?.translateToString(true);
      lines(60, "while scrolled up");
      await settle();
      check("output while the user is scrolled up", ["s1"]);
      if (s1.buffer.active.getLine(s1.buffer.active.viewportY)?.translateToString(true) !== top) problems.push("output while the user is scrolled up: s1's view moved from where they put it");
      const toLatest = document.querySelector(".pane[data-cell=s1] .scroll-toast.jump");
      if (toLatest) press(toLatest, "s1's Jump to latest");
      else s1.scrollToBottom(); // its problem is noted: the rest still runs
      await settle();
      check("Jump to latest");
      lines(20, "after the jump");
      await settle();
      check("output after Jump to latest");
      done.push("scrolled up, then back");
      press(document.querySelector(".pane[data-cell=s1] [data-action=repaint]"), "s1's Repaint");
      await sleep(300);
      await settle();
      check("Repaint");
      done.push("Repaint");
    } catch (err) {
      out.error = String(err);
    }
    out.steps = done;
    out.problems = problems;
    out.mode = document.documentElement.dataset.motion;
    const tag = document.createElement("script");
    tag.type = "application/json";
    tag.id = "mb-scroll-audit";
    tag.textContent = JSON.stringify(out);
    document.body.appendChild(tag);
  });
}
// What's new: ?whatsNew opens the version label's popover; =updated starts as the first launch after an update
// ("Updated to …", opened by itself); =earlier, =next and =suggestions unfold that part (=all: every part);
// =form, =confirm and =problem walk Suggest something to that step (pair =problem with ?suggest=gh-missing …)
const whatsNewQ = params.get("whatsNew");
if (whatsNewQ === "updated") {
  const older = CHANGELOG.find((r) => r.version !== version)?.version ?? "1.0.0";
  set("mb.whatsNew.lastSeen", older);
}
if (whatsNewQ !== null && whatsNewQ !== "updated") {
  waitFor(".brand .ver", (el) => {
    el.click();
    const fold = (id: string) => (document.querySelector(`.wn-fold[data-fold="${id}"] > .wn-fold-btn`) as HTMLElement | null)?.click();
    setTimeout(() => {
      if (whatsNewQ === "earlier" || whatsNewQ === "all") {
        fold("earlier");
        setTimeout(() => fold(`v${CHANGELOG.find((r) => r.version !== version)?.version}`), 50);
      }
      if (whatsNewQ === "next" || whatsNewQ === "all") fold("next");
      if (whatsNewQ === "suggestions" || whatsNewQ === "all") fold("suggestions");
      if (whatsNewQ === "form" || whatsNewQ === "confirm" || whatsNewQ === "problem") {
        click(".wn-foot button");
        setTimeout(() => {
          typeInto(".wn-form input", "Show the branch's CI status in the pane rail");
          const area = document.querySelector(".wn-form textarea") as HTMLTextAreaElement | null;
          if (area) typeArea(area, "A green or red dot next to the branch name, so I don't have to open GitHub to see whether CI passed.");
          if (whatsNewQ !== "form") setTimeout(() => (buttonNamed(".wn-foot", "Review") as HTMLElement | undefined)?.click(), 80);
        }, 80);
      }
    }, 120);
  });
}
// ?wnAudit (real time: pageResult) checks the popover from the keyboard's side — the label is a focusable button,
// opening moves focus into a named dialog whose body scrolls inside a bounded height, Esc closes it and gives focus
// back to the label, as does a click outside — and writes the results into <script id="mb-wn-audit"> for
// test/uiWhatsNew.test.ts. With ?whatsNew=updated it starts from the label's "Updated to" state.
if (params.has("wnAudit")) {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const label = () => document.querySelector(".brand .ver") as HTMLButtonElement | null;
  const pop = () => document.querySelector(".wn-pop") as HTMLElement | null;
  const esc = () => (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  const inPop = () => !!pop()?.contains(document.activeElement);
  (async () => {
    for (let i = 0; i < 100 && !label(); i++) await sleep(50);
    await sleep(400);
    const out: Record<string, unknown> = {};
    out.startLabel = label()?.textContent ?? null;
    out.startOpen = !!pop();
    if (pop()) {
      esc();
      await sleep(250);
    }
    out.afterDismissLabel = label()?.textContent ?? null;
    out.lastSeen = localStorage.getItem("mb.whatsNew.lastSeen");
    const b = label()!;
    b.focus();
    out.labelFocusable = document.activeElement === b && b.tagName === "BUTTON" && b.tabIndex >= 0;
    out.labelPopup = b.getAttribute("aria-haspopup");
    b.click();
    await sleep(250);
    out.opened = !!pop();
    out.expanded = b.getAttribute("aria-expanded");
    out.role = pop()?.getAttribute("role") ?? null;
    out.name = pop()?.getAttribute("aria-label") ?? null;
    out.focusInside = inPop();
    for (const id of ["earlier", "next", "suggestions"]) (document.querySelector(`.wn-fold[data-fold="${id}"] > .wn-fold-btn`) as HTMLElement | null)?.click();
    await sleep(100);
    for (const btn of document.querySelectorAll<HTMLElement>(".wn-fold.sub > .wn-fold-btn")) btn.click();
    await sleep(600);
    const body = document.querySelector(".wn-body") as HTMLElement | null;
    const box = pop()!.getBoundingClientRect();
    out.popHeight = box.height;
    out.popBottom = box.bottom;
    out.windowHeight = innerHeight;
    out.bodyScrolls = !!body && getComputedStyle(body).overflowY === "auto" && body.scrollHeight > body.clientHeight;
    out.expandedFolds = document.querySelectorAll('.wn-fold-btn[aria-expanded="true"]').length;
    esc();
    await sleep(250);
    out.closedByEsc = !pop();
    out.focusBack = document.activeElement === label();
    label()!.click();
    await sleep(250);
    (document.querySelector(".ver-wrap .who-back") as HTMLElement | null)?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await sleep(250);
    out.closedByOutside = !pop();
    // Esc while typing a suggestion closes the popover too, and the draft is still there when it's reopened
    label()!.click();
    await sleep(200);
    click(".wn-foot button");
    await sleep(150);
    typeInto(".wn-form input", "Draft title");
    out.typingFocus = document.activeElement === document.querySelector(".wn-form input");
    esc();
    await sleep(250);
    out.closedFromForm = !pop();
    label()!.click();
    await sleep(250);
    out.draftKept = (document.querySelector(".wn-form input") as HTMLInputElement | null)?.value ?? null;
    const tag = document.createElement("script");
    tag.type = "application/json";
    tag.id = "mb-wn-audit";
    tag.textContent = JSON.stringify(out);
    document.body.appendChild(tag);
  })();
}
// ?help opens the guide (⌘/)
if (params.has("help")) waitFor(".statusbar .help-link", (el) => el.click());
// ?measure=<selector> (repeatable) writes where each match sits into the page once the fixtures have landed, for
// layout checks that read the page back (pageDom in scripts/ui-preview.mjs): a <script id="mb-measure"> holding
// { [selector]: { x, y, w, h, text }[] }, hidden matches included at 0×0
const measure = params.getAll("measure");
if (measure.length) {
  setTimeout(() => {
    const at = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, text: (el.textContent ?? "").trim().slice(0, 200) };
    };
    const out = document.createElement("script");
    out.type = "application/json";
    out.id = "mb-measure";
    out.textContent = JSON.stringify(Object.fromEntries(measure.map((sel) => [sel, [...document.querySelectorAll(sel)].map(at)]))).replace(/</g, "\\u003c");
    document.body.appendChild(out);
  }, 2500);
}
if (params.has("reset")) {
  params.delete("reset");
  history.replaceState(null, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
}
