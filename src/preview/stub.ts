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
import { compactBlocker, rereadCost } from "../shared/contextBudget";
import type { AdoBoard, AdoWorkItem, CollabParticipant, CollabRoom, ContextWindow, GraphCommit, Meters, PipelineRequest, PlanRequest, RunProfile, SessionInfo, Settings, TicketPipeline, TicketStage, UsageReport } from "../shared/types";
import { DEFAULT_SETTINGS, HELPDESK_GROUP, HELPDESK_PRESET, HELPDESK_STARTING, HELPDESK_START_IN_ROOM, clearGateTicks, clearsGates, helpdeskOpenAlready, prAskedState, prNeedsYou, splitGroupKey, stepSlug, ticketOfSession } from "../shared/types";
import { tildePath } from "../shared/paths";
import { CHANGELOG } from "../shared/changelog";
import { bottomLine, followsBottom, measuredCell } from "../renderer/cachedTerm";
import { PEEK_HOVER_MS } from "../renderer/landscapeModel";
import type { SuggestProblem } from "../shared/suggestions";
import { changedTags, parseCardRules, type TagChange } from "../shared/cardRules";
import type { MigrationsView } from "../shared/team/migrations";
import type { TeamRoomSummary, TeamStatus } from "../shared/team/types";
// the version being built, and an update one patch above it
import { version } from "../../package.json";
const nextVersion = version.replace(/\d+$/, (n) => String(Number(n) + 1));
// team rooms: the House board
import { branchFor, HOUSE_TOKEN_HOW, isOpenStatus, openBacklog, type HouseHistoryEntry, type HouseOwner, type HouseRow, type HouseTicket, type HouseTicketDetail, type HouseTicketView, type HouseView, type HouseWrite } from "../shared/team/house";
// team rooms: a session from a ticket
import type { TicketHolder, TicketSessionPlan, TicketSessionRequest, TicketSessionResult } from "../shared/team/ticketSession";
// team rooms: team chat
import { parseMentions, unreadCounts, type ChatEntry, type ReadMarks } from "../shared/team/chat";
// team rooms: take-over
import { NOT_PUSHED, type RoomSessionBackupView, type TakeoverPlan, type TakeoverView } from "../shared/team/takeover";
import type { AuditEntry } from "../shared/team/audit";
// Council: an approved plan as House tickets
import { draftsFromModel, splitPlan, wholePlanDraft, type CouncilCreateResult, type CouncilHouseTargets, type TicketDraft } from "../shared/collabTickets";
import type { PhoneStatus } from "../shared/phoneAlerts";
// team rooms: live panes
import { remotePaneId, type LivePanesState, type RoomSessionTag } from "../shared/team/livePanes";
// team rooms: artifacts
import { artifactRef, linkLabel, parseArtifactRefs, type ArtifactContent, type ArtifactLocal, type ArtifactSummary, type ArtifactView, type RoomArtifactsView } from "../shared/team/artifacts";
// the landscape
import { LEGACY_PREF_KEYS } from "../shared/landscapeMigrate";
import { recordConsole, runNeedsAudit } from "./needsYouAudit";
import { runFirstRunAudit } from "./firstRunAudit";
// the audits' presses on the landscape that are set up rather than driven arm it as a press would (keyArm.ts)
import { armFocus } from "../renderer/keyArm";
import { runSwitchAudit } from "./switchAudit";
import { kickoffAsTicket, layOutPlan, parseTemplateBody, readTemplates, roomAsked, startsAtOrchestrator, ticketLine, wireSettingsOf, withTicket, type LayOutReply, type LayOutRequest, type TemplateBody, type TemplateDraft, type TemplateStep, type TemplateWire } from "../shared/pipelineTemplates";
import { checkPlan, ME as PLAN_ME, orchestratorKickoff, readShownPlan, type Plan, type PlanContext, type PlanLaidOut, type PlanView } from "../shared/plans";
import { boardPlan, councilPlan, runPlanAudit } from "./planAudit";
import { WIRE_AREA, boardTemplates, gateBoardBook, gateMerges, gatePipeline, heldWaitsBook, manyWiresBook, placeWireBoard, runWiresAudit, stripBoardBook, stripBoardOf, wireBoardBook, wireBoardSessions } from "./wiresAudit";
import { runStripAudit } from "./stripAudit";
import { openFinishShot } from "./wireNeedsAudit";
import { AREA_GAP, AREA_HEADER, AREA_PAD, GAP, LandscapeShapeError, WORKSPACE_CHROME, applyPatch, areaKeyOf, colsRows, emptyLandscape, fitAreaTo, kindOf, parseLandscape, parsePatch, placeNew, presetSize, renameAreaPatch, reopenPatch, sameLandscape, stackKeyOf, type Area, type Landscape, type LandscapePatch, type LandscapeProblem, type LandscapeState, type Rect } from "../shared/landscape";

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
  // S7: its turn ended 12 minutes ago and it has been idle since, so Needs you lists it as finished
  session("s8", { title: "Release notes for #5101", taskGroup: "5101", branch: "5101-orgDropdowns", cwd: WT("5101-orgDropdowns"), status: "idle", finishedAt: now - 12 * min }),
  session("s5", { title: "#5102 — Pathways quick view freezes", ticketId: "5102", ticketTitle: "Pathways quick view freezes", taskGroup: "5102", branch: "5102-quickViewFreeze", cwd: WT("5102-quickViewFreeze"), status: "idle" }),
  session("s6", { title: "Crashed session", taskGroup: "5102", status: "dead", exitCode: 1 }),
  session("s7", { title: "assistant", repoPath: null, cwd: "/Users/you", kind: "assistant", taskGroup: null, status: "idle" }),
  // continued on Nick's laptop: its agent stopped here (team rooms: take-over)
  session("y1", { title: "Donor entity model", taskGroup: "5110", branch: "5110-donor-entities", cwd: WT("5110-donor-entities"), status: "dead" }),
];
// ?helpdesk: the Helpdesk tasks workspace is running, in its own area (its header's Chrome chip)
if (new URLSearchParams(location.search).has("helpdesk"))
  sessions.push(session("h1", { title: "Helpdesk tasks", repoPath: null, cwd: "/Users/you/Helpdesk", kind: "assistant", taskGroup: "Helpdesk", role: "tasks", status: "idle", finishedAt: now - 3 * min }));
// ?stall=hooks: s1 shows the stall banner of a pane whose hooks never reported ("working" may be wrong, Mark idle);
// ?stall=quiet: of one that's gone quiet while working
// ?needsMany: four more sessions waiting on a permission prompt, so Needs you lists seven items (with ?joinRequest=later)
if (new URLSearchParams(location.search).has("needsMany"))
  sessions = sessions.map((s, i) => (["s1", "s3", "s5", "s7"].includes(s.id) ? { ...s, status: "waiting", waitingReason: "Claude needs your permission to use Edit", waitingSince: now - (i + 1) * min, waitingAt: now - (i + 1) * min } : s));
const stallQ = new URLSearchParams(location.search).get("stall");
if (stallQ) sessions = sessions.map((s) => (s.id === "s1" ? { ...s, status: "working", stalledSince: now - 6 * min, hooksSilent: stallQ === "hooks" } : s));
// closed sessions this Mac can reopen (main's resumable ones): ghosts where they have places on the landscape, the
// rest in the Closed sessions list. p1 is a loose ghost; g1 has its place in 5102; g2's worktree has been removed
// (missingFolders), so it starts fresh; o1 (in 5102) and o2 (in 5150, which has no area) have no place
let previous: SessionInfo[] = [
  session("p1", { title: "Yesterday's spike", status: "dead", taskGroup: null }),
  session("g1", { title: "Profile the tag list", ticketId: "5102", taskGroup: "5102", branch: "5102-quickViewFreeze", cwd: WT("5102-quickViewFreeze"), agent: "codex", status: "dead", conversation: { agent: "codex", id: "conv-g1" }, createdAt: now - 3 * 60 * min }),
  session("g2", { title: "Spike: org cache", ticketId: "5101", taskGroup: "5101", branch: "5101-orgCache", cwd: WT("5101-orgCache"), status: "dead", conversation: { agent: "claude", id: "conv-g2" }, createdAt: now - 5 * 60 * min }),
  session("o1", { title: "Tag list notes", ticketId: "5102", taskGroup: "5102", status: "dead", conversation: { agent: "claude", id: "conv-o1" }, createdAt: now - 26 * 60 * min }),
  session("o2", { title: "Export spike", taskGroup: "5150", status: "dead", conversation: { agent: "claude", id: "conv-o2" }, createdAt: now - 50 * 60 * min }),
];
// ?lsManyClosed=<n>: n more closed sessions with no place, for a long Closed sessions list
for (let i = 1; i <= Number(new URLSearchParams(location.search).get("lsManyClosed") ?? 0); i++) {
  previous.push(session(`c${i}`, { title: `Closed spike ${i}`, taskGroup: "5102", status: "dead", conversation: { agent: "claude", id: `conv-c${i}` }, createdAt: now - (60 + i) * 60 * min }));
}
// ?lsWires: the wires board's workspaces in their own area, 5120 (wiresAudit.ts); with ?landscapeMany, wires between those instead.
// ?wires=chain|fanout: the board with the pipeline strip's boards' wires added (stripBoardBook), for its strip in focus
// (?lsFocus=wb-builder)
const stripBoard = stripBoardOf(new URLSearchParams(location.search).get("wires"));
const lsWiresQ = new URLSearchParams(location.search).get("lsWires") ?? (stripBoard ? "" : null);
const wireBoard = lsWiresQ !== null && !new URLSearchParams(location.search).has("landscapeMany") ? wireBoardSessions(session, WT) : null;
if (wireBoard) {
  sessions.push(...wireBoard.running);
  previous.push(...wireBoard.closed);
}
// steps not started yet (main's sessions:planned, W8). ?lsPlanned: the wires board's Tester hasn't started, as
// Inbox.dc.html has it, its place and Reviewer's handoff to it kept
let planned: SessionInfo[] = [];
if (wireBoard && new URLSearchParams(location.search).has("lsPlanned")) {
  const tester = sessions.find((s) => s.title === "Tester" && s.taskGroup === wireBoard.running[0].taskGroup)!;
  sessions = sessions.filter((s) => s !== tester);
  planned.push({ ...tester, branch: null, cwd: tester.repoPath ?? tester.cwd, status: "idle", planned: { worktree: true, prompt: "Run the e2e suite in docker against this branch." } });
}
/** The closed sessions whose folders are gone (main's sessions:missingFolders): g2's worktree and branch were removed. */
const goneFolders = new Map([["g2", { reopens: false, short: "Its worktree was removed", why: "Its worktree was removed, and its branch with it, so it can't run where it ran: start fresh instead" }]]);
// ?lsSpikeGone: the wires board's ghost, Spike: streaming, can't run where it ran either, so it offers Start fresh
if (wireBoard && new URLSearchParams(location.search).has("lsSpikeGone")) goneFolders.set(wireBoard.closed[0].id, goneFolders.get("g2")!);
// ?lsClosed=<id,…>: those sessions are closed, as if closed with their places kept (y1, which Nick took over, shows Take it back)
const lsClosedQ = new URLSearchParams(location.search).get("lsClosed")?.split(",").filter(Boolean) ?? [];
// what each closed session last showed: its saved output (main's sessions:closedOutput)
const closedOutput: Record<string, string> = {
  p1: "\x1b[1m> Try a Redis cache for the org list\x1b[0m\r\n\r\n⏺ Measured: the org list loads in 40 ms from Redis, 1.2 s from SQL.\r\n",
  g1: "codex\r\n› Profile the tag list\r\n\r\n• Memoizing the tag list keeps typing under 16 ms a key.\r\n\r\n› ",
  g2: "\x1b[1m> Cache the last org per user\x1b[0m\r\n\r\n⏺ The cache works; its backup wasn't deleted from origin.\r\n",
};
for (const id of lsClosedQ) {
  const s = sessions.find((x) => x.id === id);
  if (!s) {
    console.error(`[preview] ?lsClosed found no session ${id}`);
    continue;
  }
  sessions = sessions.filter((x) => x !== s);
  previous = [...previous, { ...s, status: "dead" }];
}
// ?lsStep=<id,…>: those closed sessions are steps not started yet instead (W8), their places kept
for (const id of new URLSearchParams(location.search).get("lsStep")?.split(",").filter(Boolean) ?? []) {
  const s = previous.find((x) => x.id === id);
  if (!s) {
    console.error(`[preview] ?lsStep found no closed session ${id}`);
    continue;
  }
  previous = previous.filter((x) => x !== s);
  planned.push({ ...s, status: "idle", branch: null, conversation: undefined, planned: { worktree: true } });
}
// ?closedAsLeft: the closed sessions as main keeps them, a pane's record staying as it was when it closed: g2 and o2 on a
// prompt nobody answered, the others idle with their last turn's end on record
if (new URLSearchParams(location.search).has("closedAsLeft"))
  previous = previous.map((s): SessionInfo => (["g2", "o2"].includes(s.id) ? { ...s, status: "waiting", waitingReason: "Claude needs your permission to use Edit", waitingSince: now - 40 * min, waitingAt: now - 40 * min } : { ...s, status: "idle", finishedAt: now - 30 * min }));

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
// ?phone=…: phone alerts set up (the status they report is below, by the audit log)
{
  const q = new URLSearchParams(location.search).get("phone");
  if (q) settings.phoneAlerts = { enabled: true, handle: "you@icloud.com", idleMinutes: 10, finished: true, replies: q === "replies" || q === "nofda" || q === "dev" };
  // a reply from the phone answered s1's last prompt
  if (q === "replies") sessions = sessions.map((s) => (s.id === "s1" ? { ...s, phoneNote: { text: "Answered from your phone: allow once", at: now - 3 * 60_000 } } : s));
}

const pipelines: Record<string, TicketPipeline> = {
  "5101": {
    ticketId: "5101",
    title: "Org dropdowns remember the last org",
    stage: "local-test",
    history: [{ at: now - 26 * 60 * min, stage: "coding" }, { at: now - 60 * min, stage: "local-test" }],
    // S7: a card's PR badge (s1's and s8's branch)
    prs: [{ target: "dev", provider: "ado", id: 88, url: "https://dev.azure.com/acme/Backoffice/_git/backoffice/pullrequest/88", repo: "backoffice", branch: "5101-orgDropdowns", base: "dev", at: now - 40 * min }],
    feedback: [],
    drafts: [{ id: "d1", stage: "local-test", text: "Development is done; testing locally.", at: now - 60 * min }],
    checks: { "dev:tests": true },
  },
  // a ticket at a stage 1.6 doesn't know, AI testing in dev/UAT. No PR is recorded: one on s5's branch would add the
  // PR badge the card audits pin s5 without
  "5102": {
    ticketId: "5102",
    title: "Pathways quick view freezes",
    stage: "dev-test",
    history: [
      { at: now - 3 * 24 * 60 * min, stage: "coding", by: "you" },
      { at: now - 30 * 60 * min, stage: "local-test", by: "you" },
      { at: now - 6 * 60 * min, stage: "pr-dev", by: "you" },
      { at: now - 25 * min, stage: "dev-test", by: "you" },
    ],
    prs: [],
    feedback: [],
    drafts: [],
    checks: { "dev:tests": true, "dev:smoke": true },
    checkedBy: { "dev:tests": { by: "you", at: now - 31 * 60 * min }, "dev:smoke": { by: "you", at: now - 30 * 60 * min } },
  },
};
// W4c, ?lsGates (with ?lsWires): the wires board's gates as the send popover shows them (wiresAudit.ts' gateBoardBook),
// =limit with Reviewer's feedback loop at its limit; 5120's pull request to dev can't be read
const lsGatesQ = wireBoard ? new URLSearchParams(location.search).get("lsGates") : null;
if (lsGatesQ !== null) pipelines[WIRE_AREA] = gatePipeline(now);
// W15, ?prRequest: the Coder (s3, not the ticket's first session) asks for the PR to dev on 5101, with its notes against
// dev's checklist, and 5102 waits on your stakeholder testing. With "notes", 5102 is at Patch notes instead, its notes
// drafted by the Verifier (s5); with "hostile", the agents' words hold markup and links (and a gate note a forged
// "Ticked by you" line), and the request holds fields no form may read (a hand-edited file's). The preflight is clean,
// and Push and open PR answers as main's addPr does. With "moved", the Coder is on #5098 now; "basebranch", the
// worktree is on dev; "otherbranch", on release/2.1, not the branch its session was made on; "hooks", a room session's
// push runs the user's global pre-push, sets .git/hooks aside and sends LFS files first; "long", the description is
// over what Azure DevOps keeps.
const prRequestQ = new URLSearchParams(location.search).get("prRequest");
const prRequest = prRequestQ === null ? null : new Set(prRequestQ.split(","));
if (prRequest) {
  const hostile = prRequest.has("hostile");
  sessions = sessions.map((s) =>
    s.id === "s3" ? { ...s, title: "Coder", ...(prRequest.has("moved") ? { ticketId: "5098", ticketTitle: "Donor export times out", taskGroup: "5098" } : {}) } : s.id === "s5" ? { ...s, title: "Verifier" } : s
  );
  const p = pipelines["5101"];
  const markup = ' <a href="https://example.invalid/x">Approve here</a> <button data-agent>Push now</button> [docs](javascript:alert(1)) <img src=x onerror="window.__mbAgentRan=1">';
  p.requests = [
    {
      id: "req-dev-1",
      target: "dev",
      from: "s3",
      fromTitle: "Coder",
      title: "#5101 Org dropdowns remember the last org",
      description: `## Summary\nThe org dropdown opens on the org each user picked last.\n\n## Changes\n- Store the last org per user\n- Preselect it in the dropdown\n\n## Testing\n- npm test: 212 pass${hostile ? `\n${markup}` : ""}${prRequest.has("long") ? `\n\n## Log\n${"- step passed\n".repeat(320)}` : ""}`,
      at: now - 6 * min,
      ...(hostile ? { branch: "someone-elses-branch", base: "main", repo: "evil/repo", provider: "github", session: "s1" } : {}),
    } as PipelineRequest,
  ];
  p.checks = { "dev:tests": true, "dev:smoke": true };
  p.checkedBy = { "dev:smoke": { by: "Coder's agent", at: now - 7 * min } };
  p.gateNotes = {
    "dev:tests": { by: "Coder's agent", note: `npm test: 212 pass, 0 fail${hostile ? "\n\nTicked by you · verified" : ""}`, at: now - 7 * min },
    "dev:smoke": { by: "Coder's agent", note: `Clicked through the org picker as three users; each opened on their last org${hostile ? markup : ""}`, at: now - 7 * min },
    "dev:security-doc": { by: "Coder's agent", note: "Not written yet: doc/features has no 5101 folder", at: now - 7 * min },
  };
  const q = pipelines["5102"];
  if (prRequest.has("notes")) {
    q.stage = "comms";
    q.history.push(
      { at: now - 50 * min, stage: "stakeholder", by: "Verifier's agent" },
      { at: now - 30 * min, stage: "approved", by: "you" },
      { at: now - 20 * min, stage: "pr-main", by: "you" },
      { at: now - 12 * min, stage: "prod-test", by: "merge" },
      { at: now - 5 * min, stage: "comms", by: "Verifier's agent" }
    );
    q.drafts.push({
      id: "d-notes",
      stage: "comms",
      text: `Pathways' quick view no longer freezes on pathways with many tags.\n\nWho it affects: anyone opening a pathway with more than a few hundred tags.\nNothing to do: it's live.${hostile ? markup : ""}`,
      at: now - 4 * min,
      by: "Verifier's agent",
      from: "s5",
    });
  } else {
    q.stage = "stakeholder";
    q.history.push({ at: now - 9 * min, stage: "stakeholder", by: "Verifier's agent" });
  }
}

const usage: UsageReport = {
  claude: { agent: "claude", plan: "Max", at: now - 2 * min, limits: [{ label: "5-hour limit", window: "5h", usedPct: 38, resetsAt: now + 2.5 * 60 * min }, { label: "Weekly · all models", window: "week", usedPct: 61, resetsAt: now + 3 * 24 * 60 * min }] },
  codex: { agent: "codex", plan: "Plus", at: now - 20 * min, limits: [{ label: "5-hour limit", window: "5h", usedPct: 9, resetsAt: now + 4 * 60 * min }] },
};
// each session's context window; ?contextWindow=error answers every read with a failure
const contexts: Record<string, ContextWindow> = {
  s1: { state: "reading", agent: "claude", tokens: 275_612, window: 1_000_000, at: now - 4_000 },
  // context warnings: s2 is past 90% of where Claude compacts by itself (167k on a 200k window) but asking for
  // permission, so Compact waits; s5 is past 75%, idle at its prompt
  s2: { state: "reading", agent: "claude", tokens: 152_300, window: 200_000, at: now - 40_000, model: "claude-sonnet-5", cache: { warm: true, expiresAt: now + 4 * min, recacheTokens: 151_000 } },
  s5: { state: "reading", agent: "claude", tokens: 760_400, window: 1_000_000, at: now - 9 * min, model: "claude-opus-5-5", cache: { warm: false, expiresAt: now - 4 * min, recacheTokens: 758_000 } },
  s3: { state: "reading", agent: "codex", tokens: 64_210, window: 272_000, at: now - 3 * min },
};
// ?ctxAudit=takenOver: y1, which Nick took over, still running here (its stop not yet reported) with its context past
// 90%, so its warning shows
if (new URLSearchParams(location.search).get("ctxAudit") === "takenOver") {
  sessions = sessions.map((s) => (s.id === "y1" ? { ...s, status: "idle" } : s));
  contexts.y1 = { state: "reading", agent: "claude", tokens: 160_000, window: 200_000, at: now - 20_000, model: "claude-sonnet-5" };
}
const tokens = (input: number, output: number, cacheRead: number) => ({ input, output, cacheRead, cacheWrite: Math.round(input / 3), replies: 40 });
const meters: Meters = {
  at: now,
  today: { claude: tokens(2_100_000, 380_000, 48_000_000), codex: tokens(210_000, 40_000, 0) },
  sessions: {
    s1: { agent: "claude", tokens: tokens(900_000, 120_000, 21_000_000), window: { tokens: 6_000_000, sharePct: 14, usedPct: 38, resetsAt: now + 2.5 * 60 * min } },
    s2: { agent: "claude", tokens: tokens(300_000, 60_000, 7_000_000), window: { tokens: 1_000_000, sharePct: 2.4, usedPct: 38, resetsAt: now + 2.5 * 60 * min } },
    s5: { agent: "claude", tokens: tokens(400_000, 70_000, 9_000_000), window: { tokens: 1_400_000, sharePct: 3.1, usedPct: 38, resetsAt: now + 2.5 * 60 * min } },
    s8: { agent: "claude", tokens: tokens(150_000, 30_000, 2_000_000), window: { tokens: 400_000, sharePct: 0.9, usedPct: 38, resetsAt: now + 2.5 * 60 * min } },
  },
  // a group's and a ticket's sessions summed (each conversation once): 5101's s1, s2 and s3
  groups: {
    "5101": { sessions: 3, tokens: tokens(1_420_000, 196_000, 28_700_000), window: { claude: { tokens: 7_000_000, sharePct: 16.4 }, codex: { tokens: 310_000, sharePct: 2.1 } } },
    "5102": { sessions: 2, tokens: tokens(610_000, 88_000, 11_200_000), window: { claude: { tokens: 1_900_000, sharePct: 4.8 } } },
  },
  tickets: {
    "5101": { sessions: 3, tokens: tokens(1_420_000, 196_000, 28_700_000), window: { claude: { tokens: 7_000_000, sharePct: 16.4 }, codex: { tokens: 310_000, sharePct: 2.1 } } },
    "5102": { sessions: 2, tokens: tokens(610_000, 88_000, 11_200_000), window: { claude: { tokens: 1_900_000, sharePct: 4.8 } } },
    // the House's #143, claimed by you
    "143": { sessions: 1, tokens: tokens(240_000, 41_000, 5_300_000), window: { claude: { tokens: 900_000, sharePct: 2.2 } } },
  },
};

// S7, Needs you and the cards' badges: each worktree's diff against its area repo's base, what each agent said last,
// and ?badgeFail=diff,pr,reply,meters failing those sources (an unreadable worktree, pipeline.json, conversation index,
// token meters), so the badges show "—" and say why. s8 finished its turn 12 minutes ago (the fixture above), s2 waits on
// a permission prompt, and ?joinRequest adds Lee asking to join 5101: the tray's three kinds
const badgeFails = new Set(new URLSearchParams(location.search).get("badgeFail")?.split(",") ?? []);
/** Main's reason when the conversation index can't sync: what meters:get answers and meters:changed pushes (main's metersNow). */
const METERS_FAIL = "the conversation index isn't available (transcripts:sync: SQLITE_BUSY: database is locked)";
/** ?teamFail: the team status can't be read, so the rooms' join requests aren't known (the Needs you tray says so). */
const teamFails = new URLSearchParams(location.search).has("teamFail");
const branchStats: Record<string, { files: number; insertions: number; deletions: number }> = {
  [WT("5101-orgDropdowns")]: { files: 3, insertions: 214, deletions: 38 },
  [WT("5102-quickViewFreeze")]: { files: 1, insertions: 12, deletions: 4 },
  [WT("5110-donor-entities")]: { files: 5, insertions: 340, deletions: 0 },
};
const lastReplies: Record<string, string> = {
  s1: "I'll store the choice per user and preselect it.",
  s2: "Adding GET/PUT /api/users/me/last-org with its tests.",
  s3: "Added tests/api/test_last_org.py: 4 tests, all passing.",
  s5: "The tag list re-renders on every keystroke; memoizing it fixes the freeze.",
  s7: "Two tickets in progress (#5101, #5102) and one PR waiting on review.",
  s8: "Org pickers now open on the org you used last.",
  y1: "Added Donor and Gift with a one-to-many relation.",
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
// room roles: you own 5101 with Nick its admin; Nick owns 5110. ?claim: Nick hasn't been heard from in 5110 for 15 days,
// so you (its longest-standing member, with no admins) may claim it; ?claim=contest: Nick claimed 5101 from you while you were away
const claimQuery = teamQuery.get("claim");
const rolesOf5101: Pick<TeamRoomSummary, "owner" | "admins" | "claim" | "claimOpensAt"> =
  claimQuery === "contest" ? { owner: NICK, admins: [], claim: { from: ME, by: NICK, at: now - 2 * 60 * min }, claimOpensAt: null } : { owner: ME, admins: [NICK], claimOpensAt: null };
const rolesOf5110: Pick<TeamRoomSummary, "owner" | "admins" | "claim" | "claimOpensAt"> = { owner: NICK, admins: [], claimOpensAt: claimQuery === null || claimQuery === "contest" ? now + 9 * 24 * 60 * min : now - 24 * 60 * min };
const team: TeamStatus = {
  self: { id: ME, name: "You", fingerprint: fp(ME) },
  signalingUrl: SIGNAL,
  rooms: [
    {
      id: "R5101aaaaaaaaaaaaaaaaa", name: "#5101 Org dropdowns remember the last org", groupKey: "5101", members: [{ id: ME, name: "You", self: true }, { id: NICK, name: "Nick Smith", self: false }, { id: SAM, name: "Sam", self: false }], ...rolesOf5101, admin: ME, creator: ME, former: [{ id: ALEX, name: "Alex" }], online: [NICK], signalingUrl: SIGNAL, signaling: "online", workerRevoke, workerApprove,
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
      id: "R5110bbbbbbbbbbbbbbbbb", name: "#5110 Donor entities", groupKey: "5110", members: [{ id: NICK, name: "Nick Smith", self: false }, { id: ME, name: "You", self: true }], ...rolesOf5110, admin: NICK, creator: NICK, former: [], online: [NICK], signalingUrl: SIGNAL, signaling: "online", workerRevoke, workerApprove,
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
// ?lsHelpdeskRoom: 5110's room is on the Helpdesk area, where the Helpdesk tasks workspace is then refused (presetStart)
if (teamQuery.has("lsHelpdeskRoom")) team.rooms[1].groupKey = HELPDESK_GROUP;
/** The Helpdesk tasks workspace is being started (presetStart), as main keeps it: another start meanwhile is refused. */
let tasksStarting = false;
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
  // area 5102's on this Mac (it isn't a room)
  tagNotes: artId("Atagnotes"), trace: artId("Atrace"), perf: artId("Aperf"),
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
  branch: houseTickets[n].claim?.branch ?? null,
  links: n === 146 ? [{ label: "Support thread", url: "https://support.example.org/t/8812" }] : [],
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
// an area's artifacts on this Mac (area:<key>, main's areaArtifacts.ts): 5102 keeps three, any other area none yet
const AREA_SELF = "you";
const mine = (over: Omit<Parameters<typeof art>[0], "addedBy">) => art({ ...over, addedBy: AREA_SELF, addedByName: "You" });
artTexts[ART.tagNotes] = "# Tag list profile\n\n- Typing in the tag filter re-renders every row\n- Memoizing `TagRow` keeps a key under 16 ms\n";
artifactRooms["area:5102"] = {
  roomId: "area:5102",
  self: AREA_SELF,
  items: [
    mine({ id: ART.tagNotes, kind: "note", name: "Tag list profile", addedAt: now - 2 * 60 * min, rev: "r-tag-1", chars: artTexts[ART.tagNotes].length }),
    mine({ id: ART.trace, kind: "file", name: "quick-view-trace.png", addedAt: now - 90 * min, size: 212 * KB, local: present("image", "image/png") }),
    mine({ id: ART.perf, kind: "link", name: "React profiler docs", addedAt: now - 5 * 60 * min, url: "https://react.dev/reference/react/Profiler", host: "react.dev" }),
  ],
  notices: [],
  problems: [],
};
const artBytes: Record<string, Uint8Array> = {};
const artifactsChanged = (roomId: string) => emit("onArtifactsChanged", roomId);
// ?areaReadOnly=<key>: that area's artifacts file was written by a newer Mockingbird, so its shelf can't be changed
const AREA_READ_ONLY = new URLSearchParams(location.search).get("areaReadOnly");
const readOnlyOf = (roomId: string) =>
  AREA_READ_ONLY && roomId === `area:${AREA_READ_ONLY}` ? `/Users/you/.mockingbird/artifacts/areas/${AREA_READ_ONLY}/area.json was written by a newer Mockingbird (its version 2, this one reads 1): update Mockingbird to change this area's artifacts` : null;
const artifactRoom = (roomId: string) =>
  artifactRooms[roomId] ??
  (roomId.startsWith("area:") || team.rooms.some((r) => r.id === roomId) ? (artifactRooms[roomId] = { roomId, self: roomId.startsWith("area:") ? AREA_SELF : ME, items: [], notices: [], problems: [] }) : null);
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
// ?olderSam: Sam (offline) runs a Mockingbird from before offline take-overs, so his session can't be taken over until he's back; ?refused: Nick's older Mockingbird took over s2 without your hand-over
const olderSam = teamQuery.has("olderSam");
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
      offlineTakeover: false,
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
      mine({
        sessionId: "s1",
        latest: { sha: sha("e5"), takenAt: now - 1 * min },
        push: { ok: true, at: now - 1 * min, sha: sha("e5") },
        pushed: { sha: sha("e5"), takenAt: now - 1 * min, at: now - 1 * min },
        heldBy: ["Nick Smith"],
        // ?husky: its repository's hooks are Husky's, in the working tree, so the backup push ran no pre-push
        ...(teamQuery.has("husky") ? { prePushSkipped: { folder: ".husky/_", note: "pre-push in .husky/_ not run for backups: hooks in the working tree can be changed by the session" } } : {}),
      }),
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
        // Sam is offline: his session can be taken over without asking (?olderSam: his Mockingbird is too old for that)
        offlineTakeover: !olderSam,
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
      // ?backupConsent: you haven't answered whether your own 5101 sessions back up to origin, so the window asks
      { roomId: "R5101aaaaaaaaaaaaaaaaa", toOrigin: !p2p, consent: teamQuery.has("backupConsent") ? null : true, changed: { byName: "You", self: true, at: now - 3 * 24 * 60 * min }, adminName: "You", canChange: true, remote: "Azure DevOps" },
      { roomId: "R5110bbbbbbbbbbbbbbbbb", toOrigin: false, consent: null, changed: null, adminName: "Nick Smith", canChange: false, remote: "GitHub" },
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
    refused: teamQuery.has("refused")
      ? [{ roomId: "R5101aaaaaaaaaaaaaaaaa", sessionId: "s2", title: "#5101 — Org dropdowns: API", byName: "Nick Smith", at: now - 6 * min, why: "Nick Smith's Mockingbird needs to update to take over: take-overs now need You's signed hand-over" }]
      : [],
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
// team rooms: the audit log of remote actions, newest first (Settings → Team → Recent remote activity)
const auditEntries: AuditEntry[] = [
  { at: now - 2 * min, kind: "input", room: "#5101 Org dropdowns", member: "Nick Smith", session: "s1", title: "Org dropdowns remember the last org", n: 38, bytes: 214, since: now - 9 * min },
  { at: now - 9 * min, kind: "typing.allowed", room: "#5101 Org dropdowns", member: "Nick Smith", session: "s1", title: "Org dropdowns remember the last org", until: now + 6 * min },
  { at: now - 10 * min, kind: "typing.asked", room: "#5101 Org dropdowns", member: "Nick Smith", session: "s1", title: "Org dropdowns remember the last org" },
  { at: now - 14 * min, kind: "input.refused", room: "#5101 Org dropdowns", member: "Nick Smith", session: "s2", title: "API: last org per user", n: 2, bytes: 2, reason: "prompt", since: now - 14 * min },
  { at: now - 22 * min, kind: "message", room: "#5101 Org dropdowns", member: "Nick Smith", session: "s8", title: "Release notes for #5101", from: "Donor export: CSV writer", bytes: 412, outcome: "delivered" },
  { at: now - 41 * min, kind: "artifact.served", room: "#5101 Org dropdowns", member: "Sam", title: "org-dropdown-spec.pdf", n: 4, bytes: 1_843_200, since: now - 41 * min },
  { at: now - 63 * min, kind: "backup.sent", room: "#5101 Org dropdowns", member: "Nick Smith", session: "s1", title: "Org dropdowns remember the last org", n: 3, bytes: 88_000, since: now - 80 * min },
  { at: now - 3 * 60 * min, kind: "takeover", room: "#5110 Donor entities", member: "Nick Smith", session: "y1", title: "Donor entity model" },
];

// phone alerts (Settings → Notifications): ?phone=on (alerts on, replies off) · replies (reading works, an
// alert waiting for a reply) · nofda (replies on, Full Disk Access not granted) · denied (Messages refused
// the last alert: Automation not allowed) · dev (a development build). Absent: off, as a fresh install is.
const phoneQ = new URLSearchParams(location.search).get("phone");
const phoneOn = !!phoneQ;
const phoneReplies = phoneQ === "replies" || phoneQ === "nofda" || phoneQ === "dev";
if (phoneQ === "replies") {
  auditEntries.unshift(
    { at: now - 3 * min, kind: "phone.reply", session: "s2", title: "API: last org per user", outcome: "allow once" },
    { at: now - 6 * min, kind: "phone.alert", session: "s2", title: "API: last org per user", n: 1, bytes: 132, outcome: "sent" }
  );
}
let phoneStatus: PhoneStatus = {
  away: phoneOn ? { away: true, why: "locked", idleSeconds: 0 } : { away: false, why: null, idleSeconds: 40 },
  last:
    phoneQ === "denied"
      ? { at: now - 6 * min, ok: false, detail: "Mockingbird isn't allowed to control Messages. Allow it in System Settings → Privacy & Security → Automation → Mockingbird → Messages.", test: false }
      : phoneOn
        ? { at: now - 6 * min, ok: true, detail: "About “API: last org per user”", test: false }
        : null,
  replies: !phoneReplies
    ? { state: "off", detail: "" }
    : phoneQ === "nofda"
      ? { state: "no-access", detail: "macOS won't let Mockingbird read Messages: grant it Full Disk Access in System Settings → Privacy & Security → Full Disk Access, then check again." }
      : phoneQ === "dev"
        ? { state: "dev", detail: "A development build never reads Messages: replies work in the installed app." }
        : { state: "ok", detail: "" },
  open: phoneQ === "replies" ? 1 : 0,
  dev: phoneQ === "dev",
};

const samGrant: TakeoverPlan["grant"] = olderSam
  ? { kind: "none", why: "Sam's Mockingbird needs an update (1.6.0) before their sessions can be taken over while they're offline. Take it over once Sam is back online: they're asked to hand it over." }
  : { kind: "offline" };
const takeoverPlans: Record<string, TakeoverPlan> = {
  n1: { roomId: "R5101aaaaaaaaaaaaaaaaa", sessionId: "n1", title: "Donor export: CSV writer", agent: "claude", branch: "5101-csvExport", ownerName: "Nick Smith", ownerOnline: true, originUrl: "https://dev.azure.com/acme/Backoffice/_git/backoffice", clone: REPO, snapshot: { sha: "a1".repeat(20), takenAt: now - 2 * min, source: p2p ? "peer" : "origin", skipped: [], filtered: [] }, other: null, toOrigin: !p2p, originProblem: null, latestMissing: false, conversation: { kind: "full", bytes: 412_000 }, resumesOwn: false, grant: { kind: "ask" } },
  // ?p2p: only the copy that reached this Mac half an hour ago, a turn behind Sam's laptop
  m1: p2p
    ? { roomId: "R5101aaaaaaaaaaaaaaaaa", sessionId: "m1", title: "Last-org API tests", agent: "codex", branch: "5101-api-tests", ownerName: "Sam", ownerOnline: false, originUrl: "https://dev.azure.com/acme/Backoffice/_git/backoffice", clone: REPO, snapshot: { sha: "c3".repeat(20), takenAt: now - 31 * min, source: "peer", skipped: [], filtered: [] }, other: null, toOrigin: false, originProblem: null, latestMissing: true, conversation: { kind: "partial", have: 640_000, of: 980_000 }, resumesOwn: false, grant: samGrant }
    : { roomId: "R5101aaaaaaaaaaaaaaaaa", sessionId: "m1", title: "Last-org API tests", agent: "codex", branch: "5101-api-tests", ownerName: "Sam", ownerOnline: false, originUrl: "https://dev.azure.com/acme/Backoffice/_git/backoffice", clone: REPO, snapshot: { sha: "b2".repeat(20), takenAt: now - 4 * min, source: "peer", skipped: [], filtered: [] }, other: { sha: "c3".repeat(20), takenAt: now - 31 * min, source: "origin" }, toOrigin: true, originProblem: null, latestMissing: false, conversation: { kind: "partial", have: 640_000, of: 980_000 }, resumesOwn: false, grant: samGrant },
  // 5110 keeps backups peer to peer: what Nick's laptop sent while connected
  n7: { roomId: "R5110bbbbbbbbbbbbbbbbb", sessionId: "n7", title: "Donor entity model", agent: "claude", branch: "5110-donor-entities", ownerName: "Nick Smith", ownerOnline: true, originUrl: "git@github.com:acme/donors.git", clone: REPO, snapshot: { sha: "d5".repeat(20), takenAt: now - 3 * min, source: "peer", skipped: [], filtered: [] }, other: null, toOrigin: false, originProblem: null, latestMissing: false, conversation: { kind: "full", bytes: 412_000 }, resumesOwn: false, grant: { kind: "ask" } },
};
const takeoverChanged = () => emit("onTeamTakeoverChanged", JSON.parse(JSON.stringify(takeoverView)));
const inviteCode = (roomId: string) => `MBR1-${btoa(JSON.stringify({ r: roomId, u: SIGNAL, t: Math.random().toString(36).slice(2), f: ME, n: "preview" })).replace(/=+$/, "")}`;

// team rooms: live panes — Nick's session in the shared 5101 room, shown here as a copy;
// he has your s1 open and is in it. 5101's own sessions are room sessions: the terminal,
// and the Codex one on a Codex too old for the room's permission profile, run without
// the secret deny rules, and say so.
const ROOM_5101 = "R5101aaaaaaaaaaaaaaaaa";
const teamTypingQ = new URLSearchParams(location.search);
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
      // view-only here; ?typingRefused: you just typed into it
      room: roomTag({
        sessionId: "n1", owner: NICK, ownerName: "Nick Smith", remote: true, cols: 110, rows: 30, git: nickGit, lookers: [{ id: NICK, name: "Nick Smith", focused: false }],
        typing: { state: "view-only", ...(teamTypingQ.has("typingRefused") ? { refused: { at: Date.now() + 60 * min, why: "Nick Smith hasn't allowed typing" } } : {}) },
      }),
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
    // Nick may type in s1 for a few more minutes; ?typingAsk: he's asking to type in s8, and ?typingAsk2 in s2 too, a
    // moment before
    s1: roomTag({ sessionId: "s1", lookers: [{ id: NICK, name: "Nick Smith", focused: true }], typists: [{ member: NICK, name: "Nick Smith", until: now + 12 * min, at: now - 3 * min }] }),
    s2: roomTag({ sessionId: "s2", ...(teamTypingQ.has("typingAsk2") ? { typingAsks: [{ member: NICK, name: "Nick Smith", at: now - 21_000 }] } : {}) }),
    s3: roomTag({ sessionId: "s3", guards: { secrets: false, coauthors: true } }),
    s4: roomTag({ sessionId: "s4", guards: { secrets: false, coauthors: true } }),
    s8: roomTag({ sessionId: "s8", ...(teamTypingQ.has("typingAsk") ? { typingAsks: [{ member: NICK, name: "Nick Smith", at: now - 20_000 }] } : {}) }),
    y1: roomTag({ roomId: ROOM_5110, sessionId: "y1", live: true, takenOver: { by: NICK, byName: "Nick Smith", at: now - 12 * min } }),
  },
  // ?samView: Sam, a member of 5101's room only, connected and showing his session too (someone to follow there, never in 5110)
  views: [{ member: NICK, name: "Nick Smith", shown: ["s1", NICK_PANE], focused: "s1", at: now }, ...(new URLSearchParams(location.search).has("samView") ? [{ member: SAM, name: "Sam", shown: [SAM_PANE], focused: SAM_PANE, at: now }] : [])],
  problems: [],
};
buffers[SAM_PANE] = `${C.dim}codex${C.reset}\r\n› Cover the last-org endpoint's error cases\r\n\r\n• Added 3 tests for 404 and 403\r\n`;
buffers[remotePaneId(NICK, "n7")] = `${C.bold}> Carry on with the donor entity: add the gift aid flag${C.reset}\r\n\r\n${C.teal}⏺${C.reset} Update(src/donors/entity.ts)\r\n`;
buffers[NICK_PANE] = `${C.bold}> Write the donor CSV export (UTF-8 BOM, one row per gift)${C.reset}\r\n\r\n${C.teal}⏺${C.reset} Write(src/donors/exportCsv.ts)\r\n  ⎿  Wrote 64 lines\r\n\r\n${C.amber}✻${C.reset} Running the export tests… ${C.dim}(18s · esc to interrupt)${C.reset}\r\n`;

// ?landscapeMany=<n>: the landscape holds n workspaces of yours and nothing else, in areas of
// six: agents with a screenful of transcript each and terminals with test output, a third of them working, whose
// spinner lines redraw a few times a second as Claude Code's do. For what many terminals cost (?landscapePerf) and
// which of them get an xterm where.
const manyQ = Math.max(0, Math.min(60, Math.floor(Number(new URLSearchParams(location.search).get("landscapeMany")) || 0)));
const MANY_PER_AREA = 6;
if (manyQ) {
  const tasks = ["Org dropdowns remember the last org", "Donor CSV export", "Receipt PDFs cut off long names", "Login redirect loops on Safari", "Tag filter freezes the quick view", "Gift aid flag on donors", "Archived donors skip the export", "Portal users get key pairs", "Pathways list paginates", "Audit log for role changes"];
  const files = ["src/org/Dropdown.tsx", "src/donors/exportCsv.ts", "src/receipts/pdf.ts", "src/auth/redirect.ts", "src/pathways/QuickView.tsx", "src/donors/entity.ts", "src/api/orgs.py", "src/portal/keys.ts"];
  const agentScreen = (i: number) => {
    const out = [`${C.bold}> ${tasks[i % tasks.length]}: start from the failing case${C.reset}`, ""];
    for (let k = 0; k < 7; k++) {
      const f = files[(i + k) % files.length];
      out.push(`${C.teal}⏺${C.reset} Read(${f})`, `  ⎿  Read ${40 + ((i * 7 + k * 13) % 160)} lines`, "");
      out.push(`${C.teal}⏺${C.reset} Update(${f})`, `  ⎿  Updated ${f} with ${2 + ((i + k) % 9)} additions and ${(i * k) % 4} removals`);
      out.push(`      ${30 + k}  ${C.red}-  const value = load(${k});${C.reset}`, `      ${30 + k}  ${C.green}+  const value = load(${k}) ?? fallback(${k});${C.reset}`, "");
    }
    out.push(`${C.teal}⏺${C.reset} ${tasks[(i + 3) % tasks.length]} next: the tests cover it now.`, "");
    return out.join("\r\n");
  };
  const shellScreen = (i: number) =>
    [`you@mac backoffice % npm test -- ${files[i % files.length]}`, "", ...files.map((f, k) => ` ${k === i % 5 ? `${C.red}✗` : `${C.green}✓`}${C.reset} ${f.replace(/\.tsx?$|\.py$/, ".test.ts")} (${3 + k})`), "", ` Test Files  ${files.length} run`, `      Tests  ${40 + i} passed`, ""].join("\r\n");
  sessions = Array.from({ length: manyQ }, (_, i) => {
    const id = `w${String(i + 1).padStart(2, "0")}`;
    const shell = i % 5 === 4;
    const agent = shell ? undefined : i % 4 === 1 ? ("codex" as const) : ("claude" as const);
    const status = i % 7 === 3 && !shell ? ("waiting" as const) : i % 3 === 0 ? ("working" as const) : ("idle" as const);
    buffers[id] = shell ? shellScreen(i) : agentScreen(i);
    return session(id, {
      title: shell ? `tests ${i + 1}` : tasks[i % tasks.length], taskGroup: `60${Math.floor(i / MANY_PER_AREA) + 1}`, shell, agent, status, branch: `60${Math.floor(i / MANY_PER_AREA) + 1}-task${i + 1}`, cwd: WT(`task${i + 1}`), createdAt: now - (i + 1) * min,
      ...(status === "waiting" ? { waitingReason: "Claude needs your permission to use Bash", waitingSince: now - 2 * min } : {}),
    });
  });
  live.remote = [];
  live.own = {};
  live.views = [];
  // the working agents' status lines, redrawn in place as Claude Code's spinner is
  const spin = ["·", "✢", "✳", "✶", "✻", "✽"];
  let tick = 0;
  setInterval(() => {
    tick++;
    for (const s of sessions) {
      if (s.status !== "working" || s.shell) continue;
      const text = `\r\x1b[2K${C.amber}${spin[tick % spin.length]}${C.reset} Working… ${C.dim}(${Math.floor((tick * 120) / 1000)}s · esc to interrupt)${C.reset}`;
      buffers[s.id] += text;
      emit("onSessionData", s.id, text);
    }
  }, 120);
}

/** As main's relaunchGuard (takeover.relaunchRefusal): why a copy a teammate continues doesn't run again here, or null. */
function takenOverRefusal(id: string): string | null {
  const t = live.own[id]?.takenOver;
  const title = byId(id)?.title ?? previous.find((p) => p.id === id)?.title ?? id;
  return t ? `“${title}” continues on ${t.byName}'s laptop — take it back rather than running this copy again` : null;
}

// ---- the landscape: three areas, 5101 holding the 5101/api stack and Nick's session, a ghost in 5102, the assistant loose ----

const landscapeFixture = (): Landscape => {
  const l = emptyLandscape();
  l.migratedAt = new Date(now - 2 * 24 * 60 * min).toISOString();
  l.tourDone = true;
  const M = presetSize("agent");
  const everyone = [...sessions, ...previous, ...planned, ...live.remote];
  /** An area two M workspaces wide at (x, y): `ids` in reading order (a stack once, its first member in front), closed ones' (ghosts') too. */
  const area = (key: string, x: number, y: number, ids: string[]): Area => {
    const inside: Rect[] = [];
    let frame: Area = { x, y, w: 2 * AREA_PAD + 2 * M.w + GAP, h: AREA_PAD, repos: [{ path: REPO, base: "dev" }] };
    // grown for each, as placeNew needs: its next row starts below what's in the area
    const put = (size: { w: number; h: number }) => {
      const p = placeNew(size, inside, frame);
      inside.push(p);
      frame = fitAreaTo(frame, [p]);
      return p;
    };
    for (const id of ids) {
      const s = everyone.find((x) => x.id === id)!;
      const stack = stackKeyOf(s);
      if (!stack) l.workspaces[id] = put(presetSize(kindOf(s)));
      else l.stacks[stack] ??= { active: id, placement: put(presetSize(kindOf(s))) };
    }
    return (l.areas[key] = fitAreaTo(frame, inside));
  };
  if (manyQ) {
    // three areas to a row
    let x = 0;
    let y = 0;
    let rowH = 0;
    for (let a = 0; a * MANY_PER_AREA < sessions.length; a++) {
      if (a && a % 3 === 0) {
        x = 0;
        y += rowH + AREA_GAP;
        rowH = 0;
      }
      const made = area(`60${a + 1}`, x, y, sessions.slice(a * MANY_PER_AREA, (a + 1) * MANY_PER_AREA).map((s) => s.id));
      x += made.w + AREA_GAP;
      rowH = Math.max(rowH, made.h);
    }
    // ?lsWindows: each area's Run window on its first agent and its Artifacts window, placed by the layout, so
    // ?landscapePerf counts tool windows too
    if (new URLSearchParams(location.search).has("lsWindows"))
      for (const key of Object.keys(l.areas)) {
        const first = sessions.find((s) => s.taskGroup === key && !s.shell);
        if (first) l.tools[`run-${key}`] = { tool: "run", docked: false, session: first.id, area: key };
        l.tools[`art-${key}`] = { tool: "artifacts", docked: false, area: key };
      }
    return l;
  }
  const a5101 = area("5101", 0, 0, ["s1", "s2", "s3", SAM_PANE, NICK_PANE, "s4", "s8", "g2"]);
  const a5102 = area("5102", a5101.w + AREA_GAP, 0, ["s5", "s6", "g1"]);
  area("5110", a5102.x, a5102.y + a5102.h + AREA_GAP, ["y1", remotePaneId(NICK, "n7")]);
  if (wireBoard) placeWireBoard(l, a5101.x, a5101.y + a5101.h + AREA_GAP, REPO);
  // the assistant is ungrouped: loose, next to the first area, and p1's ghost beside it
  const placed = [...Object.values(l.areas), ...Object.values(l.workspaces)];
  l.workspaces.s7 = placeNew(M, placed, null, a5101);
  l.workspaces.p1 = placeNew(M, [...placed, l.workspaces.s7], null, a5101);
  // ?lsUnplaced=<id,…>: those have no place, as sessions closed off the landscape (closed ones go to the Closed sessions list)
  for (const id of new URLSearchParams(location.search).get("lsUnplaced")?.split(",") ?? []) delete l.workspaces[id];
  // ?lsWindows: tool windows and an artifact card (S5), placed by the layout where the file has no place for them, as
  // after a rename merged their area: Run on s1 in 5101, 5102's Artifacts and a card of its note, and Search docked
  if (new URLSearchParams(location.search).has("lsWindows")) {
    l.tools = {
      w1: { tool: "run", docked: false, session: "s1", area: "5101" },
      w2: { tool: "artifacts", docked: false, area: "5102" },
      w3: { tool: "search", docked: true },
    };
    l.cards = { c1: { area: "5102", shelf: "area:5102", artifact: ART.tagNotes } };
  }
  return l;
};
let landscape = landscapeFixture();
// ?lsCollapsed=<key,…> and ?lsLocked=<key,…>: those areas collapsed to pills, or locked, as the file has them
for (const [q, flag] of [["lsCollapsed", "collapsed"], ["lsLocked", "locked"]] as const)
  for (const key of new URLSearchParams(location.search).get(q)?.split(",") ?? []) if (Object.hasOwn(landscape.areas, key)) landscape.areas[key][flag] = true;
let landscapeRev = 0;
// ?landscape=corrupt: landscape.json wasn't JSON at start, so it was moved aside and the layout starts over;
// =unreadable: reading it failed, so an empty stand-in is shown, and the file is read again with each get or update
// as main does: it reads once a script sets window.__lsFileReadable, bringing the fixture's layout back and dropping
// changes made to the stand-in, with a problem saying so (?lsRereadMs=<ms> shortens how often the window asks);
// =fresh: there's no landscape.json yet, so the grid's layout is read in the first time the landscape is shown
const LANDSCAPE_FILE = "/Users/you/.mockingbird/landscape.json";
const landscapeQ = new URLSearchParams(location.search).get("landscape");
const lsReadInFails = new URLSearchParams(location.search).has("lsReadInFails");
let readInRefused = false;
let standIn = landscapeQ === "unreadable";
let standInChanges = 0;
/** The file read again while only a stand-in is held, as LandscapeStore.load does; `pending` are changes in hand made against the stand-in. */
const readAgain = (pending: number) => {
  if (!standIn || !w.__lsFileReadable) return;
  standIn = false;
  const dropped = standInChanges + pending;
  const what = `${dropped} layout change${dropped === 1 ? "" : "s"} made to the empty stand-in while it couldn't be read`;
  landscape = landscapeFixture();
  landscapeProblems = dropped ? [{ kind: "dropped", message: `${LANDSCAPE_FILE} could be read again, and its layout is back. Dropped: ${what}.`, file: LANDSCAPE_FILE }] : [];
  landscapeRev++;
  emit("onLandscapeChanged", clone({ rev: landscapeRev, patch: null, landscape, problems: landscapeProblems }));
};
const lsHold = new URLSearchParams(location.search).has("lsHold");
// ?lsRelaunchFails=<id,…>: each one's first relaunch answers an error, as main's does when its launch fails, and its
// second throws (a broken call); later ones go through
const relaunchFails = new Map((new URLSearchParams(location.search).get("lsRelaunchFails")?.split(",") ?? []).map((id) => [id, 0]));
let closedReadFails = Number(new URLSearchParams(location.search).get("lsClosedReadFails") ?? 0);
let goneReadFails = Number(new URLSearchParams(location.search).get("lsGoneReadFails") ?? 0);
// ?lsBigResume=<id,…>: resuming those costs a lot too, so Reopen asks first (as s6 always does)
const bigResume = new Set(new URLSearchParams(location.search).get("lsBigResume")?.split(",") ?? []);
const rereadMs = Number(new URLSearchParams(location.search).get("lsRereadMs"));
if (rereadMs > 0) w.__mbLandscapeRereadMs = rereadMs;
// ?teamLiveFail: reading teammates' room sessions fails the first time (=always: until a script calls
// window.__mbTeamLiveBack(), which also sends them as main would once team rooms come up)
const teamLiveFails = new URLSearchParams(location.search).has("teamLiveFail") ? new URLSearchParams(location.search).get("teamLiveFail") || "once" : null;
let teamLiveCalls = 0;
let teamLiveBack = false;
w.__mbTeamLiveBack = () => {
  teamLiveBack = true;
  emit("onTeamLive", clone(live));
};
let landscapeProblems: LandscapeProblem[] =
  landscapeQ === "corrupt"
    ? [{ kind: "corrupt", message: `${LANDSCAPE_FILE} isn't valid JSON (Unexpected end of JSON input). It was moved to ${LANDSCAPE_FILE}.bad-1730000000000, and the layout starts over.`, file: LANDSCAPE_FILE, movedTo: `${LANDSCAPE_FILE}.bad-1730000000000` }]
    : landscapeQ === "unreadable"
      ? [{ kind: "unreadable", message: `${LANDSCAPE_FILE} couldn't be read (EMFILE: too many open files). It's left as it is and read again with the next change; until then the layout is an empty stand-in, and changes to it aren't saved.`, file: LANDSCAPE_FILE, readOnly: true }]
      : [];
if (landscapeProblems.length || landscapeQ === "fresh") landscape = emptyLandscape();
// ?lsOnly=nothing|ghosts|closed|windows|docked|area: no session running, and only that: nothing at all (with ?landscape=fresh,
// a fresh install), two loose ghosts, two closed sessions with no place (the Closed list), a placed tool window, a docked
// one, or an area with nothing in it
const lsOnly = new URLSearchParams(location.search).get("lsOnly");
if (lsOnly) {
  const closed = previous.filter((p) => p.id === "p1" || p.id === "o1").map((p): SessionInfo => ({ ...p, taskGroup: null }));
  sessions = [];
  live.remote = [];
  previous = lsOnly === "ghosts" || lsOnly === "closed" ? closed : [];
  if (landscapeQ !== "fresh") {
    landscape = emptyLandscape();
    landscape.migratedAt = new Date(now - 2 * 24 * 60 * min).toISOString();
  }
  const M = presetSize("agent");
  // far from the origin, so they're in view only if the first fit went by them
  if (lsOnly === "ghosts") closed.forEach((p, i) => (landscape.workspaces[p.id] = { x: 6000 + i * (M.w + GAP), y: 4000, ...M }));
  if (lsOnly === "windows") landscape.tools.t1 = { tool: "files", docked: false, placement: { x: 6000, y: 4000, w: 360, h: 640 } };
  if (lsOnly === "docked") landscape.tools.t1 = { tool: "files", docked: true };
  if (lsOnly === "area") landscape.areas.spare = { x: 6000, y: 4000, w: 900, h: 600, repos: [] };
}
// the tour is S8's own to show: a fixture has seen it unless ?lsTour says otherwise (with ?landscape=fresh, the real first run)
landscape.tourDone = new URLSearchParams(location.search).has("lsTour") ? undefined : true;
if (landscape.tourDone === undefined) delete landscape.tourDone;
// ?lsListFail=<n>: the first n reads of the session list fail, as main's would
let listReadFails = Number(new URLSearchParams(location.search).get("lsListFail") ?? 0);
// ?lsTourSaveFails: saving that the tour has been seen is refused, as main's would be with the disk full
const tourSaveFails = new URLSearchParams(location.search).has("lsTourSaveFails");
// ?lsMigrateFails: reading the grid's layout in is refused (its patch, the one setting migratedAt), so it stays undone
const migrateFails = new URLSearchParams(location.search).has("lsMigrateFails");
// ?lsPersist: the landscape kept in sessionStorage, read back through the file's own checks (parseLandscape) when the
// page reloads, as main reads landscape.json when the app starts again
const LS_KEPT = "mb.preview.landscape";
const lsPersist = new URLSearchParams(location.search).has("lsPersist");
if (lsPersist) {
  const kept = sessionStorage.getItem(LS_KEPT);
  if (kept) landscape = parseLandscape(JSON.parse(kept));
}

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

// ?councilTickets: the council's plan is written up and approved, and its "Create House tickets…" opens. Its repo is
// in room #5101, whose project is atticus-backoffice (=consent: your token isn't allowed for it yet; =projects: not in
// a room, two projects with token files; =prose: a plan with no steps to split by). ?councilTicketsFail: the fixture
// House refuses the second ticket. Nothing reaches a House: the tickets are numbered here from #160.
const ticketsQ = new URLSearchParams(location.search);
const ticketsMode = ticketsQ.get("councilTickets") ?? ticketsQ.get("councilTicketsAudit");
// ?councilPlan: the same approved plan, with the Council's panel open on it and its implement menu (W18: the plan's
// Orchestrator). =open: its Orchestrator has started, so the panel offers to open it.
const councilPlanMode = ticketsQ.get("councilPlan");
const TICKETS_PLAN = `## Goal
Export the donor list to CSV, respecting the user's filters, for up to 200k rows.

## Steps to implement
1. **Streaming endpoint** — GET /api/donors/export.csv takes the list's filter DTO and streams rows as they're read (high).
   - Acceptance: every filter the list has is honoured
   - Acceptance: 200k rows stream without buffering the file
2. Page the donor query 5k rows at a time (high)
   Keyset pagination on (org_id, id).
3. Export button in the donor list toolbar
4. Timing check on the largest org
   - Acceptance: a note with the timing on the ticket
5. Spike: background export job, only if the timing check times out

## Risks
- Timeouts behind the load balancer`;
if (ticketsMode !== null || councilPlanMode !== null) {
  const k1 = councils[0];
  const text = ticketsMode === "prose" ? "Stream the export for everyone, measure the biggest org, and add a background job only if it times out." : TICKETS_PLAN;
  k1.messages.push({ id: "m6", speaker: "opus", round: 2, at: now - 3_000_000, kind: "plan", text });
  k1.messages.push({ id: "m7", speaker: "system", round: 2, at: now - 2_900_000, text: "Plan approved: Claude Opus 5.5's write-up." });
  k1.plan = { text, by: "opus", approved: true, at: now - 2_900_000 };
  if (councilPlanMode === "open") {
    k1.implementedIn = "s1";
    k1.messages.push({
      id: "m8",
      speaker: "system",
      round: 2,
      at: now - 2_800_000,
      text: "Claude Opus 5.5 is the plan's Orchestrator, on branch collab-csv-export-for-the-donor-list-k1 in “Council — CSV export for the donor list”: it proposes the workspaces to build the plan, and nothing more is made until you lay them out.",
    });
  }
}
let ticketTargets: CouncilHouseTargets =
  ticketsMode === "projects"
    ? { inRoom: false, targets: [{ kind: "project", project: "atticus-backoffice", connection: "connected" }, { kind: "project", project: "radley-tools", connection: "consent" }] }
    : { inRoom: true, targets: [{ kind: "room", roomId: "R5101aaaaaaaaaaaaaaaaa", room: "#5101 Org dropdowns remember the last org", project: "atticus-backoffice", admin: "You", connection: ticketsMode === "consent" ? "consent" : "connected" }] };
let nextTicket = 160;
const councilById = (id: string) => councils.find((c) => c.id === id);
const councilChanged = (c: CollabRoom) => {
  emit("onCollabChanged", clone(c));
  return clone(c);
};
const councilNote = (c: CollabRoom, text: string) => c.messages.push({ id: `n${c.messages.length}`, speaker: "system", text, round: c.round, at: Date.now() });

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
/**
 * Where not-started step `p` starts and on which branch, as main's stepPlace says it (the preview has no commits:
 * 3f9c2a1 stands in for one), or why it can't.
 */
function stepStart(p: SessionInfo): { says: string; branch: string | null } | { refused: string } {
  const titled = (s: SessionInfo) => `“${s.title}”`;
  if (p.planned?.sharesWith) {
    const other = byId(p.planned.sharesWith);
    if (!other) return { refused: `${titled(p)} works in another session's folder, which isn't running in the preview` };
    const beside = other.status === "dead" ? `, where ${titled(other)} has exited` : `, while ${titled(other)} is ${other.status === "waiting" ? "waiting for you" : other.status}`;
    return { says: `It starts in ${titled(other)}'s folder, ${tildePath(other.cwd)}${other.branch ? `, on ${other.branch}` : ""}${beside}.`, branch: other.branch ?? null };
  }
  const repo = p.repoPath?.split("/").filter(Boolean).pop();
  if (!repo) return { says: "It starts in your home folder, with no repo.", branch: null };
  if (!p.planned?.worktree) return { says: `It starts in ${repo}'s checkout, on whatever's out there.`, branch: null };
  const from = Object.values(wireBook.links).find((w) => w.to === p.id && w.type === "handoff")?.from;
  const up = from ? byId(from) : undefined;
  const branch = `${up?.branch ?? "step"}-${stepSlug(p.title)}`;
  return { says: `It starts in a new worktree, ${branch}, ${up ? `at ${titled(up)}'s commit 3f9c2a1` : `at ${repo}'s HEAD, 3f9c2a1: nothing hands off to it`}.`, branch };
}
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
  const cleared = clearsGates(p.stage, stage) ? clearGateTicks(p) : null;
  p.stage = stage;
  p.history.push({ at: Date.now(), stage, by: "you", ...(cleared ? { note: cleared } : {}) });
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

/** How long a group rename's landscape change trails its sessions' (an audit sets it; 0: at once). */
let renameLag = 0;

/** ?createMs=<ms>: main takes this long to start a session (createSession, relaunchSession), as a slow Mac's does. */
const startLag = () => new Promise<void>((r) => setTimeout(r, Number(new URLSearchParams(location.search).get("createMs")) || 0));

/** How long a Check now takes to answer (none, but in ?landscapeNeedsAudit=w, which slows it to watch Mark merged… wait). */
const checkTakes = { ms: 0 };
const api: Record<string, (...a: any[]) => any> = {
  // sessions
  listSessions: async () => {
    if (listReadFails > 0) {
      listReadFails--;
      return err("sessions.json couldn't be read: EMFILE, too many open files");
    }
    return sessions.map((s) => ({ ...s }));
  },
  // as main's resumable(): the closed ones it keeps, never one running now
  resumableSessions: async () => {
    // ?lsClosedReadFails=<n>: the first n reads fail, as main's would with its store unreadable
    if (closedReadFails > 0) {
      closedReadFails--;
      return err("sessions.json couldn't be read: EMFILE, too many open files");
    }
    return previous.filter((p) => !sessions.some((s) => s.id === p.id)).map((p) => ({ ...p }));
  },
  // main's sessions:planned: the steps not started yet, never among the closed ones
  plannedSessions: async () => planned.filter((p) => !sessions.some((s) => s.id === p.id)).map((p) => ({ ...p })),
  // main's sessions:plan (WireService.addStep): refused before it's made when no handoff could leave `after`; made, then
  // wired, and forgotten again when the wire is refused
  planSession: async (req: PlanRequest) => {
    const title = String(req.title ?? "").trim();
    if (!title) return err("Name the step");
    if (req.taskGroup?.includes("/")) return err("A not-started step goes in an area, not a stack");
    const up = byId(req.after) ?? previous.find((p) => p.id === req.after) ?? planned.find((p) => p.id === req.after);
    if (!up) return err(`This Mac has no session "${req.after}" to add a step after`);
    const id = `pl${Date.now().toString(36)}`;
    const s: SessionInfo = {
      ...session(id, { title, agent: req.agent, taskGroup: req.taskGroup ?? req.ticketId ?? null, status: "idle", createdAt: Date.now(), branch: null }),
      repoPath: req.sharesFolder ? up.repoPath : req.repoPath,
      cwd: req.sharesFolder ? up.cwd : (req.repoPath ?? "/Users/you"),
      planned: { worktree: !req.sharesFolder && !!req.repoPath && req.worktree, ...(req.sharesFolder ? { sharesWith: up.id } : {}), ...(req.prompt?.trim() ? { prompt: req.prompt.trim() } : {}) },
    };
    planned = [...planned, s];
    const r: WireReply = await api.wiresAdd(req.after, id, "handoff");
    if ("refused" in r) {
      planned = planned.filter((p) => p.id !== id);
      return err(r.refused);
    }
    return s;
  },
  // main's sessions:describeStart: where Start now would start a step, as its confirm says it
  describeStart: async (id: string) => {
    const p = planned.find((x) => x.id === id);
    if (!p || byId(id)) return err("It has started already: reopen it instead");
    const at = stepStart(p);
    return "refused" in at ? err(at.refused) : at.says;
  },
  // main's sessions:startPlanned: the step started (previewStartPlanned), and what couldn't be done to its ticket's stage
  // (none here)
  startPlanned: async (id: string) => {
    const r = await api.previewStartPlanned(id);
    return "error" in r ? r : { info: r, stageWhy: null };
  },
  // started under its id, so its wires keep their ends; refused when it isn't one
  previewStartPlanned: async (id: string) => {
    await startLag();
    const p = planned.find((x) => x.id === id);
    if (!p || byId(id)) return err("It has started already: reopen it instead");
    const at = stepStart(p);
    if ("refused" in at) return err(at.refused);
    const { planned: _step, ...rest } = p;
    const next: SessionInfo = { ...rest, status: "working", createdAt: Date.now(), branch: at.branch };
    planned = planned.filter((x) => x.id !== id);
    sessions = [...sessions, next];
    buffers[id] = `${C.dim}(UI preview: the step would start here)${C.reset}\r\n> `;
    sessionsChanged();
    return next;
  },
  // main's sessions:closedOutput: a closed session's saved output (its scrollback), "" when it has none; a not-started
  // step has none, and main says so
  closedOutput: async (id: string) => (planned.some((p) => p.id === id) ? err(`${id} hasn't started, so it has no output`) : (closedOutput[id] ?? buffers[id] ?? "")),
  // main's sessions:missingFolders: the closed sessions whose folders are gone, and whether each still reopens
  // ?lsGoneReadFails=<n>: the first n reads fail
  missingFolders: async () => {
    if (goneReadFails > 0) {
      goneReadFails--;
      return err("sessions.json couldn't be read: EMFILE, too many open files");
    }
    return previous.filter((p) => goneFolders.has(p.id)).map((p) => ({ id: p.id, ...goneFolders.get(p.id)! }));
  },
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
    // ?setGroupFail=<id>: that session's group can't be set
    if (params.get("setGroupFail") === id) return err(`${id}'s group can't be set here`);
    // a live session or a closed one, as main's setGroup moves either
    sessions = sessions.map((s) => (s.id === id ? { ...s, taskGroup: group } : s));
    previous = previous.map((s) => (s.id === id ? { ...s, taskGroup: group } : s));
    sessionsChanged();
  },
  renameSession: async (id: string, title: string) => {
    sessions = sessions.map((s) => (s.id === id ? { ...s, title, ticketTitle: s.ticketTitle ? title : null } : s));
    sessionsChanged();
  },
  renameGroup: async (from: string, to: string) => {
    const members = sessions.filter((s) => areaKeyOf(s) === from).map((s) => s.id);
    const closed = previous.filter((p) => !sessions.some((s) => s.id === p.id)).map((p) => ({ id: p.id, taskGroup: p.taskGroup }));
    sessions = sessions.map((s) => (s.taskGroup === from || s.taskGroup?.startsWith(`${from}/`) ? { ...s, taskGroup: to + s.taskGroup.slice(from.length) } : s));
    // closed sessions too, as main's renameGroup remaps the stored ones
    previous = previous.map((s) => (s.taskGroup === from || s.taskGroup?.startsWith(`${from}/`) ? { ...s, taskGroup: to + s.taskGroup.slice(from.length) } : s));
    // the sessions' change goes out first, then the area's, as main's renameGroup sends them (LandscapeStore.groupRenamed);
    // an audit's renameLag holds the area's back that long, as a slow write would
    sessionsChanged();
    const rekey = () => {
      const patch = standIn ? null : renameAreaPatch(landscape, from, to, members, closed);
      if (patch) {
        landscape = applyPatch(landscape, patch);
        landscapeRev++;
        emit("onLandscapeChanged", clone({ rev: landscapeRev, patch, problems: landscapeProblems }));
      }
      // its artifacts on this Mac go with it, merged into `to`'s when it has some (main's AreaArtifacts.areaRenamed)
      const shelf = artifactRooms[`area:${from}`];
      if (shelf && !to.includes("/") && from !== to) {
        const into = artifactRooms[`area:${to}`];
        artifactRooms[`area:${to}`] = into ? { ...into, items: [...into.items, ...shelf.items.filter((a) => !into.items.some((m) => m.id === a.id))] } : { ...shelf, roomId: `area:${to}` };
        delete artifactRooms[`area:${from}`];
        artifactsChanged(`area:${from}`);
        artifactsChanged(`area:${to}`);
      }
    };
    if (renameLag) setTimeout(rekey, renameLag);
    else rekey();
  },
  // as main's kill: closed, it stays resumable (its place kept) unless it's forgotten
  killSession: async (id: string, forget: boolean) => {
    const s = byId(id);
    sessions = sessions.filter((x) => x.id !== id);
    previous = previous.filter((p) => p.id !== id);
    if (forget) planned = planned.filter((p) => p.id !== id);
    if (!forget && s && !s.room?.remote) previous = [...previous, { ...s, status: "dead" }];
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
    await startLag();
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
  // main's resume: a copy the window marks taken over is refused there too, before anything is undone
  resumeSession: async (id: string) => {
    const taken = takenOverRefusal(id);
    if (taken) return { refused: taken };
    const s = byId(id);
    // as main's resumeRefusal: only an exited pane here is resumed (relaunch refuses a running one)
    if (s && s.status !== "dead") return { refused: "It's running already" };
    const r = await api.relaunchSession(id);
    return r ?? err("Its saved record is gone, so there's nothing to resume: close the pane");
  },
  // a relaunch starts a new process under the same id, stamped with a new createdAt, as main's create() does; refused,
  // as main's is, for a copy a teammate continues (relaunchGuard) and for one that's running
  relaunchSession: async (id: string) => {
    await startLag();
    const taken = takenOverRefusal(id);
    if (taken) return err(taken);
    const running = byId(id);
    if (running && running.status !== "dead") return err("It's running already");
    // as main's relaunch: a not-started step has nothing to go back to
    const notYet = !running && planned.find((p) => p.id === id);
    if (notYet) return err(`“${notYet.title}” hasn't started yet: it starts when the handoff into it is sent, or with Start now in its menu`);
    const failed = relaunchFails.get(id);
    if (failed !== undefined && failed < 2) {
      relaunchFails.set(id, failed + 1);
      if (!failed) return err("Its terminal couldn't start: spawn /bin/zsh EAGAIN");
      throw new Error("the relaunch call broke off");
    }
    const p = previous.find((x) => x.id === id) ?? byId(id);
    if (!p) return null;
    // what main's create() starts it with: nothing of how its record last stood
    const next: SessionInfo = { ...p, status: "idle", exitCode: undefined, createdAt: Date.now(), finishedAt: null, waitingReason: null, waitingSince: null, waitingAt: null };
    sessions = [...sessions.filter((s) => s.id !== id), next];
    sessionsChanged();
    // main's LandscapeStore.sessionReopened: a place outside its own area goes
    const replaced = standIn ? null : reopenPatch(landscape, next);
    if (replaced) {
      landscape = applyPatch(landscape, replaced);
      landscapeRev++;
      emit("onLandscapeChanged", clone({ rev: landscapeRev, patch: replaced, problems: landscapeProblems }));
    }
    return next;
  },
  sessionRestart: async (id: string) => {
    const s = byId(id);
    if (!s) return err("Session is no longer running");
    return api.relaunchSession(id);
  },
  // as main's: each agent session relaunched in place (a new createdAt) unless it's busy, then the list sent once
  restartAllSessions: async (includeBusy: boolean) => {
    const restarted: string[] = [];
    const skipped: string[] = [];
    for (const s of [...sessions]) {
      if (s.shell || s.status === "dead") continue;
      if (!includeBusy && (s.status === "working" || s.status === "waiting")) {
        skipped.push(s.id);
        continue;
      }
      sessions = sessions.map((x) => (x.id === s.id ? { ...x, status: "idle" as const, createdAt: Date.now() } : x));
      restarted.push(s.id);
    }
    sessionsChanged();
    return { restarted, skipped, failed: [] };
  },
  // main's rule: idle panes are given it, busy ones queue it, terminals and debriefs never get it
  broadcast: async (req: { message: string; sessionIds: string[] }) =>
    (req.sessionIds.length ? req.sessionIds : sessions.filter((s) => s.kind === "work" && !s.shell).map((s) => s.id)).map((id) => {
      const s = byId(id);
      const outcome = !s || s.status === "dead" || s.shell || s.debrief ? "skipped" : s.status === "idle" ? "delivered" : "queued";
      return { id, outcome };
    }),
  // ?statusNotes: everything the status bar can say at once (a read that failed, a failed update and its outcome, the
  // hooks missing); =few: only the update's link and the hooks
  hooksInstalled: async () => !params.has("statusNotes"),
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
  metersGet: async () => (badgeFails.has("meters") ? err(METERS_FAIL) : meters),
  // context warnings: Compact goes only to an idle session (compactBlocker); then the context drops a moment later
  contextCompact: async (id: string) => {
    const s = byId(id);
    const why = s ? compactBlocker({ status: s.status, shell: !!s.shell }) : "The session isn't running";
    if (why) return later(err(why));
    setTimeout(() => {
      const c = contexts[id];
      if (c?.state === "reading") contexts[id] = { ...c, tokens: 41_200, at: Date.now(), cache: undefined };
    }, 1500);
    return later(undefined);
  },
  // the crashed session's conversation is big and cold: resuming it asks first; others go straight ahead
  resumeCost: async (id: string) =>
    later(
      id === "s6" || bigResume.has(id)
        ? { agent: "claude", estimate: rereadCost({ agent: "claude", model: "claude-opus-5-5", tokens: 380_000, cache: { warm: false, expiresAt: now - 3 * 60 * min }, now: Date.now(), unitsPerPct: 0.95 }) }
        : null
    ),
  contextBrief: async (id: string) =>
    later(
      {
        brief: `You're continuing "${byId(id)?.title ?? id}", a Claude session on this Mac whose conversation was getting close to its context limit. The user started you as a new session in the same worktree, from this brief rather than from the whole conversation.\n\n<handover>\n## Changed files (against origin/dev)\nsrc/QuickView.tsx | 40 ++++++------\n\n## Latest to-do list\n[completed] Reproduce the freeze\n[in_progress] Virtualize the pathway list\n</handover>\n\nFirst tell the user in one line what you understand the task to be and where it stands.`,
        agent: "claude",
        estimate: rereadCost({ agent: "claude", model: "claude-opus-5-5", tokens: 3_900, fresh: true, now: Date.now(), unitsPerPct: 0.95 }),
        replaces: contexts[id]?.state === "reading" ? (contexts[id] as { tokens: number }).tokens : null,
      },
      400
    ),
  contextBriefStart: async () => err("UI preview: no session starts"),
  // with ?cleanupConfirm, Close session's push as a team room session's on a branch with a base's name answers: it
  // waits for a say-so naming the branch, then goes
  worktreeCleanup: async (_repo: string, _wt: string, _mode: string, say?: { shown?: string; confirmBranch?: string }) =>
    params.has("cleanupConfirm") && say?.confirmBranch !== "develop"
      ? later({ removed: false, confirm: "The worktree is on develop, a base branch's name: pushing it would update origin's develop directly. Move the work to a branch of its own first.", branch: "develop" }, 200)
      : later({ removed: true }, 300),
  // ?gitFail=<part of a folder>: that folder's git state can't be read (main's error); ?closeFail=<part>: reading it
  // throws, as an IPC call whose handler threw does; ?gitSlow=<part>: reading it takes 4 s
  worktreeState: async (cwd: string) => {
    if (params.get("gitSlow") && cwd.includes(params.get("gitSlow")!)) await new Promise((r) => setTimeout(r, 4000));
    if (params.get("closeFail") && cwd.includes(params.get("closeFail")!)) throw new Error("EIO: i/o error, read");
    if (params.get("gitFail") && cwd.includes(params.get("gitFail")!)) return err("git status: fatal: unable to read index");
    return cwd.includes("5101") ? { dirty: true, dirtyFiles: 2, branch: "5101-orgDropdowns", upstream: "origin/5101-orgDropdowns", ahead: 1, behind: 0, insertions: 18, deletions: 3 } : { dirty: false, dirtyFiles: 0, branch: "dev", upstream: "origin/dev", ahead: 0, behind: 2, insertions: 0, deletions: 0 };
  },
  watchFolders: async () => ({ watching: [] }),
  prStatus: async (cwd: string) =>
    cwd.includes("5101")
      ? { branch: "5101-orgDropdowns", pr: { id: 88, url: "https://dev.azure.com/acme/Backoffice/_git/backoffice/pullrequest/88", title: "#5101 Org dropdowns remember the last org", base: "dev", state: "approved", conflicts: false, reviews: ["Sam: approved"] }, at: Date.now() }
      : { branch: null, pr: null, at: Date.now() },
  // ?overlapsUnread: s1's and s5's repository has one worktree overlaps couldn't read
  overlapsGet: async () =>
    params.has("statusNotes") && params.get("statusNotes") !== "few"
      ? err("git diff --name-only: fatal: bad object HEAD")
      : {
          bySession: { s1: [{ other: "s5", otherTitle: "Pathways quick view freezes", otherBranch: "5102-quickViewFreeze", files: ["src/org/Dropdown.tsx"] }, { other: `team:${NICK}:5101-lastOrgApi`, otherTitle: "Nick Smith's pushed branch", otherBranch: "5101-lastOrgApi", files: ["src/org/Dropdown.tsx"], teammate: { id: NICK, name: "Nick Smith", roomId: ROOM_5101 } }], s5: [{ other: "s1", otherTitle: "Org dropdowns remember the last org", otherBranch: "5101-orgDropdowns", files: ["src/org/Dropdown.tsx"] }] },
          unread: params.has("overlapsUnread") ? { s1: 1, s5: 1 } : {},
        },
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
  // the run setup of a session's worktree (main's run:profile): backoffice's api, web and worker, shared by its worktrees
  runProfile: async (id: string) => {
    const s = byId(id);
    if (!s?.cwd || s.shell) return err("This session has no worktree to run");
    const repo = s.repoPath ?? s.cwd;
    const profile: RunProfile = {
      repo,
      services: [
        { name: "api", kind: "process", cwd: "api", command: "dotnet watch --urls http://localhost:${port:api}", ports: [{ name: "api", base: 5080, url: "http://localhost:${port}" }] },
        { name: "web", kind: "process", cwd: "web", command: "npm run dev -- --port ${port:web}", ports: [{ name: "web", base: 5173, url: "http://localhost:${port}" }], dependsOn: ["api"] },
        { name: "worker", kind: "process", cwd: "worker", command: "dotnet run" },
      ],
      sideBySide: { slots: 3, step: 10 },
    };
    return later({ worktree: s.cwd, repo, file: `${repo}/.mockingbird/run.json`, profile }, 120);
  },
  debugSessions: async () => [],
  debugBreakpoints: async () => ({ breakpoints: {} }),
  collabList: async () => councils,
  // an approved plan as House tickets: split with the app's own rules; created in no House (numbered here)
  collabTicketDrafts: async (id: string) => {
    const c = councilById(id);
    if (!c?.plan?.approved) return err("Approve a plan first");
    if (c.ticketDrafts?.drafts.length) return { room: clone(c), found: true };
    const split = splitPlan(c.plan.text, { council: c.title });
    if (!split) return { room: clone(c), found: false };
    c.ticketDrafts = { drafts: split.drafts, how: split.how, at: Date.now() };
    return later({ room: councilChanged(c), found: true });
  },
  collabSaveTicketDrafts: async (id: string, drafts: TicketDraft[] | null) => {
    const c = councilById(id)!;
    c.ticketDrafts = drafts ? { ...(c.ticketDrafts ?? { how: "manual" as const }), drafts: clone(drafts), at: Date.now() } : null;
    return councilChanged(c);
  },
  collabWholePlanTicket: async (id: string) => {
    const c = councilById(id)!;
    c.ticketDrafts = { drafts: [wholePlanDraft(c.plan!.text, c.title)], how: "manual", at: Date.now() };
    return councilChanged(c);
  },
  collabSplitWithModel: async (id: string, key: string) => {
    const c = councilById(id)!;
    const label = c.participants.find((p) => p.key === key)?.label ?? key;
    const reply = JSON.stringify([
      { title: "Stream the donor export", detail: "One endpoint, the list's filters, rows streamed.", acceptance: "- Filters honoured", priority: "high" },
      { title: "Measure the biggest org", detail: "Time the export on the largest org.", priority: "medium" },
    ]);
    c.ticketDrafts = { drafts: draftsFromModel(reply, c.title), how: "model", by: label, at: Date.now() };
    councilNote(c, `${label} split the approved plan into 2 draft House tickets for you to review.`);
    return later(councilChanged(c), 600);
  },
  collabTicketTargets: async () => later(clone(ticketTargets)),
  collabTicketConsent: async (_id: string, target: { roomId?: string; project?: string }, allow: boolean) => {
    ticketTargets = { ...ticketTargets, targets: ticketTargets.targets.map((t) => (("roomId" in t && t.roomId === target.roomId) || (t.kind === "project" && t.project === target.project) ? { ...t, connection: allow ? "connected" : "declined" } : t)) };
    return clone(ticketTargets);
  },
  collabCreateTickets: async (id: string, target: { roomId?: string; project?: string }, drafts: TicketDraft[]) => {
    const c = councilById(id)!;
    const t = ticketTargets.targets.find((x) => ("roomId" in x ? x.roomId === target.roomId : x.project === target.project))!;
    const project = t.kind === "room" ? t.project! : t.project;
    const result: CouncilCreateResult = { project, room: t.kind === "room" ? t.room : null, created: [], failed: null, notSent: [] };
    drafts.forEach((d, i) => {
      if (result.failed) result.notSent.push({ draftId: d.id, title: d.title });
      else if (i === 1 && ticketsQ.has("councilTicketsFail")) result.failed = { draftId: d.id, title: d.title, error: "The House answered 422: A work item titled like that already exists" };
      else result.created.push({ draftId: d.id, n: nextTicket++, title: d.title });
    });
    c.houseTickets = [...(c.houseTickets ?? []), ...result.created.map((x) => ({ n: x.n, title: x.title, project, roomId: t.kind === "room" ? t.roomId : null, room: result.room, at: Date.now() }))];
    const made = new Set(result.created.map((x) => x.draftId));
    const left = drafts.filter((d) => !made.has(d.id));
    c.ticketDrafts = left.length ? { drafts: left, how: c.ticketDrafts?.how ?? "manual", at: Date.now() } : null;
    if (result.created.length) councilNote(c, `Created ${result.created.length} House tickets in ${project} from the plan: ${result.created.map((x) => `#${x.n} ${x.title}`).join("; ")}.`);
    return later({ room: councilChanged(c), result }, 400);
  },
  collabOpenTicket: async (_id: string, n: number) => console.info(`[preview] would open #${n} in the House`),
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
  // S7: a card's diff badge and "what it did" (badgeFail=diff / reply fails them, as an unreadable worktree or index would)
  branchStat: async (id: string, base: string | null) => {
    if (badgeFails.has("diff")) return later(err(`git merge-base: fatal: Not a valid object name origin/${base ?? "dev"}`));
    const s = sessions.find((x) => x.id === id);
    if (!s) return err("Session is no longer running");
    const d = branchStats[s.cwd] ?? { files: 0, insertions: 0, deletions: 0 };
    return later({ base: `origin/${base ?? "dev"}`, ...d });
  },
  lastReply: async (id: string) => (badgeFails.has("reply") ? later(err("the conversation index isn't available (SQLITE_CANTOPEN: unable to open database file)")) : later({ line: lastReplies[id] ?? null, at: lastReplies[id] ? now - 6 * min : null })),
  filesDiff: async (_id: string, rel: string) => unifiedDiff(rel),
  scmStatus: async () => ({ branch: "5101-orgDropdowns", upstream: "origin/5101-orgDropdowns", published: true, ahead: 1, behind: 0, staged: [], unstaged: [{ path: "src/org/Dropdown.tsx", status: "M" }, { path: "src/org/lastOrg.ts", status: "U" }], conflicted: [] }),
  scmDiff: async (_id: string, rel: string) => unifiedDiff(rel),
  scmGraph: async () => ({ commits, head: "a1b2c3d", refs: ["HEAD", "origin/dev"], more: false }),
  scmCommitFiles: async () => [{ path: "src/org/Dropdown.tsx", status: "M" }],
  scmCommitDiff: async () => unifiedDiff("src/org/Dropdown.tsx"),
  scmCommitMessage: async () => later({ message: "Remember the last org each user picked", scope: "all", agent: "claude" }, 800),
  scmFetch: async () => later(undefined, 400),
  scmPull: async () => later(err("This branch and origin/dev have both moved, so they can't be fast-forwarded."), 400),
  // with ?roomPushHooks, as a team room session's push answers: what it ran and set aside, its LFS files sent first;
  // with ?pushConfirm too, it first waits for a say-so naming its branch, as one on a branch not its own does
  scmPush: async (_id: string, confirmBranch?: string) =>
    new URLSearchParams(location.search).has("pushConfirm") && confirmBranch !== "release/2.1"
      ? later({ confirm: "The worktree is on release/2.1, not 5101-orgDropdowns, the branch this session was made on: pushing it updates origin's release/2.1.", branch: "release/2.1" }, 200)
      : later(
          {
            upstream: "origin/5101-orgDropdowns",
            ...(new URLSearchParams(location.search).has("roomPushHooks")
              ? { roomPush: { runs: "~/.githooks", skipped: { value: ".git/hooks", why: "this repository's hooks can run files its agent writes (a hook manager's config, its scripts)" }, lfs: "push" } }
              : {}),
          },
          400
        ),
  lspOpen: async () => ({ server: null, state: "none" }),

  // board and tickets
  adoList: async () => ({ items: tickets.map((t) => ({ ...t })), total: tickets.length, me: "You" }),
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
  // moves and reorders change the fixture, as Azure DevOps keeps them, so the board's re-read after a write shows them;
  // the fixture's order is the backlog order. ?reorderFail makes every reorder fail, to see the card go back
  adoMoveToColumn: async (id: number, type: string, _board: string, column: string) => {
    const t = tickets.find((x) => x.id === id);
    const state = board.columns.find((c) => c.name === column)?.stateMappings[type];
    if (!t || !state) return err(`A ${type} can't go in ${column} on the ${board.name} board`);
    Object.assign(t, { state, boardColumn: column, changed: new Date().toISOString() });
    return later({ id, state }, 200);
  },
  adoReorder: async (id: number, previousId: number, nextId: number) => {
    if (new URLSearchParams(location.search).has("reorderFail")) return later(err(`Azure DevOps 403 Forbidden: TF400409: You don't have permission to reorder work items in team Backoffice Team.`), 300);
    const from = tickets.findIndex((x) => x.id === id);
    if (from < 0) return err(`Azure DevOps 404 Not Found: work item ${id} doesn't exist`);
    const [t] = tickets.splice(from, 1);
    const after = tickets.findIndex((x) => x.id === previousId);
    const before = tickets.findIndex((x) => x.id === nextId);
    tickets.splice(after >= 0 ? after + 1 : before >= 0 ? before : from, 0, t);
    tickets.forEach((x, i) => (x.rank = (i + 1) * 1000));
    return later({ id, rank: t.rank ?? null }, 200);
  },
  landscapeGet: async (): Promise<LandscapeState> => {
    // ?lsHold: main never answers, so the landscape is never laid out: what the window shows while it's read in
    if (lsHold) await new Promise<never>(() => {});
    readAgain(0);
    return clone({ landscape, rev: landscapeRev, problems: landscapeProblems });
  },
  // read as main reads it: IPC hands main a structured clone, which keeps NaN and undefined where JSON wouldn't,
  // so a patch main refuses answers { error } here too, and one that changes nothing isn't a revision
  landscapeUpdate: async (raw: unknown): Promise<LandscapeState | { error: string }> => {
    // ?lsReadInFails (with ?landscape=fresh): the first read-in of the grid's layout can't be saved, as a full disk would
    if (lsReadInFails && !readInRefused && raw && typeof raw === "object" && "migratedAt" in raw) {
      readInRefused = true;
      return err("ENOSPC: no space left on device, write '~/.mockingbird/landscape.json'");
    }
    let patch: LandscapePatch;
    let next: Landscape;
    if (tourSaveFails && (raw as LandscapePatch).tourDone !== undefined) return err("ENOSPC: no space left on device");
    if (migrateFails && (raw as LandscapePatch).migratedAt) return err("EACCES: permission denied");
    try {
      patch = parsePatch(structuredClone(raw));
      next = applyPatch(landscape, patch);
    } catch (e) {
      if (!(e instanceof LandscapeShapeError)) throw e;
      return err(e.message);
    }
    // a patch made against the stand-in, arriving as the file can be read again, goes with the stand-in's other changes
    const held = standIn;
    readAgain(held && !sameLandscape(next, landscape) ? 1 : 0);
    if (held && !standIn) return clone({ landscape, rev: landscapeRev, problems: landscapeProblems });
    if (!sameLandscape(next, landscape)) {
      landscape = next;
      landscapeRev++;
      if (lsPersist) sessionStorage.setItem(LS_KEPT, JSON.stringify(landscape));
      if (standIn) standInChanges++;
      emit("onLandscapeChanged", clone({ rev: landscapeRev, patch, problems: landscapeProblems }));
    }
    const answer = clone({ landscape, rev: landscapeRev, problems: landscapeProblems });
    // a script's __mbRaceUpdate: another window's change lands before this one's answer, as main can tell it first
    if (w.__mbRaceUpdate) {
      w.__mbRaceUpdate = false;
      const other: LandscapePatch = { workspaces: { "race-elsewhere": { x: -9000, y: -9000, w: 400, h: 300 } } };
      landscape = applyPatch(landscape, other);
      landscapeRev++;
      emit("onLandscapeChanged", clone({ rev: landscapeRev, patch: other, problems: landscapeProblems }));
    }
    return answer;
  },
  pipelineAll: async () => (badgeFails.has("pr") ? err("~/.mockingbird/pipeline.json: EACCES: permission denied") : JSON.parse(JSON.stringify(pipelines))),
  pipelineStage: async (id: string, stage: TicketStage) => setStage(id, stage),
  pipelineFeedback: async (id: string, text: string) => {
    pipelineOf(id).feedback.push({ at: Date.now(), text });
    return setStage(id, "coding");
  },
  pipelineCheck: async (id: string, key: string, value: boolean) => {
    const p = pipelineOf(id);
    if (value) {
      p.checks[key] = true;
      (p.checkedBy ??= {})[key] = { by: "you", at: Date.now() };
    } else {
      delete p.checks[key];
      delete p.checkedBy?.[key];
    }
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
  // as main's editDraft: the user's edit makes a draft theirs, so who drafted it goes
  pipelineDraftEdit: async (id: string, draftId: string, text: string) => {
    const p = pipelines[id];
    const d = p?.drafts.find((x) => x.id === draftId);
    if (!p || !d) return err(`#${id} has no drafted comment ${draftId}`);
    d.text = String(text);
    delete d.by;
    delete d.from;
    pipelinesChanged();
    return p;
  },
  // as main's: Approve only from stakeholder testing, a dismissed request gone; no agent runs here to be told
  pipelineApprove: async (id: string) => {
    const p = pipelines[id];
    if (!p) return err(`#${id} isn't tracked in the ticket pipeline`);
    if (p.stage !== "stakeholder") return err(`#${id} is at ${p.stage}: Approve is for a ticket in stakeholder testing`);
    const asked = p.prs.filter((x) => x.target === "dev").at(-1)?.by ?? null;
    return { pipeline: setStage(id, "approved"), told: { to: asked, title: null, notTold: "UI preview: no agent is told" } };
  },
  pipelineRequestDismiss: async (id: string, requestId: string) => {
    const p = pipelines[id];
    const request = p?.requests?.find((r) => r.id === requestId);
    if (!p || !request) return err(`#${id} has no pull request request ${requestId} (it may have been answered or replaced)`);
    p.requests = p.requests!.filter((r) => r.id !== requestId);
    pipelinesChanged();
    return { pipeline: p, told: { to: request.from, title: request.fromTitle, notTold: "UI preview: no agent is told" } };
  },
  // the merge watch: nothing is read from a provider here; Mark merged… moves a ticket on from its PR stage, as main's does
  pipelinePrCheck: async () => {
    if (checkTakes.ms) await later(null, checkTakes.ms);
    return err("UI preview: no pull request is read");
  },
  pipelinePrMarkMerged: async (id: string, url: string, asked: string) => {
    const p = pipelines[id];
    const pr = p?.prs.find((x) => x.url === url);
    if (!p || !pr) return err(`#${id} has no pull request ${url}`);
    if (pr.mergedAt) return err(`#${id}'s pull request ${pr.id} is merged already`);
    // as main's: only while it still needs you, in the state the user was asked about
    if (!prNeedsYou(p, pr)) return err(`PR ${pr.id} to ${pr.target} doesn't need you any more: nothing was marked.`);
    if (prAskedState(pr) !== asked) return err(`PR ${pr.id} to ${pr.target} has changed since you were asked: nothing was marked. Ask again.`);
    Object.assign(pr, { mergedAt: Date.now(), mergedBy: "you" });
    delete pr.watch;
    delete pr.closedAt;
    if (p.stage === (pr.target === "dev" ? "pr-dev" : "pr-main")) return setStage(id, pr.target === "dev" ? "dev-test" : "prod-test");
    pipelinesChanged();
    return p;
  },
  // as main's: the session's recorded branch when the worktree is on another, and with "hooks" what a room push runs
  pipelinePrPreflight: async (sessionId: string, _ticketId: string, target: string) => {
    if (!prRequest) return { branch: "5101-orgDropdowns", base: "dev", bases: ["dev", "main"], dirtyFiles: 2, commits: 1, remote: { provider: "ado", repo: "Backoffice/backoffice" }, docs: null, existing: null, lookupError: null };
    const branch = prRequest.has("basebranch") ? "dev" : prRequest.has("otherbranch") ? "release/2.1" : "5101-orgDropdowns";
    const recorded = sessions.find((s) => s.id === sessionId)?.branch ?? null;
    return {
      branch,
      base: target === "main" ? "main" : "dev",
      bases: ["dev", "main"],
      dirtyFiles: 0,
      commits: 3,
      remote: { provider: "ado", repo: "Backoffice/backoffice" },
      docs: "doc/features/5101-orgDropdowns/5101-Description.md",
      existing: null,
      lookupError: null,
      ...(branch !== recorded ? { recordedBranch: recorded } : {}),
      ...(prRequest.has("hooks")
        ? { roomPush: { runs: "~/.githooks", skipped: { value: ".git/hooks", why: "this repository's hooks can run files its agent writes (a hook manager's config, its scripts)" }, lfs: "push" } }
        : {}),
    };
  },
  pipelinePrDescribe: async () => later({ description: "## Summary\nThe org dropdown remembers each user's last org.\n\n## Changes\n- Store and read the last org\n\n## Testing\nNot stated", agent: "claude" }, 800),
  // nothing is pushed or opened here; with ?prRequest it's recorded as main's addPr would, answering the asker's request
  pipelinePrCreate: async (sessionId: string, ticketId: string, req: { target?: string; base?: string } | undefined) => {
    const p = pipelines[ticketId];
    if (!prRequest || !p) return err("UI preview: no pull request is opened");
    const target = req?.target === "main" ? "main" : "dev";
    p.prs.push({ target, provider: "ado", id: 91, url: "https://dev.azure.com/acme/Backoffice/_git/backoffice/pullrequest/91", repo: "backoffice", branch: "5101-orgDropdowns", base: String(req?.base ?? ""), at: Date.now(), by: sessionId });
    p.requests = (p.requests ?? []).filter((r) => !(r.target === target && r.from === sessionId));
    return setStage(ticketId, target === "dev" ? "pr-dev" : "pr-main");
  },
  // only the built-in Helpdesk preset starts here, as main's presets:start does: its tasks session in the Helpdesk area
  // after ?createMs, refused, saying why, as main refuses it (sessions.ts create, mayStartTasks): while one is open or
  // starting, and when that area is a team room's. ?lsHelpdeskRoom makes it 5110's room's.
  presetStart: async (id: string) => {
    if (id !== HELPDESK_PRESET.id) return err("UI preview: presets don't start sessions");
    if (tasksStarting) return err(HELPDESK_STARTING);
    const open = sessions.find((s) => s.role === "tasks");
    if (open) return err(helpdeskOpenAlready(open.title));
    if (team.rooms.some((r) => r.groupKey === HELPDESK_GROUP)) return err(HELPDESK_START_IN_ROOM);
    tasksStarting = true;
    try {
      await startLag();
    } finally {
      tasksStarting = false;
    }
    const s = session(`h${Date.now().toString(36)}`, { title: "Helpdesk tasks", repoPath: null, cwd: "/Users/you/Helpdesk", kind: "assistant", taskGroup: HELPDESK_GROUP, role: "tasks", status: "idle", createdAt: Date.now() });
    sessions = [...sessions, s];
    buffers[s.id] = `${C.dim}(UI preview: the Helpdesk tasks workspace would start here)${C.reset}\r\n> `;
    sessionsChanged();
    return s;
  },

  // undo, handoff, review, rollup
  turnsList: async () => ({ snapshots: [{ n: 2, sha: "x", at: now - 10 * min, prompt: "Make the org dropdown remember the last org each user picked", skipped: [], filtered: [], beforeUndo: false }, { n: 1, sha: "y", at: now - 70 * min, prompt: "Look at the org dropdown and plan the change", skipped: [], filtered: [], beforeUndo: false }], lastError: null }),
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
  updateStatus: async () => (params.has("statusNotes") ? { state: "failed", step: "build", done: ["pull"], log: [], problem: "npm run build exited 2" } : { state: "idle", done: [], log: [] }),
  updateOutcome: async () => (params.has("statusNotes") && params.get("statusNotes") !== "few" ? { ok: false, from: "1.6.0", to: "1.7.0", message: "The build failed: tsc exited 2", sessions: [], logPath: "/Users/you/.mockingbird/update.log" } : null),
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
  teamStatus: async () => (teamFails ? err("~/.mockingbird/team.json: EACCES: permission denied") : JSON.parse(JSON.stringify(team))),
  teamShareGroup: async (groupKey: string, title: string) => {
    // ?refuse: the signaling Worker refuses new rooms, as one without this key on ALLOWED_CREATORS does
    if (new URLSearchParams(location.search).has("refuse") && !team.rooms.some((r) => r.groupKey === groupKey)) {
      return later(err(`This signaling Worker doesn't allow new rooms yet — add your fingerprint (${team.self!.fingerprint}) to ALLOWED_CREATORS.\n\nOn the Worker, once: …`), 300);
    }
    let room = team.rooms.find((r) => r.groupKey === groupKey);
    const created = !room;
    if (!room) {
      room = { id: `R${groupKey}`.padEnd(22, "c").slice(0, 22), name: title, groupKey, members: [{ id: ME, name: "You", self: true }], online: [], signalingUrl: SIGNAL, signaling: "online" };
      team.rooms.push(room);
      teamChanged();
    }
    return later({ roomId: room.id, invite: inviteCode(room.id), created }, 300);
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
    const mine = room.owner === ME ? "owner" : room.admins?.includes(ME) ? "admin" : "member";
    if (mine === "member" || (mine === "admin" && (room.owner === memberId || room.admins?.includes(memberId)))) return err("Only the room's owner removes an admin or the owner; admins remove members");
    if (room.members.some((m) => m.id === memberId)) {
      room.members = room.members.filter((m) => m.id !== memberId);
      room.admins = room.admins?.filter((id) => id !== memberId);
      room.former = [...(room.former ?? []), { id: member.id, name: member.name }];
      (chats[roomId] ??= []).push(chatEntry({ kind: "member", author: ME, at: Date.now(), member: memberId, change: "removed" }));
      teamChanged();
      chatChanged(roomId);
    }
    const worker = workerRevoke ? null : "Your signaling Worker is older and doesn't know how to cut members off. Update your signaling Worker (cd signaling && npx wrangler deploy) to also cut them off at the Worker.";
    return later({ name: member.name, delivered: room.online.includes(memberId), worker }, 600);
  },
  // room roles: the fixture's roles change, and the room's chat says so
  teamSetAdmin: async (roomId: string, memberId: string, admin: boolean) => {
    const room = team.rooms.find((r) => r.id === roomId);
    if (!room?.members.some((m) => m.id === memberId)) return err("They aren't in that room");
    if (room.owner !== ME) return err("Only the room's owner makes admins");
    room.admins = admin ? [...new Set([...(room.admins ?? []), memberId])] : (room.admins ?? []).filter((id) => id !== memberId);
    (chats[roomId] ??= []).push(chatEntry({ kind: "member", author: ME, at: Date.now(), member: memberId, change: admin ? "admin" : "unadmin" }));
    teamChanged();
    chatChanged(roomId);
  },
  teamHandOver: async (roomId: string, memberId: string) => {
    const room = team.rooms.find((r) => r.id === roomId);
    if (!room?.members.some((m) => m.id === memberId)) return err("They aren't in that room");
    if (room.owner !== ME) return err("Only the room's owner hands over ownership");
    room.owner = memberId;
    room.admins = [...(room.admins ?? []).filter((id) => id !== memberId), ME];
    (chats[roomId] ??= []).push(chatEntry({ kind: "member", author: ME, at: Date.now(), member: memberId, change: "owner" }));
    teamChanged();
    chatChanged(roomId);
  },
  teamClaimOwnership: async (roomId: string) => {
    const room = team.rooms.find((r) => r.id === roomId);
    if (!room || room.claimOpensAt == null || room.claimOpensAt > Date.now()) return err("Ownership can't be claimed yet");
    const from = room.owner!;
    Object.assign(room, { owner: ME, admins: (room.admins ?? []).filter((id) => id !== ME), claim: { from, by: ME, at: Date.now() }, claimOpensAt: null });
    (chats[roomId] ??= []).push(chatEntry({ kind: "member", author: ME, at: Date.now(), member: from, change: "claim" }));
    teamChanged();
    chatChanged(roomId);
  },
  teamContestClaim: async (roomId: string) => {
    const room = team.rooms.find((r) => r.id === roomId);
    if (room?.claim?.from !== ME) return err("Nobody claimed ownership from you");
    const was = room.owner!;
    Object.assign(room, { owner: ME, admins: [...(room.admins ?? []), was], claim: undefined });
    (chats[roomId] ??= []).push(chatEntry({ kind: "member", author: ME, at: Date.now(), member: was, change: "contest" }));
    teamChanged();
    chatChanged(roomId);
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
    // ?houseRefuse: the House refuses every status change, as it does one a builder may not make
    if (teamQuery.has("houseRefuse") && w.kind === "event" && w.status) return later(err(`The House answered 403: only the claimant moves #${w.n} on`), 300);
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
  // a session from a ticket: the plan from the fixture House and repos; Start claims as houseWrite does and starts a
  // session as createSession does. ?houseStartFail=claim: someone claims it first (the House's 409); =session: the
  // worktree can't be made, and the claim is released again (=stuck: releasing fails too)
  houseSessionPlan: async (roomId: string, n: number) => {
    const r = houseRooms[roomId];
    const t = houseTickets[n];
    if (!r?.project) return err(`Room ${roomId} isn't connected to a House project`);
    if (!t) return later(err(`The House answered 404: no work item #${n} in this project`), 150);
    const owner = houseOwner(t);
    const holder: TicketHolder = !isOpenStatus(t.status) ? { state: "closed", status: t.status } : owner ? (owner.self ? { state: "yours" } : { state: "taken", by: owner.name }) : { state: "free" };
    const own = holder.state === "yours" ? t.claim?.branch : null;
    const room = team.rooms.find((x) => x.id === roomId);
    const plan: TicketSessionPlan = {
      roomId,
      room: room?.name ?? roomId,
      group: room?.groupKey ?? "",
      project: r.project,
      n,
      title: t.title,
      holder,
      branch: own || branchFor(n, t.title),
      branchFrom: own ? "claim" : "new",
      repos: [{ path: REPO, name: "backoffice", base: own ? null : "dev" }],
      repoNote: null,
    };
    return later(plan, 200);
  },
  houseStartSession: async (roomId: string, req: TicketSessionRequest): Promise<TicketSessionResult> => {
    const t = houseTickets[req.n];
    const fail = teamQuery.get("houseStartFail");
    const owner = houseOwner(t);
    if (owner && !owner.self) return later({ error: `#${req.n} is ${owner.name}'s, on ${t.claim?.branch}: nothing was started. Ask ${owner.name} to release it, or start on another ticket.`, step: "claim", takenBy: owner.name }, 300);
    const branch = owner?.self && t.claim?.branch ? t.claim.branch : req.branch || branchFor(req.n, t.title);
    if (fail === "claim") return later({ error: `Nick Smith claimed #${req.n} just before you, so nothing was started. The House answered: The House answered 409: Already claimed by Nick Smith`, step: "claim", takenBy: "Nick Smith" }, 400);
    const claimed = !owner;
    if (claimed) await api.houseWrite(roomId, { kind: "claim", n: req.n, branch });
    if (fail === "session" || fail === "stuck") {
      if (fail === "session" && claimed) await api.houseWrite(roomId, { kind: "release", n: req.n });
      const why = `fatal: '${branch}' is already checked out at '/Users/you/Code/backoffice'`;
      return later(
        fail === "stuck"
          ? { error: `Couldn't make #${req.n}'s worktree or start its session: ${why}. #${req.n} is still claimed by you on ${branch}: releasing it failed (The House answered 503: try again).`, step: "session", stillClaimed: true }
          : { error: `Couldn't make #${req.n}'s worktree or start its session: ${why}. Released #${req.n} again, so it's unclaimed as before.`, step: "session" },
        300
      );
    }
    const room = team.rooms.find((x) => x.id === roomId);
    const session: SessionInfo = await api.createSession({ repoPath: req.repoPath, useWorktree: true, branchName: branch, taskGroup: room?.groupKey, ticketId: String(req.n), ticketTitle: t.title, agent: req.agent, title: `#${req.n} — ${t.title}` });
    return later({ session, claimed, branch, message: claimed ? `Claimed #${req.n} and started ${req.agent === "codex" ? "Codex" : "Claude"} on ${branch}` : `Started on ${branch}` }, 300);
  },
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
  artifactsList: async (roomId: string) => {
    const room = artifactRoom(roomId);
    if (!room) return err("You're not in that room");
    const readOnly = readOnlyOf(roomId);
    return readOnly ? { ...clone(room), readOnly, problems: [...room.problems, readOnly] } : clone(room);
  },
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
  // an area shared as a room: its artifacts on this Mac copied in, nothing secret (main's AreaArtifacts.shareTo)
  artifactsShareArea: async (key: string, roomId: string) => {
    const from = artifactRoom(`area:${key}`);
    const to = artifactRoom(roomId);
    if (!from || !to) return err("You're not in that room");
    const out = { shared: 0, refused: [] as { name: string; reason: string }[], ids: {} as Record<string, string> };
    for (const a of from.items) {
      if (a.agentsBlocked) {
        out.refused.push({ name: a.name, reason: `${a.agentsBlocked}: add it to the room yourself if teammates should have a copy` });
        continue;
      }
      const id = artId(`S${Math.random().toString(36).slice(2, 10)}`);
      if (artTexts[a.id] !== undefined) artTexts[id] = artTexts[a.id];
      to.items.push({ ...a, id, addedBy: ME, addedByName: "You", addedAt: Date.now() });
      out.ids[a.id] = id;
      out.shared++;
    }
    artifactsChanged(roomId);
    return later(out, 300);
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
  teamSetBackupConsent: async (roomId: string, allow: boolean) => {
    const r = takeoverView.rooms.find((x) => x.roomId === roomId);
    if (!r) return err("You're not in that room");
    r.consent = allow;
    takeoverChanged();
    return later(null, 300);
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
    if (teamLiveFails && !teamLiveBack && (teamLiveFails === "always" || teamLiveCalls++ === 0)) return err("team rooms: the room sessions couldn't be read (EIO)");
    const state: LivePanesState = JSON.parse(JSON.stringify(live));
    for (const tag of Object.values(state.own)) tag.inlineOnStart = settings.roomSessionsInline !== false; // as main answers
    return state;
  },
  // ?liveViewFail: main can't take what's on screen here
  teamLiveView: async () => (params.has("liveViewFail") ? err("team rooms aren't running") : undefined),
  // typing into teammates' sessions: asking makes Nick's pane "asked"; an answer or a revoke changes your session's tag
  teamAskToType: async (id: string) => {
    const r = live.remote.find((x) => x.id === id)?.room;
    if (r) r.typing = { state: "asked" };
    emit("onTeamLive", JSON.parse(JSON.stringify(live)));
    return null;
  },
  // as main decides: an allowance answers a pending ask, and every window hears of it after main's 50 ms debounce;
  // ?typingRevokeFails: taking typing back is refused, as for a session no longer shared; ?typingAnswerMs=<ms>: main
  // takes that long to answer
  teamDecideTyping: async (sessionId: string, member: string, choice: "session" | "minutes" | "deny" | "revoke") => {
    const slow = Number(teamTypingQ.get("typingAnswerMs")) || 0;
    if (slow > 0) await new Promise((r) => setTimeout(r, slow));
    const tag = live.own[sessionId];
    if (!tag || (choice === "revoke" && teamTypingQ.has("typingRevokeFails"))) return err("That session isn't shared in a room any more");
    if ((choice === "session" || choice === "minutes") && !tag.typingAsks?.some((a) => a.member === member)) return err(`Nick Smith isn't asking to type in "${byId(sessionId)?.title ?? sessionId}": there's nothing to allow`);
    tag.typingAsks = (tag.typingAsks ?? []).filter((a) => a.member !== member);
    tag.typists = (tag.typists ?? []).filter((g) => g.member !== member);
    if (choice === "session" || choice === "minutes") tag.typists.push({ member, name: "Nick Smith", until: choice === "minutes" ? Date.now() + 15 * min : null, at: Date.now() });
    setTimeout(() => emit("onTeamLive", JSON.parse(JSON.stringify(live))), 50);
    return null;
  },
  teamAuditRecent: async () => JSON.parse(JSON.stringify(auditEntries)),
  // phone alerts: nothing is sent or read here; the test alert answers as Messages would
  phoneStatus: async () => clone(phoneStatus),
  phoneTest: async () => {
    if (!settings.phoneAlerts?.handle) return err("Enter your iMessage handle first: your Apple ID email, or your number with its country code");
    if (phoneQ === "denied") return later(err("Mockingbird isn't allowed to control Messages. Allow it in System Settings → Privacy & Security → Automation → Mockingbird → Messages."), 400);
    phoneStatus = { ...phoneStatus, last: { at: Date.now(), ok: true, detail: "Test alert sent", test: true } };
    return later({ detail: "Sent — check your phone" }, 400);
  },
  phoneCheckReplies: async () => {
    if (settings.phoneAlerts?.replies && phoneStatus.replies.state === "off") phoneStatus = { ...phoneStatus, replies: { state: "no-access", detail: "macOS won't let Mockingbird read Messages: grant it Full Disk Access in System Settings → Privacy & Security → Full Disk Access, then check again." } };
    return later(clone(phoneStatus.replies), 300);
  },
  phoneOpenPrivacy: async () => undefined,
  clearPhoneNote: async (id: string) => {
    const s = byId(id);
    if (s) s.phoneNote = null;
    sessionsChanged();
  },
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
// Nick asks to type in one of this Mac's room sessions now, as main hears it: __mbAskToType("s2")
w.__mbAskToType = (id: string) => {
  const tag = live.own[id];
  if (!tag) throw new Error(`${id} isn't one of this Mac's room sessions here`);
  tag.typingAsks = [...(tag.typingAsks ?? []).filter((a) => a.member !== NICK), { member: NICK, name: "Nick Smith", at: Date.now() }];
  emit("onTeamLive", JSON.parse(JSON.stringify(live)));
};

// a first visit (or ?reset) starts from a useful layout
const params = new URLSearchParams(location.search);
const set = (key: string, value: unknown) => localStorage.setItem(key, JSON.stringify(value));
if (params.has("reset") || !localStorage.getItem("mb.preview")) {
  localStorage.clear();
  localStorage.setItem("mb.preview", "1");
  localStorage.setItem("mb.helpSeen", "true");
  set("mb.tab", "sessions");
  // the grid's panes on screen as 1.6 left them, which the migration reads (?landscape=fresh)
  set("mb.shown", ["s1", "s2", "s3", "s4"]);
}
// the screen to open on, for screenshots and links:
// ?tab=dashboard · ?view=scm (explorer, search, run) · ?section=about (a Settings section) · ?theme=light
// · ?shown=s1,s4 (the grid's panes on screen as 1.6 left them, for ?landscape=fresh's migration: group 5101 has s1, s4,
//   s8 and the workspace s2/s3; 5102 has s5, s6)
const tab = params.get("tab");
const view = params.get("view");
const section = params.get("section");
const theme = params.get("theme");
const shown = params.get("shown");
if (tab) set("mb.tab", tab);
// ?staleSideView=scm: the side bar view the grid last left, which means nothing on the landscape
if (params.get("staleSideView")) set("mb.sideView", params.get("staleSideView"));
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
// ?lsBadPref=<key,…>: those of the grid's prefs aren't JSON; ?lsOddPref=<key,…>: they're JSON, not in the grid's shape
for (const key of params.get("lsBadPref")?.split(",") ?? []) localStorage.setItem(key, "{not json");
for (const key of params.get("lsOddPref")?.split(",") ?? []) localStorage.setItem(key, "5");
// the landscape: ?lsCamera=x,y,zoom puts the camera there (else it fits everything); ?lsFocus=<id> selects that
// session's workspace and presses Enter on the landscape, which fills the window with it
const lsCamera = params.get("lsCamera")?.split(",").map(Number);
if (lsCamera?.length === 3 && lsCamera.every(Number.isFinite)) set("mb.landscape.camera", { x: lsCamera[0], y: lsCamera[1], zoom: lsCamera[2] });
// the landscape audit starts at 100% on s1: a fitted landscape is cards, with no terminal to measure
else if (params.has("landscapeAudit")) set("mb.landscape.camera", { x: 0, y: 0, zoom: 1 });
// WebGL for the landscape's terminals (termGl.ts): ?glMax=<n> lowers the cap on how many draw with it at once;
// ?glFail makes every WebGL2 context fail to be made, as on a machine without one
if (Number(params.get("glMax")) > 0) w.__mbGlMax = Number(params.get("glMax"));
if (params.has("glFail")) {
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...rest: unknown[]) {
    return kind === "webgl2" ? null : (getContext as (...a: unknown[]) => unknown).call(this, kind, ...rest);
  } as typeof getContext;
} else {
  // every WebGL2 context made, to count those still holding one of Chromium's (`__mbGlAlive`): not lost yet, whether
  // or not their terminal still draws with it
  const made = new Set<WebGL2RenderingContext>();
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...rest: unknown[]) {
    const c = (getContext as (...a: unknown[]) => unknown).call(this, kind, ...rest);
    if (kind === "webgl2" && c) made.add(c as WebGL2RenderingContext);
    return c;
  } as typeof getContext;
  w.__mbGlAlive = () => [...made].filter((gl) => !gl.isContextLost()).length;
  w.__mbGlMade = () => made.size;
}
// what the app says on the console as it goes, for the audits to read back: warnings and errors
const said: string[] = (w.__mbSaid = []);
for (const level of ["warn", "error"] as const) {
  const was = console[level].bind(console);
  console[level] = (...a: unknown[]) => {
    said.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(" "));
    was(...a);
  };
}
// team rooms: team chat — ?chat=<room id> picks the room the Team room view shows;
// ?chat=list shows the room list, each room with its sessions
if (params.get("chat")) set("mb.roomChat.room", params.get("chat") === "list" ? "" : params.get("chat"));
// the House board and New session in a room are opened from the Team view's rooms: it opens on the room list
// (and, for ?chatMenu, on the first room) unless ?view says otherwise
const houseKeys = ["house", "houseTicket", "houseClaim", "houseAdd", "houseWarning", "houseAgent", "houseProblems", "houseBoardAudit", "houseDrag", "houseStart", "houseStartAudit"];
const ctxOn = params.get("ctx");
const teamViewOn = view === "room" || (!view && (houseKeys.some((k) => params.has(k)) || params.get("new") === "room" || params.has("chatMenu") || !!ctxOn));
// ?view=room: the Team view, by the Connected line, and on a room when one's asked for, by its name in the room list;
// ?view=scm (explorer, search, run): that tool's window, by its button on the rail
if (teamViewOn) {
  const chatQ = params.get("chat");
  const room = chatQ && chatQ !== "list" ? chatQ : params.has("chatMenu") || (ctxOn && ctxOn !== "row") ? "R5101aaaaaaaaaaaaaaaaa" : null;
  const t = setInterval(() => {
    if (!document.querySelector(".side-back")) return document.querySelector<HTMLElement>(".connected-line")?.click();
    if (room) {
      const card = document.querySelectorAll(".room-card")[team.rooms.findIndex((r) => r.id === room)];
      if (!card) return;
      card.querySelector<HTMLElement>(".room-name")?.click();
    }
    clearInterval(t);
  }, 100);
  setTimeout(() => clearInterval(t), 8000);
}
// ?ctx=row|pane|tab|artifact|member opens that element's right-click menu: the first teammate's session row in the Team
// view (=row), the first pane's header, the first workspace tab, the first artifact (with view=room), the room's second member (=member); ?ctxKeys
// presses ↓ twice in it, from the keyboard
// ?paneControls shows every pane header's controls as a hover does, and every session row's actions, for screenshots
if (params.has("paneControls")) {
  const show = document.createElement("style");
  show.textContent = ".pane .pane-header .controls, .sess-item .sr-acts, .sess-item .sr-acts > * { display: inline-flex !important; }";
  document.head.appendChild(show);
}
if (ctxOn) {
  const target = { row: ".room-sess-body .sess-item.remote", pane: ".ls-head", tab: ".ls-tab", artifact: ".art-row", member: ".rc-members .rc-member + .rc-member" }[ctxOn] ?? ctxOn;
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
// that ticket on it, ?houseClaim=142 starts claiming it (⌥→ from Ready, which asks for the branch on the card),
// ?houseAdd (=new) opens + Add ticket; ?houseWarning adds a claim warning; ?houseAgent turns on the "Needs an agent"
// filter; ?houseFolds=open unfolds Parked and Done and shows Dropped (the board remembers its folds)
if (params.get("houseFolds") === "open") set("mb.house.folds", { parked: false, done: false, showDropped: true });
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
    const ticket = params.get("houseTicket") ?? params.get("houseClaim") ?? params.get("houseStart")?.split(",")[0] ?? null;
    let boardTries = 0;
    const board = setInterval(() => {
      const r = ticket ? (document.querySelector(`.house-card[data-id="${ticket}"]`) as HTMLElement | null) ?? undefined : (document.querySelector(".house-modal") as HTMLElement | null) ?? undefined;
      if (!r && ++boardTries < 50) return;
      clearInterval(board);
      if (params.has("houseAgent")) (document.querySelector(".house-filter") as HTMLElement | null)?.click();
      if (params.has("houseTicket")) r?.click();
      // ?houseStart=146 opens Start session on that card (with ?houseTicket, from the ticket's own button); =146,menu
      // right-clicks the card for its menu instead
      if (params.has("houseStart") && !params.has("houseTicket")) {
        if (params.get("houseStart")!.endsWith(",menu")) {
          const b = r!.getBoundingClientRect();
          r?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: b.left + 40, clientY: b.top + 20 }));
        } else (r?.querySelector(".house-start") as HTMLElement | null)?.click();
      }
      if (params.has("houseStart") && params.has("houseTicket")) waitFor(".house-acts button.primary", (el) => el.click());
      if (params.has("houseClaim")) {
        r?.focus();
        r?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", altKey: true, bubbles: true, cancelable: true }));
      }
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
// ?ctxPop opens the first pane's context-warning chip; ?ctxBrief goes on to Fresh session with a brief; ?ctxResume
// resumes the crashed session s6, whose cold conversation asks first
const ctxButton = (text: string) => [...document.querySelectorAll(".ctx-pop button")].find((b) => b.textContent === text) as HTMLElement | undefined;
if (params.has("ctxPop") || params.has("ctxBrief")) setTimeout(() => click(".ctx-chip"), 900);
if (params.has("ctxBrief")) setTimeout(() => ctxButton("Fresh session with a brief")?.click(), 1200);
if (params.has("ctxResume")) setTimeout(() => click(".pane.st-dead .dead-body button.outline.strong"), 900);
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
// ?councilTickets (see the fixture above) opens the Council on its approved plan and its "Create House tickets…"
if (ticketsMode !== null) {
  set("mb.tab", "collaborate");
  set("mb.collab.inspector", true);
  setTimeout(() => waitFor(".council-tix-open", (el) => el.click()));
}
if (councilPlanMode !== null) {
  set("mb.tab", "collaborate");
  set("mb.collab.inspector", true);
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
// S7: ?needsTray opens the Needs you tray (?joinRequest=later to list Lee's request in it too);
// ?needsStep=<n> then presses N on the landscape n times (a negative n, ⇧N), the tray kept open; ?needsTrayStep=<n>
// presses it in the tray instead, so the view keeps the item clear of the tray (?lsFit fits the landscape first)
if (params.has("needsTray") || params.has("needsStep") || params.has("needsTrayStep")) {
  const steps = Number(params.get("needsStep")) || 0;
  const inTray = Number(params.get("needsTrayStep")) || 0;
  const key = (n: number) => new KeyboardEvent("keydown", { key: n < 0 ? "N" : "n", shiftKey: n < 0, bubbles: true, cancelable: true });
  setTimeout(() => {
    const vpEl = document.querySelector<HTMLElement>(".ls-viewport");
    if (inTray) {
      if (params.has("lsFit")) vpEl?.dispatchEvent(new KeyboardEvent("keydown", { key: "0", metaKey: true, bubbles: true, cancelable: true }));
      setTimeout(() => click(".ny-btn"), 200);
      for (let i = 0; i < Math.abs(inTray); i++) setTimeout(() => document.querySelector(".ny-tray")?.dispatchEvent(key(inTray)), 500 + i * 200);
      return;
    }
    // a press per frame or so, as a person's: each N steps on from where the last one landed
    for (let i = 0; i < Math.abs(steps); i++) setTimeout(() => vpEl?.dispatchEvent(key(steps)), i * 150);
    if (params.has("needsTray")) setTimeout(() => click(".ny-btn"), steps ? Math.abs(steps) * 150 + 700 : 0);
  }, 1200);
}
// W15: ?needsOpen=<item id> (with ?needsTray) then presses that item's Open: an agent's PR request's filled form, or a
// ticket's pipeline (?prRequest has both)
if (params.has("needsOpen")) setTimeout(() => click(`.ny-tray .ny-item[data-item="${CSS.escape(params.get("needsOpen")!)}"] button[data-action="open"]`), 2000);
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
{
  const label = { explorer: "Files", scm: "Changes", search: "Search", run: "Run & debug" }[view ?? ""];
  if (label) waitFor(`.ab-btn[aria-label="${label}"]`, (el) => setTimeout(() => el.click(), 900));
}
// a sync failing after the window has read them: main pushes the failure as well as answering with it
if (badgeFails.has("meters")) setTimeout(() => emit("onMetersChanged", err(METERS_FAIL)), 1000);
// S8: ?keysSheet opens the shortcuts sheet (from »'s menu when its button is folded), ?newMenu the top bar's + New, and
// ?lsTourStep=<n> presses the tour's Next n times
if (params.has("keysSheet"))
  setTimeout(() => {
    if (document.querySelector(".tb-keys")) return click(".tb-keys");
    click(".tb-more");
    setTimeout(() => [...document.querySelectorAll<HTMLElement>(".mb-ctx button")].find((b) => b.textContent?.includes("? Shortcuts"))?.click(), 300);
  }, 1000);
if (params.has("newMenu")) setTimeout(() => click(".topbar > button.primary"), 1000);
if (params.has("lsTourStep")) for (let i = 0; i < Number(params.get("lsTourStep")); i++) setTimeout(() => click('.ls-tour-card [data-act="next"]'), 1000 + i * 200);
// S8: ?landscapeFirstRunAudit=k|t|e|b works the shortcuts sheet, the tour, the empty landscape and the top bar (firstRunAudit.ts) for test/uiLandscapeFirstRun.test.ts
if (params.has("landscapeFirstRunAudit")) {
  recordConsole();
  // as main tells the windows of another window's change: the patch, not the whole landscape
  const patchLandscape = (patch: LandscapePatch) => {
    landscape = applyPatch(landscape, parsePatch(structuredClone(patch)));
    landscapeRev++;
    emit("onLandscapeChanged", clone({ rev: landscapeRev, patch, problems: landscapeProblems }));
  };
  const setSession = (id: string, over: Partial<SessionInfo> | null) => {
    sessions = over ? sessions.map((s) => (s.id === id ? { ...s, ...over } : s)) : sessions.filter((s) => s.id !== id);
    sessionsChanged();
  };
  runFirstRunAudit({ sessions: () => sessions, calls, stored: () => landscape, patch: patchLandscape, setSession, waitFor }, params.get("landscapeFirstRunAudit") || "k");
}
// S7: ?landscapeNeedsAudit=a|g|b|c|d|e|f|s|p|t|h|q|r|o|w|k works Needs you and the cards' badges, and W15's ticket items (needsYouAudit.ts), for test/uiLandscapeNeeds.test.ts
if (params.has("landscapeNeedsAudit")) {
  recordConsole();
  const setSession = (id: string, over: Partial<SessionInfo>) => {
    sessions = sessions.map((s) => (s.id === id ? { ...s, ...over } : s));
    sessionsChanged();
  };
  // a session of this Mac's room tag as team rooms report it (a take-over lands there, not in the session)
  const fixtureTags = clone(live.own);
  const setOwnTag = (id: string, over: Partial<RoomSessionTag> | null) => {
    if (!fixtureTags[id]) return;
    live.own[id] = over ? { ...fixtureTags[id], ...over } : clone(fixtureTags[id]);
    emit("onTeamLive", clone(live));
  };
  const setRemote = (id: string, over: Partial<SessionInfo>) => {
    live.remote = live.remote.map((s) => (s.id === id ? { ...s, ...over } : s));
    emit("onTeamLive", clone(live));
  };
  runNeedsAudit(
    {
      sessions: () => sessions,
      setSession,
      setOwnTag,
      remote: () => live.remote,
      setRemote,
      calls,
      emit,
      badgeFails,
      waitFor,
      pipelines: () => pipelines,
      pipelinesChanged,
      // W5's part: the wire book below, changed as main changes it
      wire: (id) => (Object.hasOwn(wireBook.links, id) ? wireBook.links[id] : undefined),
      setWire: (id, w) => void wireChanged(withLink(id, w)),
      costly: (id, on) => void (on ? bigResume.add(id) : bigResume.delete(id)),
      latest: (id, text) => void (LATEST_MESSAGES[id] = text),
      checkTakes: (ms) => void (checkTakes.ms = ms),
    },
    params.get("landscapeNeedsAudit") || "a"
  );
}
// W6: ?landscapeStripAudit (with ?wires=fanout) works the pipeline strip in focus (stripAudit.ts) for test/uiLandscapeStrip.test.ts
if (params.has("landscapeStripAudit")) runStripAudit({ calls, waitFor });
// W17: ?landscapePlanAudit=<part> (with ?lsWires&lsPlan) works an Orchestrator's plan and the built-in template (planAudit.ts) for test/uiTemplatePicker.test.ts
if (params.has("landscapePlanAudit")) runPlanAudit({ calls, waitFor }, params.get("landscapePlanAudit") || "plan");
// S8: ?landscapeSwitchAudit=stack|locked|palette|notes|place works what the grid offered on the landscape (switchAudit.ts) for test/uiLandscapeSwitch.test.ts
if (params.has("landscapeSwitchAudit")) {
  const newSession = (over: Partial<SessionInfo>) => {
    const made = session(`n${Date.now().toString(36)}`, { status: "working", createdAt: Date.now(), ...over });
    sessions = [...sessions, made];
    buffers[made.id] = `${C.dim}(UI preview: a new session would start here)${C.reset}\r\n> `;
    sessionsChanged();
    return made;
  };
  runSwitchAudit(
    {
      sessions: () => sessions,
      calls,
      api: api as never,
      newSession,
      setLiveProblems: (problems) => {
        live.problems = problems;
        emit("onTeamLive", clone(live));
      },
      areaCount: () => Object.keys(landscape.areas).length,
      roomsEmpty: () => {
        for (const r of team.rooms) r.online = [];
        teamChanged();
      },
      waitFor,
    },
    params.get("landscapeSwitchAudit") || "stack"
  );
}
const lsFocus = params.get("lsFocus");
if (lsFocus) {
  const at = `.ls-world [data-front="${CSS.escape(lsFocus)}"]`;
  // a workspace is a card when zoomed out, or a bare frame off screen: its header, else the card
  waitFor(at, (el) => {
    (el.querySelector<HTMLElement>(".ls-head") ?? el).dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    setTimeout(() => document.querySelector<HTMLElement>(".ls-viewport")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })), 100);
  });
}
// ?lsHover=<id>: the pointer over that session's terminal, so a screenshot away from 100% shows the hint
const lsHover = params.get("lsHover");
if (lsHover) waitFor(`.ls-world [data-front="${CSS.escape(lsHover)}"] .term-holder`, (el) => el.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" })));
// ?lsPeek=<id> (below 75%): the pointer resting on that session's workspace, so its peek opens; =<id>,pin keeps it open
const lsPeek = params.get("lsPeek")?.split(",");
// whether a peek was ever drawn (window.__mbPeekSeen), for a test that none opens: one put away straight after leaves
// nothing to find later
if (lsPeek?.[0])
  new MutationObserver((recs) => {
    if (recs.some((r) => [...r.addedNodes].some((n) => n instanceof Element && (n.matches(".ls-peek") || !!n.querySelector(".ls-peek"))))) w.__mbPeekSeen = true;
  }).observe(document.documentElement, { childList: true, subtree: true });
if (lsPeek?.[0])
  waitFor(`.ls-world [data-front="${CSS.escape(lsPeek[0])}"]`, (el) => {
    setTimeout(() => (el.querySelector(".ls-card, .ls-term") ?? el).dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" })), 600);
    if (lsPeek[1] === "pin") setTimeout(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true })), 600 + PEEK_HOVER_MS + 200);
  });
// areas (S4): ?side=closed puts the side bar away, so the area switcher stands in for the area tree (design M);
// ?lsTools=<key> shows that area's hover toolbar; ?lsMenu=members|more opens the first room area's Members ▾, or the
// first area's ⋯; ?lsPick=<id,…> picks those workspaces as a marquee would, and ?lsMakeArea=<name> then makes them an
// area by that name
if (params.get("side") === "closed") set("mb.side", true);
const lsTools = params.get("lsTools");
if (lsTools) {
  const style = document.createElement("style");
  style.textContent = `.ls-area[data-area="${CSS.escape(lsTools)}"] .ls-area-tools { opacity: 1; pointer-events: auto; }`;
  document.head.appendChild(style);
}
const lsMenu = params.get("lsMenu");
if (lsMenu === "members") waitFor(".ls-ah .ls-ah-btn[aria-haspopup]", (el) => setTimeout(() => el.click(), 300));
if (lsMenu === "more") waitFor(".ls-ah .ls-ah-more", (el) => setTimeout(() => el.click(), 300));
// ?lsMenu=ws: s1's ⋯ (its workspace's actions)
if (lsMenu === "ws") waitFor('.ls-world [data-front="s1"] .ls-more', (el) => setTimeout(() => el.click(), 300));
const lsPick = params.get("lsPick")?.split(",");
if (lsPick)
  waitFor(".ls-world .ls-node", () =>
    setTimeout(() => {
      for (const id of lsPick) {
        const el = document.querySelector<HTMLElement>(`.ls-world [data-front="${CSS.escape(id)}"]`);
        (el?.querySelector(".ls-head") ?? el)?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, shiftKey: true, pointerId: 3 }));
      }
      const name = params.get("lsMakeArea");
      if (!name) return;
      setTimeout(() => click('.ls-selbar [data-act="makeArea"]'), 150);
      setTimeout(() => {
        const input = document.querySelector<HTMLInputElement>(".modal input[type=text]");
        if (!input) return console.error("[preview] ?lsMakeArea found no name field");
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, name);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      }, 450);
    }, 400)
  );
// S6b: ?lsKey=<key> presses that key on the landscape once the selection has settled (cmd-g: ⌘G), as ?lsPick=s4,s8&
// lsKey=cmd-g stacks two, or ?lsSelect=area:5101&lsKey=t tidies an area; ?lsDrag=move|resize|tab holds a drag mid-way
// for a screenshot of its guides or size box: s8's header 2 px off the api stack's left edge, s8's right edge 60 px
// wider, or (in a stack) s8's tab over s1. Nothing is released.
const lsKey = params.get("lsKey");
if (lsKey)
  waitFor(".ls-world .ls-node", () =>
    setTimeout(() => {
      const meta = lsKey.startsWith("cmd-");
      const v = document.querySelector<HTMLElement>(".ls-viewport");
      armFocus(v);
      v?.dispatchEvent(new KeyboardEvent("keydown", { key: meta ? lsKey.slice(4) : lsKey, metaKey: meta, bubbles: true, cancelable: true }));
    }, 750)
  );
const lsDrag = params.get("lsDrag");
if (lsDrag)
  waitFor(".ls-world .ls-node", () =>
    setTimeout(() => {
      const q = (sel: string) => document.querySelector<HTMLElement>(`.ls-world ${sel}`);
      const mid = (el: Element) => {
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      };
      const s8 = q('.ls-node[data-front="s8"]');
      const from = lsDrag === "tab" ? q('.ls-tab[data-sid="s8"]') : lsDrag === "resize" ? s8?.querySelector(".ls-rz.r") : s8?.querySelector(".ls-head .ls-spacer");
      const api = q('.ls-node[data-ws="ws:5101/api"]');
      const s1 = q('.ls-node[data-front="s1"] .ls-head .ls-spacer');
      if (!from || (lsDrag === "move" && (!s8 || !api)) || (lsDrag === "tab" && !s1)) return console.error(`[preview] ?lsDrag=${lsDrag} found nothing to drag`);
      const p = mid(from);
      const to = lsDrag === "resize" ? { x: p.x + 60, y: p.y } : lsDrag === "tab" ? mid(s1!) : { x: p.x + api!.getBoundingClientRect().left - s8!.getBoundingClientRect().left + 2, y: p.y + 24 };
      const init = { bubbles: true, cancelable: true, pointerId: 11, button: 0, buttons: 1 };
      from.dispatchEvent(new PointerEvent("pointerdown", { ...init, clientX: p.x, clientY: p.y }));
      for (let i = 1; i <= 6; i++) window.dispatchEvent(new PointerEvent("pointermove", { ...init, clientX: p.x + ((to.x - p.x) * i) / 6, clientY: p.y + ((to.y - p.y) * i) / 6 }));
    }, 1100)
  );
// the selection bar (S6a): ?lsSelect=area:<key> clicks that area's bare patch (its lower right corner) as a person
// would, =ws:<id> that workspace's header (or card), =pick:<id,…> Shift-clicks those after Esc lets the selection go;
// ?lsBarMenu=more|tools|move then opens the bar's ⋯, Tools ▾ or Move to area ▾; ?lsBarExtended starts with the bar's
// folded buttons on a second row
if (params.has("lsBarExtended")) set("mb.landscape.barExtended", true);
const lsSelect = params.get("lsSelect");
if (lsSelect)
  waitFor(".ls-world .ls-node", () =>
    setTimeout(() => {
      const [kind, what = ""] = lsSelect.split(":");
      const viewport = document.querySelector<HTMLElement>(".ls-viewport")!;
      const press = (x: number, y: number, on: Element, init: PointerEventInit = {}) => {
        on.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, buttons: 1, pointerId: 4, clientX: x, clientY: y, ...init }));
        window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, button: 0, pointerId: 4, clientX: x, clientY: y }));
      };
      if (kind === "area") {
        const r = document.querySelector(`.ls-area[data-area="${CSS.escape(what)}"]`)?.getBoundingClientRect();
        if (!r) return console.error(`[preview] ?lsSelect found no area ${what}`);
        press(r.right - 6, r.bottom - 6, viewport);
      } else if (kind === "ws") {
        const el = document.querySelector<HTMLElement>(`.ls-world [data-front="${CSS.escape(what)}"]`);
        const on = el?.querySelector(".ls-head") ?? el;
        if (!on) return console.error(`[preview] ?lsSelect found no workspace ${what}`);
        const r = on.getBoundingClientRect();
        press(r.left + 8, r.top + 8, on);
      } else if (kind === "pick") {
        armFocus(viewport);
        viewport.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
        // one Shift-click a moment, as a person makes them: each adds to what the one before left
        what.split(",").forEach((id, i) =>
          setTimeout(() => {
            const el = document.querySelector<HTMLElement>(`.ls-world [data-front="${CSS.escape(id)}"]`);
            const on = el?.querySelector(".ls-head") ?? el;
            if (!on) return console.error(`[preview] ?lsSelect found no workspace ${id}`);
            const r = on.getBoundingClientRect();
            press(r.left + 8, r.top + 8, on, { shiftKey: true });
          }, 100 * (i + 1))
        );
      }
      const menu = params.get("lsBarMenu");
      if (menu) setTimeout(() => document.querySelector<HTMLElement>(`.ls-selbar [data-act="${menu}"]`)?.click(), 600);
    }, 500)
  );
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
if (params.has("shot") && ((params.has("artifactAdd") && !addWhat) || (params.has("chatMenu") && !params.get("chatMenu")) || params.has("ctx") || params.has("lsMenu") || params.has("lsBarMenu") || params.has("needsTray") || params.has("keysSheet") || params.has("newMenu") || params.has("stripMore") || params.has("lsFinish") || ["pick", "settings", "pop"].includes(params.get("landscapeWiresAudit") ?? ""))) {
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
// ?motionAudit plays the landscape's flight (?landscapeFlyAudit). ?motionDialogs (with ?motion=full or reduce) plays a
// dialog and a toast, finishing every animation rather than waiting on real time, then writes what's left into
// <script id="mb-motion-audit"> for test/uiMotion.test.ts (real time: pageResult): copies left behind, animations
// left holding a frame, the waiting dot's pulse, and the longest animation that ran.
const flyAudit = params.has("landscapeFlyAudit") || params.has("motionAudit");
if (params.has("motionDialogs")) {
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
  const state = () => ({
    ghosts: document.querySelectorAll(".mb-ghost").length,
    // finished but still applying their last frame: a stuck fill
    holding: document.getAnimations().filter((a) => a.playState === "finished").length,
  });
  waitFor(".ls-world .ls-node", async () => {
    await sleep(300);
    const out: Record<string, unknown> = {};
    // Resume a conversation… in the top bar's New menu; the menu's own exit is finished before the dialog's is counted
    document.querySelector<HTMLElement>(".topbar button.primary")?.click();
    await settle();
    [...document.querySelectorAll<HTMLElement>(".mb-ctx:not(.mb-ghost) button")].find((b) => b.querySelector(".mb-ctx-t")?.textContent === "Resume a conversation…")?.click();
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
    out.longest = Math.round(longest);
    out.mode = document.documentElement.dataset.motion;
    const tag = document.createElement("script");
    tag.type = "application/json";
    tag.id = "mb-motion-audit";
    tag.textContent = JSON.stringify(out);
    document.body.appendChild(tag);
  });
}
// ?motionMoments (with ?motion=full, reduce or off) plays motion's second round: the usage popover's bars through a
// report and a context poll that change nothing, then real changes; Sam connecting and leaving (the Connected
// line's dot, his pane's owner badge, his initials in the room's chat); the chat loading its history, a teammate's
// message, your own, and a burst of catching up; your s1 handed over to Nick and s4 continuing one of Nick's. It logs
// every animation started (what it moved, which properties, how long), finishes them rather than waiting, and writes
// what it saw into <script id="mb-motion-moments"> for test/uiMotion.test.ts.
if (params.has("motionMoments")) {
  if (!lsCamera) set("mb.landscape.camera", { x: 0, y: 0, zoom: 1 });
  set("mb.roomChat.room", ROOM_5101);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const what = (el: Element): string => {
    if (el.closest(".usage-bar")) return el.closest(".usage-ctx") ? "bar:context" : "bar:usage";
    if (el.matches(".cl-sub")) return "connected";
    if (el.matches(".team-owner")) return el.classList.contains("mb-ghost") ? "badge:old" : "badge";
    if (el.matches(".rc-initials")) return `dot:${el.closest("[data-member]")?.getAttribute("data-member")}`;
    if (el.matches("[data-member]")) return `member:${el.getAttribute("data-member")}`;
    if (el.matches("[data-entry]")) return `chat:${el.getAttribute("data-entry")}`;
    if (el.matches("[data-handover]")) return `note:${el.closest<HTMLElement>(".ls-node")?.dataset.front}`;
    if (el.matches(".pane")) return `pane:${el.closest<HTMLElement>(".ls-node")?.dataset.front}`;
    if (el.closest(".term-holder")) return "terminal";
    return el.className?.toString() || el.tagName;
  };
  type Started = { what: string; pseudo: string | null; props: string[]; ms: number };
  const started: Started[] = [];
  const animate = Element.prototype.animate;
  Element.prototype.animate = function (this: Element, frames: Keyframe[] | PropertyIndexedKeyframes | null, o?: number | KeyframeAnimationOptions) {
    const props = new Set<string>();
    for (const f of Array.isArray(frames) ? frames : frames ? [frames] : []) for (const k of Object.keys(f)) if (!["offset", "easing", "composite"].includes(k)) props.add(k);
    const opts = typeof o === "object" ? o : { duration: o };
    started.push({ what: what(this), pseudo: opts.pseudoElement ?? null, props: [...props].sort(), ms: Number(opts.duration ?? 0) });
    return animate.call(this, frames, o);
  };
  const since = (mark: number, prefix: string) => started.slice(mark).filter((s) => s.what.startsWith(prefix));
  const until = (selector: string) =>
    new Promise<void>((ok, fail) => {
      let tries = 60;
      const t = setInterval(() => {
        if (!document.querySelector(selector) && --tries > 0) return;
        clearInterval(t);
        if (document.querySelector(selector)) ok();
        else fail(new Error(`the audit found no ${selector}`));
      }, 100);
    });
  const settle = async () => {
    for (let i = 0; i < 6; i++) {
      await sleep(40);
      for (const a of document.getAnimations()) if (Number.isFinite(a.effect?.getComputedTiming().activeDuration ?? Infinity)) a.finish();
    }
    await sleep(40);
  };
  const left = () => ({
    ghosts: document.querySelectorAll(".mb-ghost").length,
    holding: document.getAnimations().filter((a) => a.playState === "finished").length,
    running: document.getAnimations().filter((a) => a.playState === "running" && Number.isFinite(a.effect?.getComputedTiming().activeDuration ?? Infinity)).length,
  });
  // a bar's drawn fill, as a share of its track, to a tenth of a percent
  const bars = () =>
    [...document.querySelectorAll<HTMLElement>(".usage-bar span")].map((s) => Math.round((s.getBoundingClientRect().width / s.parentElement!.getBoundingClientRect().width) * 1000) / 10);
  const setOnline = (ids: string[]) => {
    team.rooms[0].online = ids;
    teamChanged();
    live.remote = live.remote.map((s) => (s.id === SAM_PANE ? { ...s, room: { ...s.room!, online: ids.includes(SAM) } } : s));
    emit("onTeamLive", JSON.parse(JSON.stringify(live)));
  };
  const claude5h = () => usage.claude!.limits[0];
  const samBadge = () => document.querySelector(`.ls-world [data-front="${CSS.escape(SAM_PANE)}"] .team-owner:not(.mb-ghost)`);
  waitFor('.ls-world [data-front="s1"] .xterm', async () => {
    const out: Record<string, unknown> = {};
    try {
      await sleep(400);
      // Sam's is a tab of a stack: in front, its header has his badge
      const samTab = document.querySelector<HTMLElement>(`.ls-world .ls-tab[data-sid="${CSS.escape(SAM_PANE)}"]`);
      samTab?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      samTab?.click();
      await sleep(400);
      // ---- bars ----
      document.querySelector('.ls-world [data-front="s1"] .ls-head')!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      await sleep(100);
      (document.querySelector(".statusbar .usage") as HTMLElement).click();
      await sleep(400);
      let mark = started.length;
      out.barsOpened = { started: since(mark, "bar").length, drawn: bars() };
      // a report that moves a limit by less than a point, and a context poll (every 2 s) that reads the same
      claude5h().usedPct = 38.4;
      emit("onUsageChanged", JSON.parse(JSON.stringify(usage)));
      await sleep(2300);
      out.barsTick = { started: since(mark, "bar") };
      // real changes: the 5-hour limit 38 → 64%, s1's context 27.6 → 52%
      mark = started.length;
      claude5h().usedPct = 64;
      emit("onUsageChanged", JSON.parse(JSON.stringify(usage)));
      contexts.s1 = { ...contexts.s1, tokens: 520_000, at: Date.now() } as ContextWindow;
      await sleep(2300);
      await settle();
      out.barsChanged = { started: since(mark, "bar"), drawn: bars(), ...left() };
      (document.querySelector(".statusbar .usage") as HTMLElement).click();
      await sleep(200);
      await settle();
      // ---- presence ----
      mark = started.length;
      setOnline([NICK, SAM]);
      await sleep(60);
      const ghostBadges = document.querySelectorAll(".team-owner.mb-ghost").length;
      await settle();
      out.samOnline = { started: started.slice(mark), ghostBadges, badge: samBadge()?.className ?? null, ...left() };
      mark = started.length;
      setOnline([NICK]);
      await sleep(60);
      await settle();
      out.samOffline = { started: started.slice(mark), badge: samBadge()?.className ?? null, ...left() };
      // ---- the room's chat ----
      mark = started.length;
      // the Connected line opens the room list (there are two rooms), and 5101's name its chat
      (document.querySelector(".connected-line") as HTMLElement).click();
      await until("button.room-name");
      ([...document.querySelectorAll<HTMLElement>("button.room-name")].find((b) => b.textContent?.startsWith("#5101")) ?? null)?.click();
      await until(".rc-list [data-entry]");
      await sleep(400);
      out.history = { entries: document.querySelectorAll(".rc-list [data-entry]").length, started: since(mark, "chat") };
      mark = started.length;
      setOnline([NICK, SAM]);
      await sleep(60);
      await settle();
      out.memberOnline = { started: started.slice(mark).filter((s) => s.what.endsWith(SAM)), ...left() };
      const say = (author: string, text: string) => {
        const e = chatEntry({ kind: "message", author, at: Date.now(), text, mentions: [] });
        chats[ROOM_5101].push(e);
        return e.id;
      };
      mark = started.length;
      const nick = say(NICK, "Pushed the dropdown fix — have a look?");
      chatChanged(ROOM_5101);
      await sleep(200);
      await settle();
      const el = document.querySelector<HTMLElement>(`[data-entry="${nick}"]`);
      out.arrival = { id: nick, started: since(mark, "chat"), opacity: el ? getComputedStyle(el).opacity : null, transform: el ? getComputedStyle(el).transform : null, ...left() };
      // your own, sent from the composer
      mark = started.length;
      const area = document.querySelector<HTMLTextAreaElement>(".rc-bar textarea")!;
      typeArea(area, "Looking now");
      await sleep(50);
      area.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      await sleep(300);
      out.own = { sent: chats[ROOM_5101].at(-1)?.author === ME && chats[ROOM_5101].at(-1)?.text === "Looking now", started: since(mark, "chat") };
      // catching up: five at once
      mark = started.length;
      for (let i = 0; i < 5; i++) say(NICK, `Catching up ${i + 1}`);
      chatChanged(ROOM_5101);
      await sleep(200);
      out.burst = { started: since(mark, "chat") };
      await settle();
      // ---- changing hands ----
      // s1 handed over to Nick: it continues on his laptop
      mark = started.length;
      live.own.s1 = { ...live.own.s1, takenOver: { by: NICK, byName: "Nick Smith", at: Date.now() } };
      emit("onTeamLive", JSON.parse(JSON.stringify(live)));
      await sleep(100);
      await settle();
      out.handedOver = { started: started.slice(mark), note: !!document.querySelector('.ls-world [data-front="s1"] [data-handover]'), ...left() };
      // s4 continues one of Nick's sessions, taken over here just now
      mark = started.length;
      const nicks = takeoverView.sessions.find((v) => !v.self && !v.takenOver)!;
      nicks.takenOver = { by: ME, at: Date.now(), newSessionId: "s4", snapshot: { sha: nicks.latest.sha, takenAt: nicks.latest.takenAt, source: "peer" }, conversation: "full" };
      nicks.takenOverByName = "You";
      takeoverChanged();
      await sleep(100);
      await settle();
      out.tookOver = { started: started.slice(mark), ...left() };
      out.terminal = started.filter((s) => s.what === "terminal" || (s.what.startsWith("pane:") && s.pseudo !== "::after")).length;
      out.props = [...new Set(started.flatMap((s) => s.props))].sort();
      out.longest = Math.max(0, ...started.map((s) => s.ms));
      out.total = started.length;
    } catch (err) {
      out.error = String((err as Error)?.stack ?? err);
    }
    out.mode = document.documentElement.dataset.motion;
    const tag = document.createElement("script");
    tag.type = "application/json";
    tag.id = "mb-motion-moments";
    tag.textContent = JSON.stringify(out);
    document.body.appendChild(tag);
  });
}
// ?termAudit (with ?motion=full or off) does what re-fits or moves terminals — the side bar and the bottom panel
// shown and hidden, focus and back, another area gone to and back, an area collapsed and opened, another workspace
// gone to, a stack's tab switched, a waiting banner and a stall banner each shown and gone — with terminals full of
// history and output streaming, then
// a Repaint on the normal screen and on the alternate one, and a pane relaunched in place. It finishes animations
// rather than waiting on them, and writes into <script id="mb-term-audit"> for test/uiTerminal.test.ts what was
// wrong after each step: a terminal not at its placement's size, one that overflows its holder or leaves more of it
// empty than a cell and the renderer's rounding account for, a pty not told its terminal's size, a size sent for a
// workspace off screen (no holder to measure) that isn't its placement's; and the pty sizes each step sent. The pty
// sizes are as main has them: a relaunched session's new pty starts at 120×32.
if (params.has("termAudit")) {
  if (!lsCamera) set("mb.landscape.camera", { x: 0, y: 0, zoom: 1 });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  type Entry = import("../renderer/cachedTerm").SizedTerm;
  const terms = () => w.__mbTerms as Map<string, Entry> | undefined;
  const pty: Record<string, string> = {};
  const sent: { id: string; size: string }[] = [];
  const problems: string[] = [];
  const held: { id: string; cols: number; rows: number }[] = [];
  const realResize = api.sessionResize;
  api.sessionResize = async (id: string, cols: number, rows: number) => {
    const entry = terms()?.get(id);
    const holder = entry?.term.element?.parentElement;
    const area = holder?.isConnected && holder.getClientRects().length ? holder.clientWidth * holder.clientHeight : 0;
    // a workspace off screen is held at its placement's size (holdSize), with no holder to measure: checked once a cell's measured
    if (!area) held.push({ id, cols, rows });
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
  // a workspace's terminal is sized from its placement, or the window in focus, never from what its holder measures
  const placedSize = (id: string, inFocus: boolean) => {
    const cell = [...(terms()?.values() ?? [])].map((e) => measuredCell(e.term)).find(Boolean);
    const stack = stackKeyOf(sessions.find((x) => x.id === id)!);
    const box = inFocus ? { w: document.querySelector(".ls-viewport")!.clientWidth, h: document.querySelector(".ls-viewport")!.clientHeight } : stack ? landscape.stacks[stack]?.placement : landscape.workspaces[id];
    return cell && box ? colsRows(box.w, box.h, cell.w, cell.h) : null;
  };
  // how a terminal sits in its holder, in layout pixels (zoom scales both alike). The pty is sized by the font's cell
  // (fontCell), which the WebGL renderer floors to device pixels: at 1× each of its cells is drawn narrower, so a
  // terminal leaves up to cols × that difference of its holder empty on the right, on top of the part of a cell
  // the holder's width doesn't divide into
  const fitOf = (e: Entry) => {
    const holder = e.term.element?.parentElement;
    const screen = e.term.element?.querySelector<HTMLElement>(".xterm-screen");
    const drawn = (e.term as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } } } })._core?._renderService?.dimensions?.css?.cell;
    const font = measuredCell(e.term);
    if (!holder || !screen || !holder.getClientRects().length || holder.classList.contains("fixed") || !drawn?.width || !font) return null;
    const cs = getComputedStyle(holder);
    const w = holder.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const h = holder.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    const lossW = e.term.cols * Math.max(0, font.w - drawn.width);
    const lossH = e.term.rows * Math.max(0, font.h - drawn.height);
    return { w, h, sw: screen.offsetWidth, sh: screen.offsetHeight, allowW: font.w + lossW + 1, allowH: font.h + lossH + 1, lossW };
  };
  const fit = { checked: 0, dpr: window.devicePixelRatio, rounding: 0 };
  const check = (step: string) => {
    for (const h of held.splice(0)) {
      const want = placedSize(h.id, false);
      if (!want || want.cols !== h.cols || want.rows !== h.rows) problems.push(`${step}: ${h.id} was sized ${h.cols}×${h.rows} with no holder, and its placement holds ${want ? `${want.cols}×${want.rows}` : "nothing"}`);
    }
    for (const [id, e] of terms() ?? []) {
      if (!e.term.element?.isConnected || !sessions.some((s) => s.id === id)) continue;
      const size = `${e.term.cols}×${e.term.rows}`;
      const fits = placedSize(id, !!e.term.element.closest(".ls-focus"));
      if (!fits || `${fits.cols}×${fits.rows}` !== size) problems.push(`${step}: ${id} is ${size} in a holder that fits ${fits ? `${fits.cols}×${fits.rows}` : "nothing"}`);
      if (pty[id] !== size) problems.push(`${step}: ${id}'s pty is ${pty[id] ?? "unsized"} under a ${size} terminal`);
      const f = fitOf(e);
      if (!f) continue;
      fit.checked++;
      fit.rounding = Math.max(fit.rounding, Math.round(f.lossW));
      if (f.sw > f.w + 1 || f.sh > f.h + 1) problems.push(`${step}: ${id} is drawn ${f.sw}×${f.sh} in a ${f.w}×${f.h} holder: it overflows`);
      if (f.w - f.sw > f.allowW || f.h - f.sh > f.allowH) problems.push(`${step}: ${id} is drawn ${f.sw}×${f.sh} in a ${f.w}×${f.h} holder: more of it empty than a cell and the renderer's rounding`);
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
  const vp = () => document.querySelector<HTMLElement>(".ls-viewport")!;
  const head = (id: string) => document.querySelector(`.ls-world [data-front="${CSS.escape(id)}"] .ls-head`);
  // selected and at 100%: it's in view, the mouse and the keyboard are its
  const reach = async (id: string) => {
    press(document.querySelector(`.area-tree .lt-ws[data-sid="${CSS.escape(id)}"]`), `${id}'s row`);
    await sleep(400);
    await settle();
    vp().focus();
    vp().dispatchEvent(new KeyboardEvent("keydown", { key: "1", metaKey: true, bubbles: true, cancelable: true }));
    await sleep(300);
    await settle();
  };
  const repaint = async (id: string) => {
    press(document.querySelector(`.ls-world [data-front="${CSS.escape(id)}"] .ls-more`), `${id}'s ⋯`);
    await sleep(200);
    press([...document.querySelectorAll(".mb-ctx button")].find((b) => b.querySelector(".mb-ctx-t")?.textContent === "Repaint"), `${id}'s Repaint`);
  };
  waitFor('.ls-world [data-front="s1"] .xterm', async () => {
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
      const collapse = (area: string) => void api.landscapeUpdate({ areas: { [area]: { collapsed: !landscape.areas[area].collapsed } } });
      const otherTab = () => {
        const tab = document.querySelector('.ls-world [data-ws="ws:5101/api"] .ls-tab:not(.on)');
        tab?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
        press(tab, "a stack's other tab");
      };
      const banners: [string, () => void][] = [
        ["waiting banner shown", () => setSession("s1", { status: "waiting", waitingReason: "Claude needs your permission to use Bash", waitingSince: Date.now() })],
        ["waiting banner gone", () => setSession("s1", { status: "working", waitingReason: null, waitingSince: null })],
        ["stall banner shown", () => setSession("s1", { stalledSince: Date.now() - 5 * min, hooksSilent: true })],
        ["stall banner gone", () => setSession("s1", { stalledSince: null, hooksSilent: false })],
      ];
      const panels: [string, () => void][] = [
        ["side bar hidden", () => key("\\")],
        ["side bar shown", () => key("\\")],
        ["bottom panel shown", () => key("j")],
        ["bottom panel hidden", () => key("j")],
      ];
      const steps: [string, () => void | Promise<void>][] = [
        ...panels,
        ["focus", async () => {
          head("s1")?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
          await sleep(100);
          vp().focus();
          vp().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
        }],
        ["back from focus", () => void document.querySelector(".ls-focus")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", metaKey: true, bubbles: true, cancelable: true }))],
        ["another area gone to", () => press(row(".area-tree .lt-head", "#5102"), "area #5102")],
        ["back to the area", () => reach("s1")],
        ["area collapsed", () => collapse("5101")],
        ["area opened", async () => {
          collapse("5101");
          await sleep(300);
          await reach("s1");
        }],
        ["another workspace gone to", () => press(row(".area-tree .lt-ws", "Release notes"), "Release notes row")],
        ["stack's tab switched", async () => {
          await reach("s2");
          otherTab();
        }],
        ["stack's tab switched back", otherTab],
        ...banners,
      ];
      const done: string[] = [];
      const resized: Record<string, string[]> = {};
      for (const [step, act] of steps) {
        const mark = sent.length;
        await act();
        await sleep(400); // a row's click waits out a double-click
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
      await reach("s1");
      const before = { lines: buffer("s1")?.length ?? 0, first: buffer("s1")?.getLine(0)?.translateToString(true) };
      let mark = sent.length;
      await repaint("s1");
      await sleep(300);
      const s1 = terms()?.get("s1")?.term;
      out.repaint = { before, after: { lines: buffer("s1")?.length ?? 0, first: buffer("s1")?.getLine(0)?.translateToString(true) }, size: s1 ? `${s1.cols}×${s1.rows}` : null, sent: sent.slice(mark).filter((r) => r.id === "s1").map((r) => r.size) };
      // Repaint on the alternate screen, with the program's mouse tracking on
      await reach("s4");
      say("s4", "\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[Ha full-screen program");
      await sleep(100);
      const s4 = terms()?.get("s4")?.term;
      const modes = () => ({ screen: s4?.buffer.active.type, mouse: s4?.modes.mouseTrackingMode });
      const altBefore = modes();
      await repaint("s4");
      await sleep(300);
      out.repaintAlt = { before: altBefore, after: modes() };
      // the process dies, and is relaunched under the same id: main starts the new pty at 120×32
      await reach("s1");
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
    out.fit = fit;
    out.mode = document.documentElement.dataset.motion;
    const tag = document.createElement("script");
    tag.type = "application/json";
    tag.id = "mb-term-audit";
    tag.textContent = JSON.stringify(out);
    document.body.appendChild(tag);
  });
}
// ?landscapeAudit works the landscape as a person would and writes what each step did into
// <script id="mb-landscape-audit"> for test/uiLandscape.test.ts: every own workspace's terminal and pty against
// colsRows of its placement with the terminal's measured cell; the pty sizes sent while it's panned (wheel, Space-
// and middle-drag) and zoomed (pinch, ⌘-scroll, ⌘0, ⌘1), and whether the point under the cursor stayed put; keys
// and a wheel inside a terminal; a placement changed; focus on your own workspace and back (Esc typed in its
// terminal, ⌘Esc), and on a teammate's; ⌥→. Sizes are read after each step settles, never mid-gesture.
if (["landscapeAudit", "landscapeMouseAudit", "landscapeZoomAudit", "landscapePeekAudit", "landscapeRemoteAudit", "landscapeRestartAudit", "landscapeAreasAudit", "landscapeAreaEdgesAudit", "landscapeFlyAudit", "landscapeToolsAudit", "landscapeReviewAudit", "landscapeReadOnlyAudit", "landscapeBarAudit", "landscapeGhostAudit", "landscapeGhostLifeAudit", "landscapeArrangeAudit", "landscapeClosedAudit", "landscapeFixAudit"].some((k) => params.has(k)) || flyAudit) {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  type Term = import("@xterm/xterm").Terminal;
  const term = (id: string) => (w.__mbTerms as Map<string, { term: Term }> | undefined)?.get(id)?.term;
  const resizes = () => calls.filter((c) => c.fn === "sessionResize").map((c) => `${c.args[0]} ${c.args[1]}×${c.args[2]}`);
  const vp = () => document.querySelector<HTMLElement>(".ls-viewport")!;
  const node = (id: string, where = ".ls-world") => document.querySelector<HTMLElement>(`${where} [data-front="${CSS.escape(id)}"]`);
  const camera = () => {
    const m = /scale\(([-\d.e]+)\) translate\(([-\d.e]+)px, ([-\d.e]+)px\)/.exec(document.querySelector<HTMLElement>(".ls-world")?.style.transform ?? "");
    return m ? { zoom: Number(m[1]), x: -Number(m[2]), y: -Number(m[3]) } : null;
  };
  const want = (id: string, size: { w: number; h: number }) => {
    const c = measuredCell(term(id)!);
    if (!c) return `${id} isn't measured`;
    const t = colsRows(size.w, size.h, c.w, c.h);
    return `${t.cols}×${t.rows}`;
  };
  const sizeOf = (id: string) => `${term(id)?.cols}×${term(id)?.rows}`;
  const at = (el: Element, dx = 0.5, dy = 0.5) => {
    const r = el.getBoundingClientRect();
    return { clientX: r.left + r.width * dx, clientY: r.top + r.height * dy };
  };
  const wheel = (el: Element, init: WheelEventInit) => el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, ...at(el, 0.3, 0.3), ...init }));
  // with its keyCode, which xterm reads keys by: a key typed into a terminal is one xterm acts on
  const CODES: Record<string, number> = { Escape: 27, Enter: 13, " ": 32, ArrowRight: 39, ArrowLeft: 37, "0": 48, "1": 49, "=": 187, e: 69, a: 65 };
  const key = (el: Element, k: string, mods: KeyboardEventInit = {}) => {
    const ev = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...mods });
    Object.defineProperty(ev, "keyCode", { get: () => CODES[k] ?? 0 });
    return el.dispatchEvent(ev);
  };
  const keyUp = (el: Element, k: string) => el.dispatchEvent(new KeyboardEvent("keyup", { key: k, bubbles: true, cancelable: true }));
  const pointer = (el: Element, type: string, init: PointerEventInit) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, ...init }));
  const drag = (el: Element, button: number) => {
    const p = at(el);
    pointer(el, "pointerdown", { ...p, button, buttons: button === 1 ? 4 : 1 });
    pointer(vp(), "pointermove", { clientX: p.clientX - 140, clientY: p.clientY - 90 });
    pointer(vp(), "pointerup", { clientX: p.clientX - 140, clientY: p.clientY - 90, button });
  };
  // a press on a workspace's header (a card's anywhere): it's selected, and the landscape keeps the keyboard, armed, as
  // the press's own focus move (which a dispatched pointerdown doesn't make) gives it
  const pick = async (id: string) => {
    pointer(node(id)!.querySelector(".ls-head") ?? node(id)!, "pointerdown", { button: 0 });
    armFocus(vp());
    await sleep(150);
  };
  // its row in the area tree, its area opened first when it's closed
  const treeRow = async (id: string) => {
    const find = () => document.querySelector<HTMLElement>(`.area-tree .lt-ws[data-sid="${CSS.escape(id)}"]`);
    const s = sessions.find((x) => x.id === id);
    if (!find() && s) {
      document.querySelector<HTMLElement>(`.area-tree .lt-area[data-area="${CSS.escape(areaKeyOf(s))}"] .lt-chev`)?.click();
      await sleep(50);
    }
    const row = find();
    if (!row) throw new Error(`${id} has no row in the area tree`);
    return row;
  };
  // its tree row: selected, and brought into view (only workspaces on screen have a terminal attached)
  const reveal = async (id: string) => {
    (await treeRow(id)).click();
    await sleep(400);
  };
  const ownShown = ["s1", "s2", "s4", "s5", "s7", "s8"];
  if (params.has("landscapeAudit")) waitFor('.ls-world [data-front="s1"] .xterm', async () => {
    const out: Record<string, unknown> = {};
    try {
      await sleep(800);
      out.placed = [];
      for (const id of ownShown) {
        await reveal(id);
        const s = sessions.find((x) => x.id === id)!;
        const stack = stackKeyOf(s);
        const p = stack ? landscape.stacks[stack].placement : landscape.workspaces[id];
        const holder = term(id)?.element?.parentElement;
        (out.placed as unknown[]).push({ id, want: want(id, p), term: sizeOf(id), pty: resizes().filter((r) => r.startsWith(`${id} `)).pop() ?? null, holder: holder ? `${holder.clientWidth}×${holder.clientHeight}` : null, room: `${p.w - WORKSPACE_CHROME.w}×${p.h - WORKSPACE_CHROME.h}` });
      }
      // s8 in view with s4 beside it, and s4 selected: s8's terminal is one whose workspace isn't
      await pick("s4");
      // the fixture places every workspace at its M preset: an agent of 140 × 42 and a terminal of 120 × 24
      out.presets = { s1: sizeOf("s1"), s4: sizeOf("s4") };

      // pan and zoom
      let mark = resizes().length;
      const cam0 = camera();
      wheel(vp(), { deltaX: 40, deltaY: 120 });
      const afterWheel = camera();
      // a wheel over a workspace that isn't selected moves the landscape too
      wheel(node("s8")!.querySelector(".term-holder")!, { deltaY: 90 });
      const afterWheelOver = camera();
      armFocus(vp());
      key(vp(), " ");
      drag(node("s4")!.querySelector(".term-holder")!, 0);
      keyUp(vp(), " ");
      const afterSpace = camera();
      drag(node("s8")!.querySelector(".term-holder")!, 1);
      const afterMiddle = camera();
      // a pinch about a point: the landscape point under it stays under it
      const r = vp().getBoundingClientRect();
      const p = { x: 420, y: 260 };
      const under = (c: ReturnType<typeof camera>) => c && { x: c.x + p.x / c.zoom, y: c.y + p.y / c.zoom };
      const before = under(camera());
      vp().dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: r.left + p.x, clientY: r.top + p.y, deltaY: -30, ctrlKey: true }));
      const pinched = camera();
      const afterPinch = under(pinched);
      vp().dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: r.left + p.x, clientY: r.top + p.y, deltaY: 200, metaKey: true }));
      const cmdScrolled = camera();
      armFocus(vp());
      key(vp(), "0", { metaKey: true });
      const fitted = camera();
      // long enough for the cards band to take over, so coming back attaches terminals again
      await sleep(400);
      const cardsAtFit = document.querySelectorAll(".ls-world .ls-node.card").length;
      key(vp(), "1", { metaKey: true });
      const hundred = camera();
      await sleep(400);
      out.panZoom = {
        cardsAtFit,
        resized: resizes().slice(mark),
        wheel: JSON.stringify(afterWheel) !== JSON.stringify(cam0),
        wheelOver: JSON.stringify(afterWheelOver) !== JSON.stringify(afterWheel),
        space: JSON.stringify(afterSpace) !== JSON.stringify(afterWheelOver),
        middle: JSON.stringify(afterMiddle) !== JSON.stringify(afterSpace),
        pinch: { zoomIn: (pinched?.zoom ?? 0) > (afterMiddle?.zoom ?? 0), drift: before && afterPinch ? Math.hypot(before.x - afterPinch.x, before.y - afterPinch.y) : null },
        cmdScroll: (cmdScrolled?.zoom ?? 1) < (pinched?.zoom ?? 0),
        fit: fitted?.zoom ?? null,
        hundred: hundred?.zoom ?? null,
        // nothing re-fitted the terminals: each still holds its placement's size
        sizes: ownShown.map((id) => sizeOf(id)),
      };

      // keys and a wheel inside a terminal are the terminal's
      await pick("s1");
      const area = node("s1")!.querySelector("textarea")!;
      area.focus();
      const cam1 = camera();
      key(area, "0", { metaKey: true });
      key(area, "1", { metaKey: true });
      key(area, "=", { metaKey: true });
      key(area, "Enter");
      key(area, "ArrowRight", { altKey: true });
      key(area, " ");
      wheel(node("s1")!.querySelector(".term-holder")!, { deltaY: 100 });
      await sleep(200);
      out.typing = { camera: JSON.stringify(camera()) === JSON.stringify(cam1), focused: !!document.querySelector(".ls-focus"), selected: document.querySelector(".ls-world .ls-node.selected")?.getAttribute("data-ws") ?? null };

      // a placement changed: its pty is told once
      mark = resizes().length;
      const p1 = landscape.workspaces.s1;
      const bigger = { ...p1, w: p1.w + 160, h: p1.h + 84 };
      await api.landscapeUpdate({ workspaces: { s1: bigger } });
      await sleep(400);
      out.placement = { sent: resizes().slice(mark), want: `s1 ${want("s1", bigger)}`, term: sizeOf("s1") };

      // focus on your own workspace: it reflows to the window, and back to its placement
      await pick("s1");
      armFocus(vp());
      mark = resizes().length;
      key(vp(), "Enter");
      await sleep(400);
      const v = { w: vp().clientWidth, h: vp().clientHeight };
      const inFocus = () => !!document.querySelector(".ls-focus .ls-node");
      out.focusOwn = { entered: inFocus(), sent: resizes().slice(mark), want: `s1 ${want("s1", v)}`, keyboard: !!document.activeElement?.closest(".ls-focus .xterm") };
      // Esc typed in its terminal is the terminal's
      const writes = () => calls.filter((c) => c.fn === "sessionWrite" && c.args[0] === "s1" && c.args[1] === "\x1b").length;
      const w0 = writes();
      const fArea = document.querySelector<HTMLTextAreaElement>(".ls-focus textarea")!;
      fArea.focus();
      key(fArea, "Escape");
      await sleep(200);
      out.escInTerminal = { stillFocused: inFocus(), wroteEsc: writes() - w0 };
      mark = resizes().length;
      key(fArea, "Escape", { metaKey: true });
      await sleep(400);
      out.back = { left: !inFocus(), sent: resizes().slice(mark), want: `s1 ${want("s1", bigger)}`, keyboard: document.activeElement === vp() };
      // ⌘E in, Esc outside the terminal out
      await pick("s1");
      key(vp(), "e", { metaKey: true });
      await sleep(300);
      const viaCmdE = inFocus();
      pointer(document.querySelector(".ls-focus .ls-head")!, "pointerdown", { button: 0 });
      // the press's own focus move: the focus frame has the keyboard, armed
      armFocus(document.querySelector<HTMLElement>(".ls-focus"));
      await sleep(100);
      key(document.activeElement ?? document.body, "Escape");
      await sleep(300);
      out.cmdE = { entered: viaCmdE, leftByEsc: !inFocus() };

      // focus on a teammate's workspace: only scaled, never resized
      await sleep(200);
      mark = resizes().length;
      // picked first: selected, its terminal is attached wherever it is
      await pick(NICK_PANE);
      const fontBefore = term(NICK_PANE)?.options.fontSize ?? null;
      const ownerSize = sizeOf(NICK_PANE);
      key(vp(), "Enter");
      await sleep(500);
      const remoteIn = { entered: inFocus(), font: term(NICK_PANE)?.options.fontSize ?? null, size: sizeOf(NICK_PANE) };
      key(document.activeElement ?? document.body, "Escape");
      await sleep(400);
      const room = live.remote.find((x) => x.id === NICK_PANE)?.room;
      out.focusRemote = { id: NICK_PANE, ...remoteIn, fontBefore, ownerSize, ownerRoom: room ? `${room.cols}×${room.rows}` : null, left: !inFocus(), sent: resizes().slice(mark), fontAfter: term(NICK_PANE)?.options.fontSize ?? null };

      // a stack's tab switched in focus: the member leaving the front goes back to the stack's size, and the one
      // coming in fills the window until focus ends
      await pick("s2");
      armFocus(vp());
      mark = resizes().length;
      key(vp(), "Enter");
      await sleep(500);
      const tab = [...document.querySelectorAll<HTMLElement>(".ls-focus .ls-tab")].find((t) => !t.classList.contains("on"));
      pointer(tab!, "pointerdown", { button: 0 });
      tab!.click();
      await sleep(600);
      const front = document.querySelector(".ls-focus .ls-node")?.getAttribute("data-front") ?? null;
      key(document.querySelector(".ls-focus")!, "Escape", { metaKey: true });
      await sleep(500);
      const stack = landscape.stacks["5101/api"].placement;
      const win = { w: vp().clientWidth, h: vp().clientHeight };
      out.stackTab = {
        front,
        left: !inFocus(),
        sent: resizes().slice(mark),
        want: [`s2 ${want("s2", win)}`, `s2 ${want("s2", stack)}`, `s3 ${want("s3", win)}`, `s3 ${want("s3", stack)}`],
        sizes: [sizeOf("s2"), sizeOf("s3")],
        stackSize: want("s3", stack),
      };

      // ⌘E from anywhere: a session just picked in the side bar, and a terminal whose workspace isn't selected
      const row = await treeRow("s5");
      row.focus();
      row.click();
      await sleep(300);
      key(row, "e", { metaKey: true });
      await sleep(400);
      const fromSidebar = document.querySelector(".ls-focus .ls-node")?.getAttribute("data-front") ?? null;
      key(document.activeElement ?? document.body, "Escape", { metaKey: true });
      await sleep(400);
      // s8 in view, then s1 selected
      await reveal("s8");
      await pick("s1");
      const other = node("s8")!.querySelector("textarea")!;
      other.focus();
      key(other, "e", { metaKey: true });
      await sleep(400);
      const fromTerminal = document.querySelector(".ls-focus .ls-node")?.getAttribute("data-front") ?? null;
      key(document.activeElement ?? document.body, "Escape", { metaKey: true });
      await sleep(400);
      out.cmdEAnywhere = { fromSidebar, fromTerminal, left: !inFocus() };

      // ⌥→ from s1: the nearest workspace to its right, brought to the middle
      await pick("s1");
      armFocus(vp());
      const cam2 = camera();
      key(vp(), "ArrowRight", { altKey: true });
      await sleep(200);
      out.nearest = { selected: document.querySelector(".ls-world .ls-node.selected")?.getAttribute("data-ws") ?? null, moved: JSON.stringify(camera()) !== JSON.stringify(cam2) };
    } catch (err) {
      out.error = String(err instanceof Error ? err.stack : err);
    }
    const tag = document.createElement("script");
    tag.type = "application/json";
    tag.id = "mb-landscape-audit";
    tag.textContent = JSON.stringify(out);
    document.body.appendChild(tag);
  });

  // ?landscapeMouseAudit (with ?lsCamera=0,0,<zoom>): a drag across s1's terminal, a click with the mouse reported
  // to its program, the hint over a terminal and a double-click, each pressed where a person would, at the cell's
  // centre on screen and on whatever is there (elementFromPoint), into <script id="mb-landscape-mouse-audit">
  if (params.has("landscapeMouseAudit")) waitFor('.ls-world [data-front="s1"] .xterm', async () => {
    const out: Record<string, unknown> = {};
    try {
      await sleep(800);
      const t = term("s1")!;
      const cellAt = (col: number, row: number) => {
        const r = t.element!.querySelector(".xterm-screen")!.getBoundingClientRect();
        return { clientX: r.left + ((col + 0.5) * r.width) / t.cols, clientY: r.top + ((row + 0.5) * r.height) / t.rows };
      };
      const there = (p: { clientX: number; clientY: number }) => document.elementFromPoint(p.clientX, p.clientY)!;
      const mouse = (type: string, p: { clientX: number; clientY: number }, buttons: number) => {
        const el = there(p);
        if (type === "mousedown") el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, buttons, ...p }));
        if (type === "mouseup") el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, buttons, ...p }));
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, view: window, button: 0, buttons, detail: type === "dblclick" ? 2 : 1, ...p }));
        return el;
      };
      const reports = () => calls.filter((c) => c.fn === "sessionWrite" && c.args[0] === "s1" && String(c.args[1]).includes("\x1b[<")).map((c) => String(c.args[1]));
      const rel = (pos: { x: number; y: number }) => ({ col: pos.x, row: pos.y - t.buffer.active.viewportY });
      const zoom = camera()?.zoom ?? null;

      // a drag from cell (60, 6) to (80, 9), 0-based
      const from = cellAt(60, 6);
      const to = cellAt(80, 9);
      const pressed = mouse("mousedown", from, 1);
      mouse("mousemove", cellAt(70, 8), 1);
      mouse("mousemove", to, 1);
      mouse("mouseup", to, 0);
      mouse("click", to, 0);
      await sleep(200);
      const sel = t.hasSelection() ? t.getSelectionPosition() : undefined;
      out.drag = {
        zoom,
        on: pressed.closest(".xterm") ? "xterm" : pressed.closest(".term-holder") ? "holder" : pressed.className,
        selection: sel ? { start: rel(sel.start), end: rel(sel.end) } : null,
        selected: document.querySelector(".ls-world .ls-node.selected")?.getAttribute("data-ws") ?? null,
        keyboard: !!document.activeElement?.closest('.ls-world [data-front="s1"] .xterm'),
      };
      t.clearSelection();

      // the program asks for the mouse (SGR reports): a click is reported to it only where it lands right
      t.write("\x1b[?1000h\x1b[?1006h");
      await sleep(150);
      const r0 = reports().length;
      mouse("mousedown", cellAt(10, 3), 1);
      mouse("mouseup", cellAt(10, 3), 0);
      mouse("click", cellAt(10, 3), 0);
      await sleep(200);
      out.report = { mode: t.modes.mouseTrackingMode, sent: reports().slice(r0) };
      t.write("\x1b[?1000l\x1b[?1006l");

      // the hint, over a terminal and off it
      const hint = document.querySelector<HTMLElement>(".ls-hint");
      there(cellAt(30, 4)).dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse", ...cellAt(30, 4) }));
      await sleep(50);
      // read where its fade ends, never mid-way
      const settled = () => hint?.getAnimations().forEach((a) => a.finish());
      settled();
      const over = hint ? getComputedStyle(hint).opacity : null;
      vp().dispatchEvent(new PointerEvent("pointerleave", { pointerType: "mouse" }));
      await sleep(50);
      settled();
      out.hint = { text: hint?.textContent ?? null, over, off: hint ? getComputedStyle(hint).opacity : null };

      // a double-click: focus away from 100%, a word selected at it
      mouse("mousedown", cellAt(2, 1), 1);
      mouse("mouseup", cellAt(2, 1), 0);
      mouse("click", cellAt(2, 1), 0);
      mouse("mousedown", cellAt(2, 1), 1);
      mouse("mouseup", cellAt(2, 1), 0);
      mouse("click", cellAt(2, 1), 0);
      mouse("dblclick", cellAt(2, 1), 0);
      await sleep(400);
      out.dblclick = { focused: !!document.querySelector(".ls-focus .ls-node") };
    } catch (err) {
      out.error = String(err instanceof Error ? err.stack : err);
    }
    const tag = document.createElement("script");
    tag.type = "application/json";
    tag.id = "mb-landscape-mouse-audit";
    tag.textContent = JSON.stringify(out);
    document.body.appendChild(tag);
  });

  const report = (id: string, out: Record<string, unknown>) => {
    const tag = document.createElement("script");
    tag.type = "application/json";
    tag.id = id;
    tag.textContent = JSON.stringify(out);
    document.body.appendChild(tag);
  };
  const zoomNow = () => camera()?.zoom ?? NaN;
  /**
   * A pinch about viewport point `p` (the viewport's centre unless given) until the zoom is `z`, at most `step` (×2)
   * an event, an event a frame; `each` after every one.
   */
  const pinchTo = async (z: number, p?: { x: number; y: number }, o: { step?: number; each?: () => void } = {}) => {
    const r = vp().getBoundingClientRect();
    const at = p ?? { x: r.width / 2, y: r.height / 2 };
    const most = o.step ? Math.log(o.step) / 0.01 : 69;
    for (let i = 0; i < 80 && Math.abs(zoomNow() - z) > 1e-4; i++) {
      vp().dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: r.left + at.x, clientY: r.top + at.y, ctrlKey: true, deltaY: Math.max(-most, Math.min(most, -Math.log(z / zoomNow()) / 0.01)) }));
      await sleep(16);
      o.each?.();
    }
  };
  const keyOf = (el: Element) => el.closest<HTMLElement>(".ls-node")?.dataset.ws ?? "";
  /** The workspaces with an xterm attached, and those on screen, partly or wholly, and within a quarter of the viewport past its edges. */
  const where = () => {
    const v = vp().getBoundingClientRect();
    const mx = v.width * 0.25;
    const my = v.height * 0.25;
    const nodes = [...document.querySelectorAll<HTMLElement>(".ls-world .ls-node")];
    const hit = (n: HTMLElement, m: { x: number; y: number }) => {
      const r = n.getBoundingClientRect();
      return r.right > v.left - m.x && r.left < v.right + m.x && r.bottom > v.top - m.y && r.top < v.bottom + m.y;
    };
    return {
      zoom: zoomNow(),
      attached: nodes.filter((n) => n.querySelector(".xterm")).map(keyOf),
      panes: document.querySelectorAll(".ls-world .pane").length,
      cards: document.querySelectorAll(".ls-world .ls-node.card").length,
      visible: nodes.filter((n) => hit(n, { x: 0, y: 0 })).map(keyOf),
      near: nodes.filter((n) => hit(n, { x: mx, y: my })).map(keyOf),
      selected: document.querySelector(".ls-world .ls-node.selected")?.getAttribute("data-ws") ?? null,
      webgl: (w.__mbWebglCount as (() => number) | undefined)?.() ?? null,
      // contexts made and not lost: what Chromium counts against its limit, given up or not
      glAlive: (w.__mbGlAlive as (() => number) | undefined)?.() ?? null,
      canvases: [...document.querySelectorAll(".ls-world .xterm-screen")].filter((s) => s.querySelector("canvas")).length,
    };
  };
  const linesOf = (t: Term) => {
    const b = t.buffer.active;
    const out: string[] = [];
    for (let y = 0; y < b.length; y++) out.push(b.getLine(y)?.translateToString(true) ?? "");
    while (out.length && !out[out.length - 1]) out.pop();
    return out;
  };
  const writesTo = (id: string) => calls.filter((c) => c.fn === "sessionWrite" && c.args[0] === id).map((c) => String(c.args[1]));

  // ?landscapeZoomAudit (with ?landscapeMany=30): which workspaces get an xterm at fit, 60% and 100% and after a pan;
  // the pty sizes sent across all of it (none); a terminal detached at fit, written to while it's a card and
  // attached again; keys typed into a terminal at 60%, and one that had the keyboard as the zoom went down; and how
  // many draw with WebGL (with ?glMax or ?glFail, what's said about the rest). Into <script id="mb-landscape-zoom-audit">.
  if (params.has("landscapeZoomAudit")) waitFor(".ls-world .ls-node", async () => {
    const out: Record<string, unknown> = {};
    try {
      await sleep(1500);
      out.fit = where();
      // the cell the cards' ptys were sized by, with nothing attached yet
      out.cellAtFit = (w.__mbLandscapeCell as (() => { w: number; h: number } | null) | undefined)?.() ?? null;
      const mark = resizes().length;
      await pinchTo(0.6);
      await sleep(700);
      out.readonly = where();
      await pinchTo(1);
      await sleep(700);
      out.live = where();
      // a pan of one and a half screens to the right at 100%, a trackpad's events at a time
      for (let i = 0; i < 40; i++) {
        vp().dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaX: (vp().clientWidth * 1.5) / 40 }));
        await sleep(16);
      }
      await sleep(500);
      out.panned = where();

      // an agent's terminal in view, idle if there's one (nothing redraws its last line): its buffer before it's detached
      const seen = (out.panned as ReturnType<typeof where>).visible.map((k) => sessions.find((s) => s.id === k)!).filter((s) => !s.shell);
      const id = (seen.find((s) => s.status === "idle") ?? seen[0]).id;
      const t0 = term(id)!;
      const before = linesOf(t0);
      const atBefore = t0.element?.closest(".ls-node")?.getAttribute("data-ws") ?? null;
      key(vp(), "0", { metaKey: true });
      await sleep(700);
      out.fitAgain = where();
      const more = `\r\nwhile it was a card: line ${Date.now()}\r\n`;
      buffers[id] += more;
      emit("onSessionData", id, more);
      await sleep(300);
      const detached = !t0.element?.isConnected;
      // back to 100% about its workspace
      const r = node(id)!.getBoundingClientRect();
      const v = vp().getBoundingClientRect();
      await pinchTo(1, { x: r.left + r.width / 2 - v.left, y: r.top + r.height / 2 - v.top });
      await sleep(700);
      const t1 = term(id)!;
      const after = linesOf(t1);
      out.scrollback = {
        id,
        atBefore,
        detached,
        same: t1 === t0,
        attachedTo: t1.element?.isConnected ? (t1.element.closest(".ls-node")?.getAttribute("data-ws") ?? null) : null,
        inHolder: !!t1.element?.parentElement?.classList.contains("term-holder"),
        // every line it had (but a spinner's, which redraws itself), where it was
        kept: before.length > 20 && before.slice(0, -1).every((l, i) => after[i] === l),
        added: after.some((l) => l.startsWith("while it was a card")),
      };
      out.crossed = resizes().slice(mark);

      // 60%: a press on a terminal selects its workspace and the landscape keeps the keyboard; keys reaching a
      // terminal that had it are the landscape's, never the terminal's
      await pinchTo(0.6, { x: r.left + r.width / 2 - v.left, y: r.top + r.height / 2 - v.top });
      await sleep(700);
      const w0 = writesTo(id).length;
      pointer(node(id)!.querySelector(".term-holder")!, "pointerdown", { button: 0 });
      window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0 }));
      await sleep(150);
      const clickKeyboard = document.activeElement === vp() ? "landscape" : document.activeElement?.closest(".xterm") ? "terminal" : String(document.activeElement?.tagName);
      term(id)!.textarea!.focus();
      const typedIn = document.activeElement === term(id)!.textarea;
      key(term(id)!.textarea!, "a");
      key(term(id)!.textarea!, "Enter");
      await sleep(150);
      out.readonlyKeys = { selected: document.querySelector(".ls-world .ls-node.selected")?.getAttribute("data-ws") === id, clickKeyboard, typedIn, wrote: writesTo(id).slice(w0), keyboard: document.activeElement === vp() ? "landscape" : "elsewhere" };
      // 100%: the terminal takes keys; zoomed down with the keyboard in it, the landscape takes the keyboard back
      await pinchTo(1, { x: r.left + r.width / 2 - v.left, y: r.top + r.height / 2 - v.top });
      await sleep(500);
      term(id)!.textarea!.focus();
      key(term(id)!.textarea!, "Enter");
      await sleep(100);
      const liveWrote = writesTo(id).slice(w0);
      await pinchTo(0.6, { x: r.left + r.width / 2 - v.left, y: r.top + r.height / 2 - v.top });
      await sleep(500);
      out.zoomedDown = { liveWrote, keyboard: document.activeElement === vp() ? "landscape" : document.activeElement?.closest(".xterm") ? "terminal" : String(document.activeElement?.tagName) };
      out.cellMeasured = measuredCell(term(id)!);

      // a pinch out from 100% to 25%, a frame at a time: what it attaches on the way, and the WebGL contexts it makes
      await pinchTo(1, { x: r.left + r.width / 2 - v.left, y: r.top + r.height / 2 - v.top });
      await sleep(700);
      const from = where();
      const madeBefore = (w.__mbGlMade as (() => number) | undefined)?.() ?? 0;
      let most = 0;
      const count = () => (most = Math.max(most, document.querySelectorAll(".ls-world .xterm").length));
      await pinchTo(0.25, undefined, { step: 1.06, each: count });
      const madeOnTheWay = ((w.__mbGlMade as (() => number) | undefined)?.() ?? 0) - madeBefore;
      await sleep(700);
      out.pinchOut = { from: from.attached.length, most, made: madeOnTheWay, end: where() };

      out.said = said.filter((m) => m.includes("DOM renderer") || m.includes("WebGL"));
      out.resizedAtAll = resizes().slice(mark);
      // from the page's start: every pty told one size, at most
      out.ptySizes = resizes();
    } catch (err) {
      out.error = String(err instanceof Error ? err.stack : err);
    }
    report("mb-landscape-zoom-audit", out);
  });

  // ?landscapePeekAudit (with ?motion=full or reduce): the peek of s1's card at fit (how long the pointer rests before it
  // opens, where its terminal goes, its motion's end state); the pointer moving over the peek, which covers its card,
  // off the card onto the bare landscape under it and straight onto another card; Space keeping it open, and closing
  // it; a click keeping it open, and a press outside closing it; the peek of s1 read-only at 50% (the stand-in its
  // workspace shows, the terminal handed back with its scrollback and size); a double-click on it, and Enter on a
  // kept-open one, focusing its workspace; none while Space is held; and a kept-open one's wheel scrolling its
  // terminal. The pointer's moves and clicks land on what the page hit-tests at their point, as a browser's do. Into
  // <script id="mb-landscape-peek-audit">.
  if (params.has("landscapePeekAudit")) waitFor('.ls-world [data-front="s1"] .ls-card', async () => {
    const out: Record<string, unknown> = {};
    const peekEl = () => document.querySelector<HTMLElement>(".ls-peek");
    const over = (el: Element) => el.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }));
    const inPeek = (id: string) => !!term(id)?.element?.isConnected && !!term(id)?.element?.closest(".ls-peek");
    /** Long enough a rest for a peek to have opened. */
    const REST = PEEK_HOVER_MS + 150;
    const space = () => window.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
    const esc = () => (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    /** The pointer moved to (x, y): what the page hits there gets the move, a peek over a workspace included. */
    const hoverAt = (x: number, y: number) => {
      const el = document.elementFromPoint(x, y);
      for (const type of ["pointerover", "pointermove"]) el?.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "mouse", pointerId: 7, clientX: x, clientY: y }));
      return el;
    };
    /** A click at (x, y) on what the page hits there; `twice`, a double-click. */
    const clickAt = (x: number, y: number, twice = false) => {
      const el = document.elementFromPoint(x, y)!;
      const at = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 };
      for (let i = 1; i <= (twice ? 2 : 1); i++) {
        el.dispatchEvent(new PointerEvent("pointerdown", { ...at, pointerType: "mouse", pointerId: 7, buttons: 1 }));
        el.dispatchEvent(new PointerEvent("pointerup", { ...at, pointerType: "mouse", pointerId: 7 }));
        el.dispatchEvent(new MouseEvent("click", { ...at, detail: i }));
      }
      if (twice) el.dispatchEvent(new MouseEvent("dblclick", { ...at, detail: 2 }));
      return el;
    };
    const centre = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    };
    /** What the pointer would be over at (x, y) were the peek not there. */
    const under = (x: number, y: number) => document.elementsFromPoint(x, y).find((e) => !e.closest(".ls-peek")) ?? null;
    /** A point on the peek over the bare landscape: off its workspace, and off every other one. */
    const bareUnderPeek = () => {
      const r = peekEl()?.getBoundingClientRect();
      if (!r) return null;
      for (let fy = 0.05; fy < 1; fy += 0.05)
        for (let fx = 0.05; fx < 1; fx += 0.05) {
          const x = r.left + r.width * fx;
          const y = r.top + r.height * fy;
          if (document.elementFromPoint(x, y)?.closest(".ls-peek") && under(x, y)?.closest(".ls-world") && !under(x, y)?.closest(".ls-node")) return { x, y };
        }
      return null;
    };
    /** Another card the peek covers at its centre. */
    const cardUnderPeek = (key: string) =>
      [...document.querySelectorAll<HTMLElement>(".ls-world .ls-node.card")].find((n) => {
        const c = centre(n);
        return n.dataset.ws !== key && !!document.elementFromPoint(c.x, c.y)?.closest(".ls-peek") && under(c.x, c.y)?.closest(".ls-node") === n;
      });
    /** A point on the bare landscape off the peek. */
    const offPeek = () => {
      const r = peekEl()?.getBoundingClientRect();
      if (!r) return null;
      const v = vp().getBoundingClientRect();
      for (let fy = 0.02; fy < 1; fy += 0.04)
        for (const fx of [0.01, 0.99, 0.03, 0.97]) {
          const x = v.left + v.width * fx;
          const y = v.top + v.height * fy;
          const el = document.elementFromPoint(x, y);
          if ((x < r.left || x > r.right || y < r.top || y > r.bottom) && el?.closest(".ls-world, .ls-viewport") && !el.closest(".ls-node, .ls-hud, .ls-minimap, .ls-switcher, .ls-peek, .ls-ah, .ls-area-title, .ls-area-tools, .ls-area-pill")) return { x, y };
        }
      return null;
    };
    /** What the peek's animations leave once finished, and how many there were. */
    const motionOf = (el: HTMLElement | null) => {
      const running = el?.getAnimations() ?? [];
      const n = running.length;
      running.forEach((a) => a.finish());
      const cs = el ? getComputedStyle(el) : null;
      return { animations: n, opacity: cs?.opacity ?? null, transform: cs?.transform ?? null, holding: el?.getAnimations().filter((a) => a.playState === "finished").length ?? null };
    };
    try {
      await sleep(1200);
      const mark = resizes().length;
      const card = node("s1")!.querySelector(".ls-card")!;
      // not before the pointer has rested PEEK_HOVER_MS: still closed at 450 ms, and how long it took
      const t0 = performance.now();
      over(card);
      await sleep(450);
      const early = !!peekEl();
      while (!peekEl() && performance.now() - t0 < 2000) await sleep(5);
      const delay = Math.round(performance.now() - t0);
      const el = peekEl();
      out.cards = { early, delay, opened: el?.dataset.peek ?? null, termIn: inPeek("s1"), stillCard: !!node("s1")?.classList.contains("card"), motion: motionOf(el) };

      // the pointer on the peek where it covers s1's card keeps it; off the card, though still on the peek, closes it
      const c1 = centre(node("s1")!);
      const onCard = hoverAt(c1.x + 3, c1.y + 2);
      await sleep(80);
      const stays = peekEl()?.dataset.peek ?? null;
      const bare = bareUnderPeek();
      const offCard = bare && hoverAt(bare.x, bare.y);
      await sleep(80);
      out.leave = { onPeek: !!onCard?.closest(".ls-peek"), stays, bare: !!bare, overPeek: !!offCard?.closest(".ls-peek"), closed: !peekEl() };

      // from s1's card straight onto another the peek covers: s1's closes at once, and the other's opens after its rest
      hoverAt(c1.x, c1.y);
      await sleep(REST);
      const again = peekEl()?.dataset.peek ?? null;
      const next = cardUnderPeek("s1");
      const nc = next && centre(next);
      const across = nc && hoverAt(nc.x, nc.y);
      await sleep(80);
      const firstClosed = !peekEl();
      await sleep(300);
      const notYet = !peekEl();
      await sleep(PEEK_HOVER_MS);
      out.across = { again, to: next?.dataset.ws ?? null, overPeek: !!across?.closest(".ls-peek"), firstClosed, notYet, opened: peekEl()?.dataset.peek ?? null };
      esc();
      await sleep(80);

      // Space keeps it open: moving onto another card, onto the bare landscape under it, or off it leaves it open, and
      // opens no other; Space again closes it, and resting on another card then opens that one's
      over(card);
      await sleep(REST);
      space();
      await sleep(80);
      const pinned = !!peekEl()?.classList.contains("pinned");
      over(node("s5")!.querySelector(".ls-card")!);
      await sleep(REST);
      const keptOpen = peekEl()?.dataset.peek ?? null;
      const b2 = bareUnderPeek();
      if (b2) hoverAt(b2.x, b2.y);
      await sleep(80);
      const keptOverIt = b2 ? (peekEl()?.dataset.peek ?? null) : "no bare landscape under it";
      over(vp());
      await sleep(100);
      const keptOffIt = peekEl()?.dataset.peek ?? null;
      space();
      await sleep(80);
      const spaceClosed = !peekEl();
      over(node("s5")!.querySelector(".ls-card")!);
      await sleep(REST);
      const other = peekEl()?.dataset.peek ?? null;
      // Esc closes it
      esc();
      await sleep(80);
      out.space = { pinned, keptOpen, keptOverIt, keptOffIt, spaceClosed, other, escClosed: !peekEl(), backFromPeek: !inPeek("s1") && !inPeek("s5"), font: term("s1")?.options.fontSize ?? null };

      // a click on it keeps it open as Space does: leaving its card no longer closes it; a press off it does
      over(card);
      await sleep(REST);
      const clicked = clickAt(c1.x, c1.y);
      await sleep(80);
      const clickPinned = !!peekEl()?.classList.contains("pinned");
      const focused = !!document.querySelector(".ls-focus");
      const b3 = bareUnderPeek();
      if (b3) hoverAt(b3.x, b3.y);
      await sleep(80);
      const kept = peekEl()?.dataset.peek ?? null;
      const off = offPeek();
      if (off) clickAt(off.x, off.y);
      await sleep(80);
      out.clickKeeps = { onPeek: !!clicked.closest(".ls-peek"), pinned: clickPinned, focused, bare: !!b3, kept, outside: !!off, closed: !peekEl() };
      if (focused) throw new Error("a click on the peek focused its workspace");

      // 50%, read-only: s1's terminal attached in its workspace, then lent to its peek
      const r = node("s1")!.getBoundingClientRect();
      const v = vp().getBoundingClientRect();
      over(vp());
      await pinchTo(0.5, { x: r.left + r.width / 2 - v.left, y: r.top + r.height / 2 - v.top });
      await sleep(700);
      const t = term("s1")!;
      const size = `${t.cols}×${t.rows}`;
      const lines = linesOf(t);
      const inNode = !!t.element?.closest('.ls-world [data-front="s1"] .term-holder');
      over(node("s1")!.querySelector(".ls-term")!);
      await sleep(REST);
      const lent = {
        opened: peekEl()?.dataset.peek ?? null,
        termIn: inPeek("s1"),
        snapshot: node("s1")?.querySelector(".ls-snap")?.textContent?.includes("Make the org dropdown remember") ?? false,
        font: t.options.fontSize ?? null,
        size: `${t.cols}×${t.rows}`,
        motion: motionOf(peekEl()),
      };
      over(vp());
      await sleep(400);
      const back = {
        closed: !peekEl(),
        inNode: !!t.element?.closest('.ls-world [data-front="s1"] .term-holder'),
        same: term("s1") === t,
        size: `${t.cols}×${t.rows}`,
        font: t.options.fontSize ?? null,
        kept: lines.length > 3 && lines.every((l, i) => linesOf(t)[i] === l),
      };
      out.readonly = { inNode, size, lent, back };
      // no peek, open or closed, resized a pty
      out.resized = resizes().slice(mark);

      // a double-click on the peek focuses its workspace (which reflows it to the window, and back as it leaves)
      over(node("s1")!.querySelector(".ls-term")!);
      await sleep(REST);
      const s1c = centre(node("s1")!);
      clickAt(s1c.x, s1c.y, true);
      await sleep(300);
      out.dblclick = { focused: document.querySelector(".ls-focus .ls-node")?.getAttribute("data-front") ?? null, peek: !!peekEl() };
      key(document.activeElement ?? document.body, "Escape", { metaKey: true });
      await sleep(400);

      // Enter focuses a kept-open peek's workspace, not the one selected (s1, focused last)
      const vr = vp().getBoundingClientRect();
      const peer = [...document.querySelectorAll<HTMLElement>(".ls-world .ls-node:not(.st-dead)")].find((n) => {
        const b = n.getBoundingClientRect();
        return n.dataset.front !== "s1" && !n.dataset.ws?.startsWith("ws:") && !!n.querySelector(".ls-term .xterm") && b.left >= vr.left && b.right <= vr.right && b.top >= vr.top && b.bottom <= vr.bottom;
      });
      if (peer) over(peer.querySelector(".ls-term")!);
      await sleep(REST);
      space();
      await sleep(80);
      const enterPinned = !!peekEl()?.classList.contains("pinned");
      const selected = document.querySelector(".ls-world .ls-node.selected")?.getAttribute("data-front") ?? null;
      key(document.activeElement ?? document.body, "Enter");
      await sleep(300);
      out.enter = { peer: peer?.dataset.front ?? null, pinned: enterPinned, selected, focused: document.querySelector(".ls-focus .ls-node")?.getAttribute("data-front") ?? null, peek: !!peekEl() };
      key(document.activeElement ?? document.body, "Escape", { metaKey: true });
      await sleep(400);

      // never while Space is held to pan
      armFocus(vp());
      key(vp(), " ");
      over(node("s1")!.querySelector(".ls-term")!);
      await sleep(REST);
      const whileSpace = !!peekEl();
      keyUp(vp(), " ");
      out.panning = { whileSpace };

      // a jump to the session whose terminal a kept-open peek has (⌥⇥ to the one that needs you) leaves the keyboard
      // with the landscape: nothing typed after it, nor into its terminal focused directly, reaches the session
      const wid = document.querySelector<HTMLElement>(".ls-world .ls-node.st-waiting")?.dataset.front ?? "";
      const rw = node(wid)!.getBoundingClientRect();
      const vw = vp().getBoundingClientRect();
      over(vp());
      await pinchTo(0.5, { x: rw.left + rw.width / 2 - vw.left, y: rw.top + rw.height / 2 - vw.top });
      await sleep(700);
      over(node(wid)!.querySelector(".ls-term") ?? node(wid)!);
      await sleep(REST);
      space();
      await sleep(80);
      const w1 = writesTo(wid).length;
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", altKey: true, bubbles: true, cancelable: true }));
      await sleep(400);
      const keyboardOf = () => (document.activeElement === vp() ? "landscape" : document.activeElement?.closest(".ls-peek") ? "peek" : document.activeElement?.closest(".xterm") ? "terminal" : String(document.activeElement?.tagName));
      const afterJump = keyboardOf();
      key(document.activeElement ?? document.body, "a");
      term(wid)!.focus();
      const afterFocus = keyboardOf();
      key(term(wid)!.textarea!, "a");
      await sleep(150);
      out.jump = { wid, selected: document.querySelector(".ls-world .ls-node.selected")?.getAttribute("data-front") ?? null, pinned: !!peekEl()?.classList.contains("pinned"), lent: inPeek(wid), afterJump, afterFocus, tabIndex: term(wid)!.textarea!.tabIndex, wrote: writesTo(wid).slice(w1) };
      // Enter, even aimed at its terminal, is the kept-open peek's: it focuses the workspace, and reaches the session
      // no more than the rest did
      key(term(wid)!.textarea!, "Enter");
      await sleep(300);
      out.jumpEnter = { focused: document.querySelector(".ls-focus .ls-node")?.getAttribute("data-ws") ?? null, wrote: writesTo(wid).slice(w1) };
      key(document.activeElement ?? document.body, "Escape", { metaKey: true });
      await sleep(400);
      over(node(wid)!.querySelector(".ls-term") ?? node(wid)!);
      await sleep(REST);
      space();
      await sleep(80);

      // a dialog open over a kept-open peek has Space and Esc first: Esc closes the dialog, and the peek stays
      document.querySelector<HTMLElement>(".help-link")!.click();
      await sleep(300);
      const dialog = !!document.querySelector(".modal-back:not(.mb-ghost)");
      const target = document.activeElement ?? document.body;
      target.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
      target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      await sleep(400);
      out.overlay = { dialog, closed: !document.querySelector(".modal-back:not(.mb-ghost)"), peek: peekEl()?.dataset.peek ?? null, pinned: !!peekEl()?.classList.contains("pinned") };
      (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      await sleep(150);

      // the peeked stack brings another tab to the front: the peek ends, and leaves no terminal behind in it
      const stackNode = node(wid)!;
      const ws = stackNode.dataset.ws ?? "";
      over(vp());
      over(stackNode.querySelector(".ls-term") ?? stackNode);
      await sleep(REST);
      const stackPeek = peekEl()?.dataset.peek ?? null;
      const tab = stackNode.querySelector<HTMLElement>(".ls-tab:not(.on)");
      tab?.click();
      await sleep(400);
      out.front = { ws, opened: stackPeek, front: document.querySelector(`.ls-world [data-ws="${CSS.escape(ws)}"]`)?.getAttribute("data-front") ?? null, peek: !!peekEl(), strays: document.querySelectorAll(".ls-peek .xterm").length, oldIn: inPeek(wid) };

      // kept open from a card, then zoomed into the read-only band: the workspace shows its screen, not a blank
      over(vp());
      key(vp(), "0", { metaKey: true });
      await sleep(600);
      over(node("s1")!.querySelector(".ls-card")!);
      await sleep(REST);
      window.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
      await sleep(80);
      const r1 = node("s1")!.getBoundingClientRect();
      const v1 = vp().getBoundingClientRect();
      await pinchTo(0.5, { x: r1.left + r1.width / 2 - v1.left, y: r1.top + r1.height / 2 - v1.top });
      await sleep(700);
      out.kept = { peek: peekEl()?.dataset.peek ?? null, mode: node("s1")?.classList.contains("snapshot") ? "snapshot" : node("s1")?.className ?? null, snap: node("s1")?.querySelector(".ls-snap")?.textContent?.includes("Make the org dropdown remember") ?? false };

      // a kept-open peek's wheel scrolls its terminal's history, and neither moves the landscape nor reaches the session
      const more = Array.from({ length: 80 }, (_, i) => `history line ${i}`).join("\r\n") + "\r\n";
      buffers.s1 += more;
      emit("onSessionData", "s1", more);
      await sleep(300);
      const st = term("s1")!;
      const from = st.buffer.active.viewportY;
      const cam0 = JSON.stringify(camera());
      const w2 = writesTo("s1").length;
      const holder = peekEl()?.querySelector(".ls-peek-term");
      holder?.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, ...at(holder), deltaY: -300 }));
      await sleep(400);
      out.scroll = { pinned: !!peekEl()?.classList.contains("pinned"), from, to: st.buffer.active.viewportY, moved: JSON.stringify(camera()) !== cam0, wrote: writesTo("s1").slice(w2) };
    } catch (err) {
      out.error = String(err instanceof Error ? err.stack : err);
    }
    report("mb-landscape-peek-audit", out);
  });

  // ?landscapeRemoteAudit: a teammate's terminal at its owner's size whatever shows it: as a card at fit (made by the
  // card, never by a pane), as the owner resizes while it's a card and while it's peeked, and attached at 100%; what
  // the owner draws at a column only their width has lands there; no pty of theirs is resized from here. Into
  // <script id="mb-landscape-remote-audit">.
  if (params.has("landscapeRemoteAudit")) waitFor(`.ls-world [data-front="${CSS.escape(NICK_PANE)}"] .ls-card`, async () => {
    const out: Record<string, unknown> = {};
    const remotes = live.remote.map((s) => s.id);
    const sizes = () => Object.fromEntries(remotes.filter((id) => term(id)).map((id) => [id, sizeOf(id)]));
    const owners = () => Object.fromEntries(live.remote.map((s) => [s.id, `${s.room!.cols}×${s.room!.rows}`]));
    const ownerResize = (cols: number, rows: number) => {
      const nick = live.remote.find((s) => s.id === NICK_PANE)!;
      nick.room = { ...nick.room!, cols, rows };
      emit("onTeamLive", clone(live));
    };
    const peekEl = () => document.querySelector<HTMLElement>(".ls-peek");
    const attached = () => !!term(NICK_PANE)?.element?.isConnected;
    try {
      await sleep(1200);
      out.atFit = { sizes: sizes(), owners: owners(), attached: attached() };
      // the owner's window narrows while it's a card, and they draw at column 90
      ownerResize(96, 28);
      await sleep(300);
      const draw = "\r\n\x1b[90Gend";
      buffers[NICK_PANE] += draw;
      emit("onSessionData", NICK_PANE, draw);
      await sleep(200);
      out.card = { size: sizeOf(NICK_PANE), attached: attached(), endAt: (linesOf(term(NICK_PANE)!).at(-1) ?? "").indexOf("end") };
      // peeked, and the owner's window widens meanwhile: it follows, still fitted to the peek
      node(NICK_PANE)!.querySelector(".ls-card")!.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }));
      await sleep(PEEK_HOVER_MS + 150);
      const opened = peekEl()?.dataset.peek ?? null;
      ownerResize(104, 30);
      await sleep(300);
      const screen = term(NICK_PANE)?.element?.querySelector(".xterm-screen")?.getBoundingClientRect();
      const box = peekEl()?.querySelector(".ls-peek-term")?.getBoundingClientRect();
      out.peek = { opened, inPeek: !!term(NICK_PANE)?.element?.closest(".ls-peek"), size: sizeOf(NICK_PANE), fits: !!screen && !!box && screen.width <= box.width + 1 && screen.height <= box.height + 1 };
      (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      await sleep(150);
      // 100% about its workspace: attached at its owner's size, and following it there too
      const r = node(NICK_PANE)!.getBoundingClientRect();
      const v = vp().getBoundingClientRect();
      vp().dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }));
      await pinchTo(1, { x: r.left + r.width / 2 - v.left, y: r.top + r.height / 2 - v.top });
      await sleep(700);
      const inNode = !!term(NICK_PANE)?.element?.closest(`.ls-world [data-front="${CSS.escape(NICK_PANE)}"] .term-holder`);
      const atLive = sizeOf(NICK_PANE);
      ownerResize(100, 30);
      await sleep(300);
      out.live = { inNode, size: atLive, followed: sizeOf(NICK_PANE) };
      // and back to fit, where nothing shows it: the owner resizes once more
      key(vp(), "0", { metaKey: true });
      await sleep(600);
      ownerResize(90, 26);
      await sleep(300);
      out.away = { attached: attached(), size: sizeOf(NICK_PANE) };
      out.resized = resizes().filter((x) => remotes.some((id) => x.startsWith(`${id} `)));
    } catch (err) {
      out.error = String(err instanceof Error ? err.stack : err);
    }
    report("mb-landscape-remote-audit", out);
  });

  // ?landscapeRestartAudit: Restart all (the status bar's button and its dialog) at fit gives the restarted sessions
  // new terminals; output after it still reaches their cards. Into <script id="mb-landscape-restart-audit">.
  if (params.has("landscapeRestartAudit")) waitFor('.ls-world [data-front="s5"] .ls-card', async () => {
    const out: Record<string, unknown> = {};
    const line = () => node("s5")?.querySelector(".ls-card-line")?.textContent ?? null;
    try {
      await sleep(1200);
      const before = term("s5");
      // s5 is idle, its terminal's last line its last message: the card says that once, as what it did
      const lineBefore = line() ?? node("s5")?.querySelector("[data-did]")?.textContent ?? null;
      document.querySelector<HTMLElement>(".sb-update")!.click();
      await sleep(300);
      const confirm = document.querySelector<HTMLElement>(".close-dlg .primary");
      const label = confirm?.textContent ?? null;
      confirm!.click();
      await sleep(800);
      const more = "\r\n⏺ After the restart: the tag list is memoized\r\n";
      buffers.s5 += more;
      emit("onSessionData", "s5", more);
      await sleep(900);
      out.restart = { label, restarted: calls.some((c) => c.fn === "restartAllSessions"), newTerm: !!term("s5") && term("s5") !== before, lineBefore, lineAfter: line() };
    } catch (err) {
      out.error = String(err instanceof Error ? err.stack : err);
    }
    report("mb-landscape-restart-audit", out);
  });

  // ---- areas (S4) ----
  const box = (sel: string) => document.querySelector(sel)?.getBoundingClientRect() ?? null;
  const areaEl = (key: string) => `.ls-area[data-area="${CSS.escape(key)}"]`;
  const inRect = (r: Rect, a: Rect) => r.x >= a.x && r.y >= a.y && r.x + r.w <= a.x + a.w && r.y + r.h <= a.y + a.h;
  const apartAll = () => {
    const as = Object.values(landscape.areas);
    return as.every((a, i) => as.every((b, j) => i === j || a.x + a.w + AREA_GAP <= b.x + 1e-6 || b.x + b.w + AREA_GAP <= a.x + 1e-6 || a.y + a.h + AREA_GAP <= b.y + 1e-6 || b.y + b.h + AREA_GAP <= a.y + 1e-6));
  };
  // a drag as a mouse makes one: a press where the pointer is, moves in steps, and the release
  const PID = 9;
  /** A press at (x, y), on what's there or on `on` (what's there may be the minimap or the HUD over it). */
  const pressAt = (x: number, y: number, on?: Element) =>
    (on ?? document.elementFromPoint(x, y) ?? vp()).dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: PID, button: 0, buttons: 1, clientX: x, clientY: y }));
  const moveTo = (x: number, y: number) => window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, cancelable: true, pointerId: PID, buttons: 1, clientX: x, clientY: y }));
  const upAt = (x: number, y: number) => window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerId: PID, button: 0, clientX: x, clientY: y }));
  const dragAlong = async (from: { x: number; y: number }, to: { x: number; y: number }, during?: () => void, on?: Element) => {
    pressAt(from.x, from.y, on);
    for (let i = 1; i <= 6; i++) {
      moveTo(from.x + ((to.x - from.x) * i) / 6, from.y + ((to.y - from.y) * i) / 6);
      await sleep(16);
    }
    during?.();
    upAt(to.x, to.y);
    await sleep(700);
  };
  const mid = (r: DOMRect) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  const menuItem = (text: string) => [...document.querySelectorAll<HTMLElement>(".mb-menu [role=menuitem], .mb-menu button")].find((b) => b.textContent?.includes(text));
  const nameIt = async (name: string) => {
    const input = document.querySelector<HTMLInputElement>(".modal input[type=text]");
    if (!input) throw new Error(`no name field to type ${name} into`);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, name);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(30);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await sleep(900);
  };
  const tools = (key: string, label: string) => [...document.querySelectorAll<HTMLButtonElement>(`${areaEl(key)} .ls-area-tools button`)].find((b) => b.textContent === label);
  const changes = (from: number) => calls.slice(from).filter((c) => ["landscapeUpdate", "setGroup", "renameGroup"].includes(c.fn)).map((c) => ({ fn: c.fn, args: c.args }));
  const views = () => calls.filter((c) => c.fn === "teamLiveView").map((c) => c.args[0] as { shown: string[]; focused: string | null });
  const lastView = () => views().at(-1)?.shown ?? [];
  const noteText = () => document.querySelector(".ls-note")?.textContent ?? null;
  const N7 = remotePaneId(NICK, "n7");
  const fitView = async () => {
    [...document.querySelectorAll<HTMLElement>(".ls-hud-btn")].find((b) => b.textContent === "Fit")!.click();
    await sleep(400);
  };

  // ?landscapeAreasAudit (with ?motion=off): the area tree and its fly-to; what teammates stream following what's on
  // screen, a collapsed area's off it; a marquee made into an area; a workspace dragged across an edge into another
  // area, and one refused; locking; renaming; a teammate's session landing in its room's area; an area dragged; the
  // switcher; and Members ▾'s actions reaching the same room calls as the room view's. Into
  // <script id="mb-landscape-areas-audit">.
  if (params.has("landscapeAreasAudit")) waitFor(".ls-world .ls-node", async () => {
    const out: Record<string, unknown> = {};
    try {
      await sleep(900);
      out.tree = [...document.querySelectorAll<HTMLElement>(".area-tree .lt-area")].map((a) => ({
        key: a.dataset.area,
        title: a.querySelector(".lt-head .lt-t")?.textContent ?? null,
        waiting: a.querySelector(".lt-head .lt-badge")?.textContent ?? null,
        count: a.querySelector(".lt-head .lt-n")?.textContent ?? null,
        online: [...a.querySelectorAll(".lt-head .lt-av")].map((x) => x.textContent),
        rows: [...a.querySelectorAll<HTMLElement>(".lt-ws")].map((r) => r.dataset.sid),
      }));
      out.atFit = { streams: lastView() };
      // the minimap: a block for each area, and one of its own for each workspace in no area; nothing for the rest
      const minimap = () => {
        const mm = document.querySelector(".ls-minimap");
        return {
          areas: [...(mm?.querySelectorAll<SVGElement>("rect.area") ?? [])].map((r) => r.dataset.area),
          loose: [...(mm?.querySelectorAll<SVGElement>("rect.loose") ?? [])].map((r) => r.dataset.ws),
          dots: mm?.querySelectorAll("circle").length ?? null,
          marks: mm ? mm.children.length - 1 : null,
        };
      };
      out.minimap = minimap();

      // the tree's area row flies there: the area whole in view, and teammates stream what's on screen
      document.querySelector<HTMLElement>('.area-tree .lt-area[data-area="5110"] .lt-head')!.click();
      await sleep(500);
      const view = vp().getBoundingClientRect();
      const a5110 = box(areaEl("5110"))!;
      out.flyTree = {
        inView: a5110.left >= view.left - 1 && a5110.right <= view.right + 1 && a5110.top >= view.top - 40 && a5110.bottom <= view.bottom + 1,
        centred: Math.abs(mid(a5110).x - mid(view).x) < 2,
        streams: lastView(),
      };

      // collapsed: a pill keeping its counts, its workspaces off screen and no longer streamed; a click opens it
      tools("5110", "Collapse")!.click();
      await sleep(500);
      const pill = document.querySelector<HTMLElement>('.ls-area-pill[data-area="5110"]');
      out.collapse = {
        stored: landscape.areas["5110"].collapsed === true,
        pill: pill?.textContent ?? null,
        hidden: [...document.querySelectorAll<HTMLElement>(".ls-world .ls-node.hidden")].map((n) => n.dataset.front).sort(),
        streams: lastView(),
        tree: document.querySelector('.area-tree .lt-area[data-area="5110"] .lt-head')?.getAttribute("title") ?? null,
      };
      pill!.click();
      await sleep(500);
      out.expand = { stored: landscape.areas["5110"].collapsed, hidden: document.querySelectorAll(".ls-world .ls-node.hidden").length, streams: lastView() };

      // the switcher (⌘\ puts the tree away) ends with Loose while a workspace is in no area, and goes to it
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "\\", metaKey: true, bubbles: true, cancelable: true }));
      await sleep(400);
      const swLoose = document.querySelector<HTMLElement>(".ls-switcher .ls-sw:last-child");
      swLoose?.click();
      await sleep(500);
      const s7b = node("s7")?.getBoundingClientRect();
      const vl = vp().getBoundingClientRect();
      out.switcherLoose = {
        last: swLoose ? { area: swLoose.dataset.area ?? null, text: swLoose.textContent } : null,
        on: document.querySelector(".ls-switcher .ls-sw.on")?.getAttribute("data-area") ?? null,
        centred: !!s7b && Math.abs(mid(s7b).x - mid(vl).x) < 2,
        clearOfIt: !!s7b && s7b.top >= box(".ls-switcher")!.bottom - 1,
      };
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "\\", metaKey: true, bubbles: true, cancelable: true }));
      await sleep(400);

      // a marquee round the loose assistant, then M and a name: the area's place is saved, then its group set
      await fitView();
      const s7 = node("s7")!.getBoundingClientRect();
      let mark = calls.length;
      pressAt(s7.left - 10, s7.top - 10);
      for (let i = 1; i <= 5; i++) {
        moveTo(s7.left - 10 + ((s7.width + 20) * i) / 5, s7.top - 10 + ((s7.height + 20) * i) / 5);
        await sleep(16);
      }
      const during = { marquee: !document.querySelector<HTMLElement>(".ls-marquee")!.hidden, picked: [...document.querySelectorAll<HTMLElement>(".ls-world .ls-node.picked")].map((n) => n.dataset.front) };
      upAt(s7.right + 10, s7.bottom + 10);
      await sleep(200);
      const bar = document.querySelector(".ls-selbar")?.textContent ?? null;
      key(vp(), "m");
      await sleep(300);
      const dialog = document.querySelector(".modal h3")?.textContent ?? null;
      await nameIt("Spike");
      out.make = {
        during,
        bar,
        dialog,
        changes: changes(mark),
        area: landscape.areas.Spike ?? null,
        inside: !!landscape.areas.Spike && inRect(landscape.workspaces.s7, landscape.areas.Spike),
        group: sessions.find((s) => s.id === "s7")?.taskGroup ?? null,
        drawn: !!document.querySelector(areaEl("Spike")),
        cleared: !document.querySelector(".ls-selbar"),
        apart: apartAll(),
        minimap: minimap(),
      };

      // the test runner's card dragged into 5102: 5102 lights up under it, then its place is saved and its group set
      await fitView();
      mark = calls.length;
      const s4 = node("s4")!.getBoundingClientRect();
      const a5102 = box(areaEl("5102"))!;
      let hot = false;
      await dragAlong(mid(s4), { x: a5102.left + a5102.width * 0.3, y: a5102.bottom - 12 }, () => (hot = !!document.querySelector(`${areaEl("5102")}.drop-on`)));
      out.dragIn = {
        hot,
        changes: changes(mark),
        inside: inRect(landscape.workspaces.s4, landscape.areas["5102"]),
        group: sessions.find((s) => s.id === "s4")?.taskGroup ?? null,
        translate: node("s4")?.style.translate ?? null,
        apart: apartAll(),
      };

      // a teammate's workspace can't go to another area: refused, said, and back where it was
      await fitView();
      mark = calls.length;
      const n7 = node(N7)!.getBoundingClientRect();
      const a5101 = box(areaEl("5101"))!;
      await dragAlong(mid(n7), { x: a5101.left + 20, y: a5101.bottom - 12 });
      out.refused = { note: noteText(), changes: changes(mark), translate: node(N7)?.style.translate ?? null, group: live.remote.find((s) => s.id === N7)?.taskGroup ?? null };

      // locked: its workspaces don't move (said), and it unlocks again
      tools("5101", "Lock")!.click();
      await sleep(400);
      const lockedStored = landscape.areas["5101"].locked === true;
      mark = calls.length;
      const s1 = node("s1")!.getBoundingClientRect();
      await dragAlong(mid(s1), { x: mid(s1).x + 60, y: mid(s1).y + 40 });
      out.lock = { stored: lockedStored, note: noteText(), changes: changes(mark), translate: node("s1")?.style.translate ?? null, locked: !!document.querySelector(`${areaEl("5101")}.locked`) };
      tools("5101", "Locked")!.click();
      await sleep(400);
      (out.lock as Record<string, unknown>).unlocked = !landscape.areas["5101"].locked;

      // renamed from its ⋯ (right-click on its name zoomed out): the area keeps its place, folded and locked as it was,
      // under the new name, whichever of the sessions' change and the area's comes first
      await fitView();
      mark = calls.length;
      const before = { ...landscape.areas["5102"] };
      const title = document.querySelector<HTMLElement>(`${areaEl("5102")} .ls-area-title`)!;
      const t = title.getBoundingClientRect();
      title.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: t.left + 10, clientY: t.top + 5 }));
      await sleep(200);
      const items = [...document.querySelectorAll<HTMLElement>(".mb-menu [role=menuitem]")].map((b) => b.textContent?.trim() ?? "");
      menuItem("Rename")!.click();
      await sleep(300);
      await nameIt("Pathways");
      const after = landscape.areas.Pathways;
      out.rename = {
        items,
        changes: changes(mark).map((c) => c.fn),
        same: !!after && after.x === before.x && after.y === before.y && after.w === before.w && after.h === before.h,
        gone: !Object.hasOwn(landscape.areas, "5102"),
        drawn: !!document.querySelector(areaEl("Pathways")),
        s5: inRect(landscape.workspaces.s5, after ?? before),
        apart: apartAll(),
      };

      // a teammate's new session in a room lands in its area, and its place is saved
      mark = calls.length;
      const N9 = remotePaneId(NICK, "n9");
      live.remote.push(session(N9, { title: "Gift aid flag", taskGroup: "5110", repoPath: null, cwd: "(on Nick Smith's Mockingbird) backoffice", status: "working", room: roomTag({ roomId: ROOM_5110, sessionId: "n9", owner: NICK, ownerName: "Nick Smith", remote: true }) }));
      emit("onTeamLive", clone(live));
      await sleep(700);
      out.remoteLands = { saved: !!landscape.workspaces[N9], inside: !!landscape.workspaces[N9] && inRect(landscape.workspaces[N9], landscape.areas["5110"]), drawn: !!node(N9), apart: apartAll() };

      // an area dragged by its name: it moves on the grid with its workspaces, clear of the others
      await fitView();
      const was = { ...landscape.areas["5110"] };
      const y1Was = { ...landscape.workspaces.y1 };
      const nameEl = document.querySelector(`${areaEl("5110")} .ls-area-title .n`)!;
      const name5110 = nameEl.getBoundingClientRect();
      await dragAlong(mid(name5110), { x: mid(name5110).x + 120, y: mid(name5110).y + 90 }, undefined, nameEl);
      const now5110 = landscape.areas["5110"];
      out.areaMove = {
        moved: now5110.x !== was.x || now5110.y !== was.y,
        withIt: landscape.workspaces.y1.x - y1Was.x === now5110.x - was.x && landscape.workspaces.y1.y - y1Was.y === now5110.y - was.y,
        onGrid: now5110.x % 8 === 0 && now5110.y % 8 === 0,
        apart: apartAll(),
        translate: document.querySelector<HTMLElement>(areaEl("5110"))?.style.translate ?? null,
      };

      // the side bar put away (⌘\): the switcher stands in for the tree, and goes to an area too; ⌘\ brings the tree back
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "\\", metaKey: true, bubbles: true, cancelable: true }));
      await sleep(400);
      const sw = [...document.querySelectorAll<HTMLElement>(".ls-switcher .ls-sw")].map((b) => b.dataset.area);
      document.querySelector<HTMLElement>('.ls-switcher .ls-sw[data-area="5101"]')!.click();
      await sleep(500);
      const a5101b = box(areaEl("5101"))!;
      const v2 = vp().getBoundingClientRect();
      out.switcher = {
        tree: !!document.querySelector(".sidebar:not(.collapsed) .area-tree"),
        areas: sw,
        on: document.querySelector(".ls-switcher .ls-sw.on")?.getAttribute("data-area") ?? null,
        centred: Math.abs(mid(a5101b).x - mid(v2).x) < 2,
        clearOfIt: a5101b.top >= box(".ls-switcher")!.bottom - 1 || a5101b.left >= box(".ls-switcher")!.right,
      };
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "\\", metaKey: true, bubbles: true, cancelable: true }));
      await sleep(400);
      (out.switcher as Record<string, unknown>).back = !!document.querySelector(".sidebar:not(.collapsed) .area-tree") && !document.querySelector(".ls-switcher");

      // Members ▾ in 5101's header, at 100%: presence and roles, then its actions
      document.querySelector<HTMLElement>('.area-tree .lt-area[data-area="5101"] .lt-head')!.click();
      await sleep(300);
      document.querySelector<HTMLElement>(".ls-hud-btn.pct")!.click();
      await sleep(600);
      const membersBtn = () => document.querySelector<HTMLElement>(`${areaEl("5101")} .ls-ah .ls-ah-btn[aria-haspopup]`);
      membersBtn()!.click();
      await sleep(300);
      const rows = [...document.querySelectorAll<HTMLElement>(".ls-members .lsm-member")].map((r) => ({ id: r.dataset.member, role: r.querySelector(".lsm-role")?.textContent ?? null, presence: r.querySelector(".lsm-presence")?.textContent?.trim() ?? null }));
      const buttons = [...document.querySelectorAll<HTMLElement>(".ls-members .lsm-buttons button")].map((b) => b.textContent?.trim());
      const lines = [...document.querySelectorAll<HTMLElement>(".ls-members .lsm-row")].map((r) => r.textContent?.trim());
      mark = calls.length;
      [...document.querySelectorAll<HTMLElement>(".ls-members .lsm-acts button")].find((b) => b.textContent === "Remove as admin")!.click();
      await sleep(400);
      const fromMenu = calls.slice(mark).find((c) => c.fn === "teamSetAdmin") ?? null;
      // the room view's own member menu, for the same teammate
      [...document.querySelectorAll<HTMLElement>(`${areaEl("5101")} .ls-ah .ls-ah-btn`)].find((b) => b.textContent?.startsWith("Chat"))!.click();
      await sleep(700);
      const rc = document.querySelector<HTMLElement>(`.rc-members .rc-member[data-member="${NICK}"]`)!;
      const rr = rc.getBoundingClientRect();
      rc.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: rr.left + 4, clientY: rr.top + 4 }));
      await sleep(200);
      mark = calls.length;
      menuItem("Make admin")!.click();
      await sleep(400);
      const fromRoomView = calls.slice(mark).find((c) => c.fn === "teamSetAdmin") ?? null;
      // hand over ownership, through the Team view's own dialog
      membersBtn()!.click();
      await sleep(300);
      [...document.querySelectorAll<HTMLElement>(".ls-members .lsm-acts button")].find((b) => b.textContent === "Hand over ownership…")!.click();
      await sleep(300);
      mark = calls.length;
      document.querySelector<HTMLElement>(".modal.team-dlg button.primary")!.click();
      await sleep(500);
      const handOver = calls.slice(mark).find((c) => c.fn === "teamHandOver") ?? null;
      document.querySelector<HTMLElement>(".modal.team-dlg button.primary")?.click();
      await sleep(300);
      // and leave, through the Team view's own dialog
      membersBtn()!.click();
      await sleep(300);
      [...document.querySelectorAll<HTMLElement>(".ls-members .lsm-buttons button")].find((b) => b.textContent === "Leave room…")!.click();
      await sleep(300);
      mark = calls.length;
      document.querySelector<HTMLElement>(".modal.team-dlg button.danger-btn")!.click();
      await sleep(1100);
      const leave = calls.slice(mark).find((c) => c.fn === "teamLeaveRoom") ?? null;
      out.members = { rows, buttons, lines, fromMenu, fromRoomView, handOver, leave, roomGone: !team.rooms.some((r) => r.id === ROOM_5101) };
    } catch (err) {
      out.error = String(err instanceof Error ? err.stack : err);
    }
    report("mb-landscape-areas-audit", out);
  });

  // ?landscapeAreaEdgesAudit (with ?motion=off, ?claim, ?liveViewFail, ?setGroupFail=s4): the side bar's heading; a
  // failure to say what's on screen, shown; cards drawn inset; a room's dialogs from Members ▾ drawn over everything,
  // outside the scaled landscape, kept as the zoom or a collapse takes the header away, and a press in one moving
  // nothing; Members ▾ and ⋯ closing on a press the landscape takes; a press in ⋯ moving nothing; going to an area from
  // another tab; a reveal not repeated when the landscape mounts again; a drag whose group can't be set, put back.
  // Into <script id="mb-landscape-area-edges-audit">.
  if (params.has("landscapeAreaEdgesAudit")) waitFor(".ls-world .ls-node", async () => {
    const out: Record<string, unknown> = {};
    const tab = async (label: string) => {
      [...document.querySelectorAll<HTMLElement>(".tab")].find((b) => b.textContent?.trim() === label)!.click();
      await sleep(600);
    };
    const toArea = async (key: string, at100 = true) => {
      document.querySelector<HTMLElement>(`.area-tree .lt-area[data-area="${key}"] .lt-head`)!.click();
      await sleep(400);
      if (at100) {
        document.querySelector<HTMLElement>(".ls-hud-btn.pct")!.click();
        await sleep(600);
      }
    };
    const membersOf = (key: string) => document.querySelector<HTMLElement>(`${areaEl(key)} .ls-ah .ls-ah-btn[aria-haspopup]`);
    const actOn = (text: string) => [...document.querySelectorAll<HTMLElement>(".ls-members .lsm-acts button, .ls-members .lsm-buttons button, .ls-members .role-notice button")].find((b) => b.textContent?.trim() === text);
    /** The open dialog: drawn outside the landscape's world, over the whole window. */
    const dialogNow = () => {
      const back = document.querySelector<HTMLElement>(".modal-back");
      const r = back?.getBoundingClientRect();
      return {
        open: !!document.querySelector(".modal.team-dlg"),
        title: document.querySelector(".modal.team-dlg h3")?.textContent ?? null,
        inWorld: !!back?.closest(".ls-world, .ls-viewport"),
        covers: !!r && r.left <= 0 && r.top <= 0 && r.right >= innerWidth && r.bottom >= innerHeight,
        keys: !!document.activeElement?.closest(".modal"),
      };
    };
    /** A press and a drag inside the dialog: what moved or was saved since `from`. */
    const dragInDialog = async (key: string) => {
      const was = JSON.stringify(landscape.areas[key]);
      const h = document.querySelector<HTMLElement>(".modal.team-dlg h3")!;
      const r = h.getBoundingClientRect();
      const from = calls.length;
      await dragAlong({ x: r.left + 10, y: r.top + 5 }, { x: r.left + 140, y: r.top + 90 }, undefined, h);
      return { moved: JSON.stringify(landscape.areas[key]) !== was, saved: changes(from).length };
    };
    const primary = (sel = "button.primary") => document.querySelector<HTMLElement>(`.modal.team-dlg ${sel}`)!.click();
    try {
      await sleep(900);
      out.heading = document.querySelector(".side-title")?.textContent ?? null;
      out.liveViewProblem = document.querySelector(".connected-line .cl-problem")?.textContent ?? null;

      // cards are drawn inset in their places: a few px on screen at any zoom of the cards band
      await fitView();
      const zoom = camera()!.zoom;
      const s1 = node("s1")!.getBoundingClientRect();
      out.cardInset = { band: [...vp().classList].find((c) => c.startsWith("ls-band-")) ?? null, x: (landscape.workspaces.s1.w * zoom - s1.width) / 2, y: (landscape.workspaces.s1.h * zoom - s1.height) / 2 };

      // Remove from the room…, from 5101's Members ▾ at 100%: over everything, outside the world; a drag in it moves
      // nothing; zoomed out to cards (the header gone) it stays open, and its button reaches the room
      await toArea("5101");
      membersOf("5101")!.click();
      await sleep(300);
      actOn("Remove from the room…")!.click();
      await sleep(400);
      // reported as it goes, so a step that finds no dialog leaves what came before it said
      const remove: Record<string, unknown> = (out.remove = { open: dialogNow() });
      remove.drag = await dragInDialog("5101");
      await fitView();
      remove.afterZoom = { ...dialogNow(), header: !!document.querySelector(`${areaEl("5101")} .ls-ah`) };
      let mark = calls.length;
      primary("button.danger-btn");
      await sleep(600);
      remove.call = calls.slice(mark).find((c) => c.fn === "teamRemoveMember") ?? null;
      // anything the dialog left open (its result) is closed
      document.querySelector<HTMLElement>(".modal.team-dlg button.primary, .modal.team-dlg button.outline")?.click();
      await sleep(300);

      // Hand over ownership…: kept open as 5101 collapses under it
      await toArea("5101");
      membersOf("5101")!.click();
      await sleep(300);
      actOn("Hand over ownership…")!.click();
      await sleep(400);
      const handOpen = dialogNow();
      tools("5101", "Collapse")!.click();
      await sleep(500);
      const handAfterCollapse = { ...dialogNow(), collapsed: landscape.areas["5101"].collapsed === true };
      mark = calls.length;
      primary();
      await sleep(600);
      out.handOver = { open: handOpen, afterCollapse: handAfterCollapse, call: calls.slice(mark).find((c) => c.fn === "teamHandOver") ?? null };
      document.querySelector<HTMLElement>(".modal.team-dlg button.primary, .modal.team-dlg button.outline")?.click();
      await sleep(300);
      document.querySelector<HTMLElement>(`.ls-area-pill[data-area="5101"]`)!.click();
      await sleep(500);

      // Leave room… (an admin now): kept open as the zoom goes to cards, and its button reaches the room
      await toArea("5101");
      membersOf("5101")!.click();
      await sleep(300);
      actOn("Leave room…")!.click();
      await sleep(400);
      const leaveOpen = dialogNow();
      await fitView();
      const leaveAfterZoom = dialogNow();
      mark = calls.length;
      primary("button.danger-btn");
      await sleep(1100);
      out.leave = { open: leaveOpen, afterZoom: leaveAfterZoom, call: calls.slice(mark).find((c) => c.fn === "teamLeaveRoom") ?? null };
      document.querySelector<HTMLElement>(".modal.team-dlg button.primary, .modal.team-dlg button.outline")?.click();
      await sleep(300);

      // Claim ownership… from 5110's (Nick hasn't been heard from for 15 days)
      await toArea("5110");
      membersOf("5110")!.click();
      await sleep(300);
      actOn("Claim ownership…")!.click();
      await sleep(400);
      const claimOpen = dialogNow();
      await fitView();
      const claimAfterZoom = dialogNow();
      mark = calls.length;
      primary();
      await sleep(600);
      out.claim = { open: claimOpen, afterZoom: claimAfterZoom, call: calls.slice(mark).find((c) => c.fn === "teamClaimOwnership") ?? null };

      // Members ▾ and ⋯ close on a press the landscape takes for itself (the minimap's, which calls preventDefault and
      // so has no mousedown after it); a press and a drag in ⋯'s own padding moves nothing
      await toArea("5110");
      membersOf("5110")!.click();
      await sleep(300);
      const membersWasOpen = !!document.querySelector(".ls-members");
      const mm = document.querySelector<HTMLElement>(".ls-minimap")!;
      const mr = mm.getBoundingClientRect();
      pressAt(mr.left + 20, mr.top + 20, mm);
      upAt(mr.left + 20, mr.top + 20);
      await sleep(300);
      const membersClosed = !document.querySelector(".ls-members");
      await toArea("5110");
      document.querySelector<HTMLElement>(`${areaEl("5110")} .ls-ah-more`)!.click();
      await sleep(300);
      const menu = document.querySelector<HTMLElement>(".mb-menu.mb-ctx")!;
      const menuR = menu.getBoundingClientRect();
      const was5110 = JSON.stringify(landscape.areas["5110"]);
      mark = calls.length;
      await dragAlong({ x: menuR.left + 2, y: menuR.top + 2 }, { x: menuR.left + 160, y: menuR.top + 120 }, undefined, menu);
      const menuDrag = { moved: JSON.stringify(landscape.areas["5110"]) !== was5110, saved: changes(mark).length, stillOpen: !!document.querySelector(".mb-menu.mb-ctx") };
      pressAt(mr.left + 20, mr.top + 20, mm);
      upAt(mr.left + 20, mr.top + 20);
      await sleep(300);
      out.closing = { membersWasOpen, membersClosed, menuDrag, menuClosed: !document.querySelector(".mb-menu.mb-ctx") };

      // ⌘K's Go to from the Dashboard: the landscape mounts and goes there
      await tab("Dashboard");
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }));
      await sleep(300);
      const input = document.querySelector<HTMLInputElement>(".palette input")!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "Go to #5102");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(200);
      const row = [...document.querySelectorAll<HTMLElement>(".palette .row")].find((r) => r.textContent?.startsWith("Go to #5102"));
      row?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      await sleep(1200);
      const a5102 = box(areaEl("5102"));
      const view = vp()?.getBoundingClientRect();
      out.goToFromTab = { row: !!row, landscape: !!vp(), centred: !!a5102 && !!view && Math.abs(mid(a5102).x - mid(view).x) < 2 && Math.abs(mid(a5102).y - mid(view).y) < 2 };

      // a tree row's double-click focuses its workspace; back from another tab, it isn't focused again, and its area,
      // collapsed meanwhile, isn't opened again
      document.querySelector<HTMLElement>('.area-tree .lt-ws[data-sid="s5"]')!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
      await sleep(600);
      const focused = !!document.querySelector(".ls-focus");
      await tab("Dashboard");
      await tab("Landscape");
      const refocused = !!document.querySelector(".ls-focus");
      tools("5102", "Collapse")?.click();
      await sleep(400);
      await tab("Dashboard");
      await tab("Landscape");
      out.revealOnce = { focused, refocused, collapsed: landscape.areas["5102"]?.collapsed === true };
      document.querySelector<HTMLElement>(`.ls-area-pill[data-area="5102"]`)?.click();
      await sleep(500);

      // a drag into 5102 whose group can't be set: said, and its place and 5102 put back as they were
      await fitView();
      const s4Was = JSON.stringify(landscape.workspaces.s4);
      const areasWas = JSON.stringify(landscape.areas);
      mark = calls.length;
      const s4 = node("s4")!.getBoundingClientRect();
      const b5102 = box(areaEl("5102"))!;
      await dragAlong(mid(s4), { x: b5102.left + b5102.width * 0.3, y: b5102.bottom - 12 });
      await sleep(400);
      out.failedMove = {
        note: noteText(),
        changes: changes(mark).map((c) => c.fn),
        placeBack: JSON.stringify(landscape.workspaces.s4) === s4Was,
        areasBack: JSON.stringify(landscape.areas) === areasWas,
        group: sessions.find((s) => s.id === "s4")?.taskGroup ?? null,
      };
    } catch (e) {
      out.error = String(e instanceof Error ? e.stack : e);
    }
    report("mb-landscape-area-edges-audit", out);
  });

  // ?landscapeFlyAudit, or ?motionAudit (with ?motion=full or reduce): going to an area from the tree flies the camera there; the
  // flight's clock animation finished (as the motion audit finishes every animation, never reading a frame in flight)
  // ends it where it was going; a wheel during one stops it where it is; under reduce it's there at once. Into
  // <script id="mb-landscape-fly-audit">.
  if (flyAudit) waitFor(".ls-world .ls-node", async () => {
    const out: Record<string, unknown> = {};
    const finite = () => document.getAnimations().filter((a) => Number.isFinite(a.effect?.getComputedTiming().activeDuration ?? Infinity));
    const flying = () => vp().hasAttribute("data-flying");
    const centred = (key: string) => Math.abs(mid(box(areaEl(key))!).x - mid(vp().getBoundingClientRect()).x) < 2;
    try {
      await sleep(900);
      const goTo = (key: string) => document.querySelector<HTMLElement>(`.area-tree .lt-area[data-area="${key}"] .lt-head`)!.click();
      const camAt = camera();
      goTo("5110");
      await sleep(40);
      const clocks = () => document.getAnimations().filter((a) => (a.effect as KeyframeEffect | null)?.target?.classList?.contains("ls-clock"));
      const inFlight = { flying: flying(), clock: clocks().length, clockMs: Number(clocks()[0]?.effect?.getComputedTiming().activeDuration ?? 0), moved: JSON.stringify(camera()) !== JSON.stringify(camAt) };
      for (let i = 0; i < 4; i++) {
        for (const a of finite()) a.finish();
        await sleep(40);
      }
      await sleep(250);
      out.flight = { inFlight, landed: centred("5110"), flying: flying(), clocks: clocks().length, band: [...vp().classList].find((c) => c.startsWith("ls-band-")) ?? null, zoom: camera()?.zoom ?? null };
      // a wheel during a flight stops it where it is
      goTo("5101");
      await sleep(60);
      const wasFlying = flying();
      vp().dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 10, ...at(vp(), 0.5, 0.5) }));
      await sleep(40);
      out.stopped = { wasFlying, flying: flying(), clocks: clocks().length, landed: centred("5101") };
      out.mode = document.documentElement.dataset.motion;
    } catch (err) {
      out.error = String(err instanceof Error ? err.stack : err);
    }
    report("mb-landscape-fly-audit", out);
  });

  // ---- tool windows (S5): what the tools and review audits look at and do ----
  const placedWin = (tool: string) => document.querySelector<HTMLElement>(`.ls-world .ls-window[data-tool="${tool}"]`);
  const dockedWin = (tool: string) => document.querySelector<HTMLElement>(`.ls-dock .ls-window[data-tool="${tool}"]`);
  const stored = (tool: string) => Object.entries(landscape.tools).filter(([, w]) => w.tool === tool).map(([id, w]) => ({ id, ...w }));
  const rail = (label: string) => document.querySelector<HTMLElement>(`.activitybar button[aria-label="${label}"]`);
  const keyDown = async (k: string, mods: KeyboardEventInit) => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...mods }));
    await sleep(600);
  };
  const styleRect = (el: HTMLElement | null) => (el ? { x: parseFloat(el.style.left), y: parseFloat(el.style.top), w: parseFloat(el.style.width), h: parseFloat(el.style.height) } : null);
  /** Just right of the workspace, top-aligned, a gap between: where the rail opens a workspace's window. */
  const besideOf = (id: string, el: HTMLElement | null) => {
    const r = styleRect(el);
    const n = styleRect(node(id));
    return !!r && !!n && r.y === n.y && r.x >= n.x + n.w && r.x - (n.x + n.w) <= 2 * GAP;
  };
  const scopeOf = (el: HTMLElement | null) => el?.querySelector(".ls-win-scope")?.textContent ?? null;
  /** The main-process calls made since `mark` that name a session or a folder: what a tool did with its scope. */
  const usedSince = (mark: number) => calls.slice(mark).filter((c) => c.fn !== "landscapeUpdate").map((c) => `${c.fn} ${JSON.stringify(c.args)}`);
  const wholeInView = (el: Element | null) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const v = vp().getBoundingClientRect();
    return r.left >= v.left - 1 && r.top >= v.top - 1 && r.right <= v.right + 1 && r.bottom <= v.bottom + 1;
  };
  const ctxRows = () => {
    const m = document.querySelector(".mb-ctx");
    return m
      ? [...m.children].map((e) =>
          e.classList.contains("mb-ctx-sep") ? "-" : e.classList.contains("mb-ctx-h") ? `# ${e.textContent}` : `${e.querySelector(".mb-ctx-t")?.textContent ?? ""}${(e as HTMLButtonElement).disabled ? " (off)" : ""}${e.querySelector(".mb-ctx-k") ? ` [${e.querySelector(".mb-ctx-k")!.textContent}]` : ""}`
        )
      : null;
  };
  const closeCtx = async () => {
    document.querySelector(".mb-ctx")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await sleep(200);
  };
  const rightClick = async (el: Element, dx = 0.5, dy = 0.5) => {
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, ...at(el, dx, dy) }));
    await sleep(300);
    const rows = ctxRows();
    await closeCtx();
    return rows;
  };
  /** A right-click at (x, y) on `el`: what's at that point on screen may be a window or the dock over it. */
  const rightClickAt = async (el: Element, x: number, y: number) => {
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: x, clientY: y }));
    await sleep(300);
    const rows = ctxRows();
    await closeCtx();
    return rows;
  };
  const ctxPick = async (text: string) => {
    const b = [...document.querySelectorAll<HTMLButtonElement>(".mb-ctx button")].find((x) => x.querySelector(".mb-ctx-t")?.textContent === text);
    if (!b) throw new Error(`the menu has no ${text}`);
    b.click();
    await sleep(500);
  };
  const topTab = async (label: string) => {
    [...document.querySelectorAll<HTMLElement>(".tab")].find((b) => b.textContent?.trim() === label)!.click();
    await sleep(700);
  };
  const at100 = async (key: string) => {
    document.querySelector<HTMLElement>(`.area-tree .lt-area[data-area="${CSS.escape(key)}"] .lt-head`)!.click();
    await sleep(400);
    document.querySelector<HTMLElement>(".ls-hud-btn.pct")!.click();
    await sleep(700);
  };
  const headBtn = (key: string, text: string) => [...document.querySelectorAll<HTMLElement>(`${areaEl(key)} .ls-ah button`)].find((b) => b.textContent?.trim() === text) ?? null;
  const artRows = (el: HTMLElement | null) => [...(el?.querySelectorAll(".art-row .art-name") ?? [])].map((n) => n.textContent);
  const setField = async (input: HTMLInputElement, value: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(50);
  };

  // ?landscapeToolsAudit (with ?motion=off): tool windows and the workspace's actions (S5). Each workspace tool opened
  // from the rail beside the selected workspace, on its worktree, and closed and opened again by its key; one docked,
  // following the selection, and placed again beside it; what's placed and docked kept when the landscape mounts again;
  // a placed window moving with its area; one action model behind ⋯, right-click (on the header, on a card, in the
  // area tree) and an area's patch zoomed out; a dead workspace's card; an area's artifacts on this Mac added to,
  // placed, followed through the area's rename and removed from, and a room's area showing the room's. Into
  // <script id="mb-landscape-tools-audit">.
  if (params.has("landscapeToolsAudit")) waitFor(".ls-world .ls-node", async () => {
    const out: Record<string, unknown> = {};
    try {
      await sleep(900);
      const s1 = sessions.find((s) => s.id === "s1")!;
      const s5 = sessions.find((s) => s.id === "s5")!;

      // the rail on the landscape: the tools by their windows' names, Artifacts with them
      out.rail = [...document.querySelectorAll<HTMLElement>(".activitybar button")].map((b) => b.getAttribute("aria-label"));

      // each workspace tool from the rail: beside the selected workspace, scoped to it, working on its worktree
      await pick("s1");
      const opened: Record<string, unknown> = {};
      for (const [label, tool] of [["Files", "files"], ["Changes", "changes"], ["Search", "search"], ["Run & debug", "run"]] as const) {
        const mark = calls.length;
        rail(label)!.click();
        await sleep(800);
        const el = placedWin(tool);
        const st = stored(tool);
        const used = usedSince(mark);
        opened[tool] = {
          windows: st.length,
          beside: besideOf("s1", el),
          scope: scopeOf(el),
          stored: st[0] ? { session: st[0].session ?? null, area: st[0].area ?? null, docked: st[0].docked } : null,
          lit: rail(label)!.getAttribute("aria-pressed"),
          onItsWorktree: used.some((u) => u.includes(`["s1"`) || u.includes(JSON.stringify(s1.cwd))),
          inView: wholeInView(el),
          apart: apartAll(),
        };
      }
      out.opened = opened;
      // the keys close the window open on the selection, and open it again; ⌘B is Files too
      const keys: Record<string, { closed: boolean; open: boolean }> = {};
      for (const [name, tool, k, mods] of [
        ["⇧⌘E", "files", "E", { metaKey: true, shiftKey: true }],
        ["⌘B", "files", "b", { metaKey: true }],
        ["⌃⇧G", "changes", "G", { ctrlKey: true, shiftKey: true }],
        ["⇧⌘F", "search", "F", { metaKey: true, shiftKey: true }],
        ["⇧⌘D", "run", "D", { metaKey: true, shiftKey: true }],
      ] as const) {
        await keyDown(k, mods);
        const closed = !placedWin(tool) && !stored(tool).length;
        await keyDown(k, mods);
        keys[name] = { closed, open: !!placedWin(tool) && stored(tool).length === 1 && besideOf("s1", placedWin(tool)) };
      }
      out.keys = keys;

      // docked: it gives up its place and follows the selected workspace; placed again, beside that one
      document.querySelector<HTMLElement>('.ls-world .ls-window[data-tool="files"] [aria-label="Dock it"]')!.click();
      await sleep(500);
      const dockedAt = { inDock: !!dockedWin("files"), placed: !!placedWin("files"), stored: stored("files")[0] ?? null, scope: scopeOf(dockedWin("files")) };
      let mark = calls.length;
      await pick("s5");
      await sleep(400);
      const follows = { scope: scopeOf(dockedWin("files")), onS5: usedSince(mark).some((u) => u.includes(`["s5"`) || u.includes(JSON.stringify(s5.cwd))) };
      dockedWin("files")!.querySelector<HTMLElement>('[aria-label="Place it on the landscape"]')!.click();
      await sleep(800);
      out.dock = { docked: dockedAt, follows, placedAgain: { beside: besideOf("s5", placedWin("files")), stored: stored("files")[0] ?? null, inDock: !!dockedWin("files") } };
      // Search docked too, for the mount that follows
      document.querySelector<HTMLElement>('.ls-world .ls-window[data-tool="search"] [aria-label="Dock it"]')!.click();
      await sleep(500);

      // mounted again (another tab and back): every window where it was, docked ones docked
      const shot = () => ({
        placed: Object.fromEntries([...document.querySelectorAll<HTMLElement>(".ls-world .ls-window")].map((w) => [w.dataset.win, styleRect(w)])),
        docked: [...document.querySelectorAll<HTMLElement>(".ls-dock .ls-window")].map((w) => w.dataset.win),
      });
      const before = shot();
      const storedBefore = JSON.stringify(landscape.tools);
      await topTab("Dashboard");
      await topTab("Landscape");
      await sleep(500);
      out.remount = { before, after: shot(), storedSame: JSON.stringify(landscape.tools) === storedBefore };

      // a placed window moves with its area: Run, placed on s1 in 5101, as 5101 is dragged by its name
      await fitView();
      const run = stored("run")[0];
      const runWas = { ...run.placement! };
      const areaWas = { ...landscape.areas["5101"] };
      const nameEl = document.querySelector(`${areaEl("5101")} .ls-area-title .n`)!;
      const nameBox = nameEl.getBoundingClientRect();
      await dragAlong(mid(nameBox), { x: mid(nameBox).x + 60, y: mid(nameBox).y + 140 }, undefined, nameEl);
      const runNow = landscape.tools[run.id].placement!;
      const areaNow = landscape.areas["5101"];
      out.withArea = {
        moved: areaNow.x !== areaWas.x || areaNow.y !== areaWas.y,
        dx: [areaNow.x - areaWas.x, runNow.x - runWas.x],
        dy: [areaNow.y - areaWas.y, runNow.y - runWas.y],
        drawn: styleRect(placedWin("run")),
        stored: runNow,
        apart: apartAll(),
      };

      // one action model: s1's ⋯ and right-click on its card zoomed out, on its header at 100%, and its tree row
      const cardMenu = await rightClick(node("s1")!);
      node("s1")!.querySelector<HTMLElement>(".ls-more")!.click();
      await sleep(300);
      const cardMore = ctxRows();
      await closeCtx();
      // an area's patch zoomed out, in its lower right corner clear of its workspaces: its own model; a room's has
      // Chat, any other area's doesn't
      const onPatch = (key: string) => {
        const a = document.querySelector<HTMLElement>(areaEl(key))!;
        const r = a.getBoundingClientRect();
        return rightClickAt(a, r.right - 4, r.bottom - 4);
      };
      const area5102 = await onPatch("5102");
      const area5101 = await onPatch("5101");
      // the dead workspace's card: Resume and Close & clean up
      const deadActs = (id: string) => [...(node(id)?.querySelectorAll<HTMLButtonElement>(".ls-card-acts button") ?? [])];
      const s6Acts = deadActs("s6").map((b) => b.textContent);
      const y1Acts = deadActs("y1").map((b) => b.textContent);
      mark = calls.length;
      deadActs("s6").find((b) => b.textContent === "Resume")!.click();
      await sleep(600);
      // what resuming re-reads is asked first, as everywhere a session resumes
      const cost = document.querySelector<HTMLElement>(".modal.cost-dlg");
      const costAsked = cost?.querySelector("h3")?.textContent ?? null;
      cost?.querySelector<HTMLElement>("button.primary")?.click();
      await sleep(900);
      const resumed = calls.slice(mark).map((c) => `${c.fn} ${JSON.stringify(c.args)}`).filter((c) => c.includes('"s6"'));
      mark = calls.length;
      deadActs("y1").find((b) => b.textContent === "Close & clean up")!.click();
      await sleep(900);
      const cleaned = calls.slice(mark).map((c) => `${c.fn} ${JSON.stringify(c.args)}`).filter((c) => c.includes('"y1"') || c.includes("5110-donor-entities"));
      out.dead = { s6: s6Acts, y1: y1Acts, costAsked, resumed, cleaned, s6Now: sessions.find((s) => s.id === "s6")?.status ?? null, y1Gone: !sessions.some((s) => s.id === "y1") };

      await at100("5101");
      const head = node("s1")!.querySelector(".ls-head")!;
      const headMenu = await rightClick(head, 0.3, 0.5);
      node("s1")!.querySelector<HTMLElement>(".ls-head .ls-more")!.click();
      await sleep(300);
      const headMore = ctxRows();
      await closeCtx();
      const treeMenu = await rightClick(await treeRow("s1"));
      // picking from it does it: Mute notifications
      node("s1")!.querySelector<HTMLElement>(".ls-head .ls-more")!.click();
      await sleep(300);
      mark = calls.length;
      await ctxPick("Mute notifications");
      const muted = calls.slice(mark).filter((c) => c.fn === "sessionMute").map((c) => c.args);
      // the header's chips and footer at 100%
      const s1Node = node("s1")!;
      const chrome = {
        chips: [...s1Node.querySelectorAll(".ls-head .ls-chips > *")].length,
        foot: [...s1Node.querySelectorAll(".ls-foot .cell .k")].map((k) => k.textContent),
        footShown: [...s1Node.querySelectorAll<HTMLElement>(".ls-foot .cell")].filter((c) => c.offsetWidth > 0).length,
      };
      out.actions = { cardMenu, cardMore, headMenu, headMore, treeMenu, muted, area5102, area5101, chrome };

      // an area's artifacts on this Mac: its window lists them; one added, one placed as a card, the area renamed, one removed
      await at100("5102");
      mark = calls.length;
      headBtn("5102", "Artifacts")!.click();
      await sleep(800);
      let art = placedWin("artifacts");
      const listed = { count: art?.querySelector(".art-count")?.textContent ?? null, rows: artRows(art), scope: scopeOf(art), stored: stored("artifacts")[0] ?? null, asked: usedSince(mark).filter((u) => u.startsWith("artifactsList")) };
      [...art!.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "+ Add")!.click();
      await sleep(300);
      menuItem("Note")!.click();
      await sleep(400);
      const dlg = document.querySelector<HTMLElement>(".modal.art-new-note");
      const lifted = !!dlg && !dlg.closest(".ls-world");
      await setField(dlg!.querySelector<HTMLInputElement>("input[type=text]")!, "Perf budget");
      mark = calls.length;
      [...dlg!.querySelectorAll<HTMLButtonElement>("button.primary")].find((b) => b.textContent?.startsWith("Add note"))!.click();
      await sleep(900);
      const added = { lifted, calls: calls.slice(mark).filter((c) => c.fn.startsWith("artifacts")).map((c) => [c.fn, ...c.args.slice(0, 2)]), rows: artRows(placedWin("artifacts")) };
      // Place: a card in the area
      const row = (name: string) => [...placedWin("artifacts")!.querySelectorAll<HTMLElement>(".art-row")].find((r) => r.querySelector(".art-name")?.textContent === name);
      row("React profiler docs")!.querySelector<HTMLElement>('[data-action="place"]')!.click();
      await sleep(800);
      const card = Object.entries(landscape.cards)[0];
      const placedCard = { stored: card ? card[1] : null, drawn: document.querySelectorAll(".ls-world .ls-acard").length, tag: !!row("React profiler docs")?.querySelector(".art-placed") };
      // the area renamed: its artifacts, window and card go with it
      document.querySelector<HTMLElement>(`${areaEl("5102")} .ls-ah .ls-ah-more`)!.click();
      await sleep(300);
      await ctxPick("Rename…");
      await nameIt("Pathways");
      await sleep(500);
      art = placedWin("artifacts");
      const renamed = {
        rows: artRows(art),
        scope: scopeOf(art),
        window: stored("artifacts")[0]?.area ?? null,
        card: Object.values(landscape.cards)[0]?.area ?? null,
        shelves: Object.keys(artifactRooms).filter((k) => k.startsWith("area:")),
      };
      // removed, after its dialog
      mark = calls.length;
      row("Perf budget")!.querySelector<HTMLElement>('[data-action="remove"]')!.click();
      await sleep(300);
      const confirm = document.querySelector<HTMLElement>(".modal.close-dlg");
      const confirmText = confirm?.querySelector("h3")?.textContent ?? null;
      confirm!.querySelector<HTMLElement>("button.primary")!.click();
      await sleep(800);
      const removed = { confirm: confirmText, calls: calls.slice(mark).filter((c) => c.fn === "artifactsRemove").map((c) => c.args[0]), rows: artRows(placedWin("artifacts")) };
      // a room's area: the room's artifacts, shared with it
      await at100("5101");
      headBtn("5101", "Artifacts")!.click();
      await sleep(800);
      const roomWin = [...document.querySelectorAll<HTMLElement>('.ls-world .ls-window[data-tool="artifacts"]')].find((w) => w.querySelector(".ls-win-scope")?.textContent?.includes("5101")) ?? null;
      const room = { count: roomWin?.querySelector(".art-count")?.textContent ?? null, rows: artRows(roomWin), expected: artifactRooms[ROOM_5101]?.items.map((a) => a.name) ?? null };
      out.artifacts = { listed, added, placedCard, renamed, removed, room };
    } catch (err) {
      out.error = String(err instanceof Error ? err.stack : err);
    }
    report("mb-landscape-tools-audit", out);
  });

  // ---- the selection bar (S6a) ----
  const selbar = () => document.querySelector<HTMLElement>(".ls-selbar");
  const rectOf = (el: Element | null) => {
    const r = el?.getBoundingClientRect();
    return r ? { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } : null;
  };
  /** A bar item as it reads: its text pieces joined ("Tools ▾", "Focus ⌘E"), ⋯ for the menu, "(off)" when it's off. */
  const barLabel = (i: Element) => {
    const b = i.querySelector("button");
    if (!b) return "";
    const text = b.classList.contains("ls-sb-dots") ? "⋯" : [...b.childNodes].map((n) => n.textContent?.trim() ?? "").filter(Boolean).join(" ");
    return `${text}${b.disabled ? " (off)" : ""}`;
  };
  /** What the bar shows: its name and status, its row's items, its second row's, and each off item's reason. */
  const barNow = () => {
    const b = selbar();
    if (!b) return null;
    const v = vp().getBoundingClientRect();
    const r = b.getBoundingClientRect();
    return {
      name: b.querySelector(".ls-sb-name")?.textContent ?? null,
      status: b.querySelector(".ls-sb-status")?.textContent ?? null,
      row: [...b.querySelectorAll(".ls-sb-row > .ls-sb-i:not(.ls-sb-id)")].map(barLabel),
      row2: [...b.querySelectorAll(".ls-sb-row2 > .ls-sb-i")].map(barLabel),
      why: Object.fromEntries([...b.querySelectorAll<HTMLButtonElement>("button:disabled")].map((x) => [barLabel(x.parentElement!), x.title])),
      rect: { x: Math.round(r.left - v.left), y: Math.round(r.top - v.top), w: Math.round(r.width), h: Math.round(r.height) },
      inView: r.left >= v.left + 7 && r.right <= v.right - 7 && r.top >= v.top - 1 && r.bottom <= v.bottom + 1,
      inWorld: !!b.closest(".ls-world"),
      visible: getComputedStyle(b).visibility,
    };
  };
  const barBtn = (act: string) => selbar()?.querySelector<HTMLButtonElement>(`[data-act="${CSS.escape(act)}"]`) ?? null;
  /** The top of what an area draws on screen, relative to the viewport: its frame, header bar or name line. */
  const areaTop = (key: string) => {
    const v = vp().getBoundingClientRect();
    const tops = [...document.querySelectorAll<HTMLElement>(`${areaEl(key)}, ${areaEl(key)} .ls-area-head, ${areaEl(key)} .ls-area-title`)]
      .filter((e) => e.offsetParent && getComputedStyle(e).display !== "none" && getComputedStyle(e).visibility !== "hidden" && e.getBoundingClientRect().width > 0)
      .map((e) => e.getBoundingClientRect().top - v.top);
    return Math.round(Math.min(...tops));
  };
  const COVERS = ".ls-node, .ls-window, .ls-acard, .ls-hud, .ls-minimap, .ls-switcher, .ls-selbar, .ls-area-head, .ls-area-title, .ls-area-pill, .ls-banners, .ls-peek, .ls-note, .ls-marquee";
  /** A point of the bare landscape on screen: in area `key` and no other, or (null) in none. */
  const bareAt = (key: string | null) => {
    const v = vp().getBoundingClientRect();
    const areas = [...document.querySelectorAll<HTMLElement>(".ls-world .ls-area")].map((a) => ({ key: a.dataset.area, r: a.getBoundingClientRect() }));
    const r = key ? areas.find((a) => a.key === key)?.r : v;
    if (!r) throw new Error(`no area ${key} on the landscape`);
    for (let fy = 0.92; fy > 0.04; fy -= 0.04)
      for (let fx = 0.92; fx > 0.04; fx -= 0.04) {
        const x = r.left + r.width * fx;
        const y = r.top + r.height * fy;
        if (x < v.left + 4 || x > v.right - 4 || y < v.top + 60 || y > v.bottom - 4) continue;
        const el = document.elementFromPoint(x, y);
        if (!el || !vp().contains(el) || el.closest(COVERS)) continue;
        const inAreas = areas.filter((a) => x >= a.r.left && x <= a.r.right && y >= a.r.top && y <= a.r.bottom).map((a) => a.key);
        if (key ? inAreas.length === 1 && inAreas[0] === key : inAreas.length === 0) return { x, y, el };
      }
    throw new Error(`no bare point ${key ? `in ${key}` : "outside every area"} on screen`);
  };
  /** A click on the bare landscape at `p`, as a mouse makes it. */
  const clickBare = async (p: { x: number; y: number; el: Element }) => {
    pressAt(p.x, p.y, p.el);
    upAt(p.x, p.y);
    await sleep(300);
  };
  const selectAreaAt = (key: string) => clickBare(bareAt(key));
  /** Area `key` brought to zoom `z` by a pinch about its top edge, so its top stays where it was on screen (60 px down at least). */
  const zoomOnArea = async (key: string, z: number) => {
    const v = vp().getBoundingClientRect();
    const r = box(areaEl(key))!;
    const p = { x: Math.max(10, Math.min(v.width - 10, r.left + 40 - v.left)), y: Math.max(60, Math.min(v.height - 10, r.top - v.top)) };
    await pinchTo(z, p);
    await sleep(500);
  };
  /** The bar where it is now, against its area's top and left edges on screen. */
  const barOver = (key: string) => {
    const b = barNow();
    const v = vp().getBoundingClientRect();
    const a = box(areaEl(key))!;
    return b && { zoom: Math.round(zoomNow() * 1000) / 1000, band: [...vp().classList].find((c) => c.startsWith("ls-band-")) ?? null, bar: b, areaW: Math.round(a.width), gap: areaTop(key) - (b.rect.y + b.rect.h), left: b.rect.x - Math.max(8, Math.round(a.left - v.left)) };
  };
  const esc = (on: Element = document.activeElement ?? document.body) => on.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  const ctxTitles = () => Object.fromEntries([...document.querySelectorAll<HTMLButtonElement>(".mb-ctx button:disabled")].map((b) => [b.querySelector(".mb-ctx-t")?.textContent ?? "", b.title]));
  const menuAfter = async (open: () => void) => {
    open();
    await sleep(300);
    const rows = ctxRows();
    const why = ctxTitles();
    await closeCtx();
    return { rows, why };
  };
  const callsSince = (mark: number, fn: string) => calls.slice(mark).filter((c) => c.fn === fn).map((c) => c.args);

  // ?landscapeBarAudit=a…g (with ?motion=off): the selection bar (S6a), worked as a person would, in pages that
  // each stay well inside the preview's minute. =a: an area's bar at 12%, 30%, 60% and 100%, at screen size above its
  // area, a room's with its tools and one that isn't without; its buttons and ⋯ running the model's handlers; the
  // right-click on it and on its area; sliding inside the window; hidden while dragging and in focus; Esc after a menu.
  // =b: a workspace's bar, three selected, a taken-over session's, and a right-click on the empty landscape making a
  // workspace where it was clicked, in an area and in none. =c (640 px wide): buttons folded behind », the second
  // row, remembered, and measured again when the area's status grows. =d (with ?lsWindows): zoomed out to cards, windows
  // and cards inside their areas, and a peek taking Esc before the selection. =e: the area ⋯ menus of a room's area and
  // another's; New session here… with the area's repo and base; an area renamed staying selected, one removed let go,
  // a pill's click selecting it; with ?samView, a room's area offering only its own members to follow; a workspace's
  // Artifacts during a rename the landscape hasn't caught up with. =f (with
  // ?gitFail=5102-quickViewFreeze&closeFail=5110-donor-entities): a Shift-click on a terminal at 60%; the bar above the
  // area's name over workspaces at its top; Δ ? for changes that can't be read; Close… on three, one asking, one
  // failing, one closing. =g (with ?gitSlow=5102-quickViewFreeze): Close… on several
  // stopped with Cancel all, and a second Close… on several added after the first's rest. =h (with
  // ?gitSlow=5101-orgDropdowns&gitFail=5110-donor-entities): a right-click in an area hemmed in by locked ones making
  // its workspace there, the locked one in the way pushed aside whole; Close… on several waiting while a single Close's
  // dialog is open. Into
  // <script id="mb-landscape-bar-audit-<part>">.
  if (params.has("landscapeBarAudit")) waitFor(".ls-world .ls-node", async () => {
    const part = params.get("landscapeBarAudit") || "a";
    const out: Record<string, unknown> = { part };
    try {
      await sleep(900);
      if (part === "a") {
        await fitView();
        // an area that's a room's, and one that isn't, at each zoom: the bar the same size, above the area
        const zooms: Record<string, unknown[]> = { "5101": [], "5102": [] };
        for (const key of ["5101", "5102"]) {
          await fitView();
          await selectAreaAt(key);
          for (const z of [0.12, 0.3, 0.6, 1]) {
            await zoomOnArea(key, z);
            zooms[key].push(barOver(key));
          }
        }
        out.zooms = zooms;

        // 5102 at 30%: Ask for status from its button and from ⋯ makes the same call; Tools ▾ is the model's tools
        await fitView();
        await selectAreaAt("5102");
        await zoomOnArea("5102", 0.3);
        let mark = calls.length;
        barBtn("ask")!.click();
        await sleep(300);
        const fromButton = callsSince(mark, "groupStatusCheck");
        mark = calls.length;
        barBtn("more")!.click();
        await sleep(300);
        const more = ctxRows();
        await ctxPick("Ask for status");
        const fromMenu = callsSince(mark, "groupStatusCheck");
        const tools = await menuAfter(() => barBtn("tools")!.click());
        // the bar's right-click, and the area's own (on its name line or header), are ⋯'s rows
        const onBar = await menuAfter(() => selbar()!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, ...at(selbar()!, 0.3, 0.5) })));
        const head = document.querySelector(`${areaEl("5102")} .ls-area-head`) ?? document.querySelector(`${areaEl("5102")} .ls-area-title`);
        const onArea = await menuAfter(() => head!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, ...at(head!, 0.2, 0.5) })));
        out.handlers = { fromButton, fromMenu, more, tools: tools.rows, onBar: onBar.rows, onArea: onArea.rows };

        // 5101's Board from the bar and House board… from ⋯: the room's board both ways
        await fitView();
        await selectAreaAt("5101");
        await zoomOnArea("5101", 0.3);
        const boardOpen = () => !!document.querySelector(".modal.house-modal");
        barBtn("board")!.click();
        await sleep(500);
        const boardFromButton = boardOpen();
        esc();
        await sleep(300);
        const closed = !boardOpen();
        barBtn("more")!.click();
        await sleep(300);
        await ctxPick("House board…");
        const boardFromMenu = boardOpen();
        esc();
        await sleep(300);
        out.board = { boardFromButton, closed, boardFromMenu, stillSelected: barNow()?.name ?? null };

        // the bar slides along the window's right edge with its area; back with the area again
        const v = vp().getBoundingClientRect();
        const leftNow = () => box(areaEl("5101"))!.left;
        const before = barNow();
        for (let i = 0; i < 6 && Math.abs(leftNow() - (v.right - 120)) > 20; i++) {
          vp().dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, ...at(vp(), 0.5, 0.5), deltaX: Math.max(-600, Math.min(600, leftNow() - (v.right - 120))) }));
          await sleep(80);
        }
        await sleep(200);
        const slid = { bar: barNow(), areaLeft: Math.round(leftNow() - v.left), viewW: Math.round(v.width) };
        out.slide = { before: before?.rect ?? null, slid };

        // hidden while the area is dragged by its name, there again after
        await fitView();
        await selectAreaAt("5102");
        const name = document.querySelector(`${areaEl("5102")} .ls-area-title .n`) ?? document.querySelector(`${areaEl("5102")} .ls-area-title`)!;
        const nb = name.getBoundingClientRect();
        let during: string | null = null;
        await dragAlong(mid(nb), { x: mid(nb).x + 40, y: mid(nb).y + 24 }, () => (during = barNow()?.visible ?? null), name);
        out.drag = { during, after: barNow()?.visible ?? null, name: barNow()?.name ?? null };

        // Esc: an open ⋯ menu takes the first, the selection the next; Esc in the bar clears it too
        barBtn("more")!.click();
        await sleep(300);
        const menuOpen = !!document.querySelector(".mb-ctx");
        esc();
        await sleep(200);
        const afterFirst = { menu: !!document.querySelector(".mb-ctx"), bar: !!selbar(), selected: !!document.querySelector(`${areaEl("5102")}.selected`) };
        armFocus(vp());
        esc(vp());
        await sleep(200);
        const afterSecond = { bar: !!selbar(), selected: !!document.querySelector(".ls-area.selected") };
        await selectAreaAt("5102");
        barBtn("ask")!.focus();
        esc(barBtn("ask")!);
        await sleep(200);
        out.esc = { menuOpen, afterFirst, afterSecond, inBar: { bar: !!selbar(), selected: !!document.querySelector(".ls-area.selected") } };
      }

      if (part === "b") {
        // a workspace at 30%: its bar; Files from the bar and from ⋯ the same window on it; Focus fills the window
        await fitView();
        await pick("s1");
        await zoomOnArea("5101", 0.3);
        const ws30 = barNow();
        const wsMore = await menuAfter(() => barBtn("more")!.click());
        const wsRight = await menuAfter(() => node("s1")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, ...at(node("s1")!, 0.5, 0.5) })));
        barBtn("tool:files")!.click();
        await sleep(800);
        const filesFromBar = { windows: stored("files").length, session: stored("files")[0]?.session ?? null, scope: scopeOf(placedWin("files")) };
        // the window's own close, then Files from ⋯
        placedWin("files")!.querySelector<HTMLElement>('[aria-label="Close Files"]')!.click();
        await sleep(500);
        const closedFiles = stored("files").length;
        await pick("s1");
        barBtn("more")!.click();
        await sleep(300);
        await ctxPick("Files");
        await sleep(300);
        const filesFromMenu = { windows: stored("files").length, session: stored("files")[0]?.session ?? null, scope: scopeOf(placedWin("files")) };
        await pick("s1");
        barBtn("focus")!.click();
        await sleep(500);
        const inFocus = { focus: !!document.querySelector(".ls-focus .ls-node"), bar: !!selbar() };
        pointer(document.querySelector(".ls-focus .ls-head")!, "pointerdown", { button: 0 });
        // the press's own focus move: the focus frame has the keyboard, armed
        armFocus(document.querySelector<HTMLElement>(".ls-focus"));
        await sleep(100);
        esc();
        await sleep(400);
        const leftFocus = { focus: !!document.querySelector(".ls-focus .ls-node"), bar: barNow()?.name ?? null };
        // at 100% the workspace's own header carries its tools: no bar
        await zoomOnArea("5101", 1);
        await pick("s1");
        const at100 = { band: [...vp().classList].find((c) => c.startsWith("ls-band-")) ?? null, bar: !!selbar(), selected: document.querySelector(".ls-world .ls-node.selected")?.getAttribute("data-front") ?? null };
        out.workspace = { ws30, more: wsMore.rows, right: wsRight.rows, filesFromBar, closedFiles, filesFromMenu, inFocus, leftFocus, at100 };

        // a taken-over session: its turns and hand-on off in its bar's ⋯, saying why
        await fitView();
        await pick("y1");
        await zoomOnArea("5110", 0.3);
        const y1 = await menuAfter(() => barBtn("more")!.click());
        out.takenOver = { bar: barNow()?.name ?? null, rows: y1.rows, why: y1.why };

        // three selected with Shift: their bar, its right-click and the one on a picked card, and Move to area ▾
        await fitView();
        armFocus(vp());
        esc(vp());
        await sleep(200);
        const cleared = { bar: barNow()?.name ?? null, selected: document.querySelector(".ls-world .ls-node.selected")?.getAttribute("data-front") ?? null, active: document.activeElement?.className ?? null };
        for (const id of ["s1", "s2", "s4"]) {
          pointer(node(id)!.querySelector(".ls-head") ?? node(id)!, "pointerdown", { button: 0, shiftKey: true });
          await sleep(150);
        }
        await sleep(200);
        const three = barNow();
        const onPicked = await menuAfter(() => node("s2")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, ...at(node("s2")!, 0.5, 0.5) })));
        const onBar = await menuAfter(() => selbar()!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, ...at(selbar()!, 0.2, 0.5) })));
        const moveTo = await menuAfter(() => barBtn("move")!.click());
        barBtn("close")!.click();
        await sleep(400);
        const closeDlg = document.querySelector(".modal.close-many h3")?.textContent ?? null;
        const closeList = [...document.querySelectorAll(".modal.close-many .close-many-list li")].map((li) => li.textContent);
        esc();
        await sleep(300);
        out.several = { cleared, three, onPicked: onPicked.rows, onBar: onBar.rows, move: moveTo.rows, closeDlg, closeList, closeKept: !document.querySelector(".modal.close-many") && sessions.filter((s) => ["s1", "s2", "s4"].includes(s.id)).length };
        // Move to area ▾ → 5102: they join it, each placed inside it, and the selection is let go; the api stack, which
        // holds a teammate's tab, stays, and the note says so
        const moveMark = calls.length;
        barBtn("move")!.click();
        await sleep(300);
        await ctxPick("#5102 Pathways quick view freezes");
        await sleep(800);
        const placeOf = (id: string) => {
          const s = sessions.find((x) => x.id === id)!;
          const stack = stackKeyOf(s);
          return stack ? landscape.stacks[stack]?.placement : landscape.workspaces[id];
        };
        out.moved = {
          groups: ["s1", "s2", "s4"].map((id) => sessions.find((s) => s.id === id)?.taskGroup ?? null),
          inside: ["s1", "s4"].every((id) => !!placeOf(id) && inRect(placeOf(id)!, landscape.areas["5102"])),
          bar: !!selbar(),
          apart: apartAll(),
          setGroup: callsSince(moveMark, "setGroup"),
          note: noteText(),
        };
        armFocus(vp());
        esc(vp());
        await sleep(200);

        // a right-click on 5102's bare patch: the create rows and its area's; Claude… opens New session for 5102
        await fitView();
        const cam = () => camera()!;
        const toLs = (p: { x: number; y: number }) => {
          const v = vp().getBoundingClientRect();
          return { x: cam().x + (p.x - v.left) / cam().zoom, y: cam().y + (p.y - v.top) / cam().zoom };
        };
        const create = async (key: string | null, row: string) => {
          const p = bareAt(key);
          p.el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: p.x, clientY: p.y }));
          await sleep(300);
          const rows = ctxRows();
          const why = ctxTitles();
          const selected = document.querySelector(".ls-area.selected")?.getAttribute("data-area") ?? null;
          await ctxPick(row);
          await sleep(300);
          const dlg = document.querySelector<HTMLElement>(".modal.ns");
          const group = dlg?.querySelector(`button.mb-select[title="Group"]`)?.textContent?.trim() ?? null;
          const dialog = {
            title: dlg?.querySelector("h3")?.textContent ?? null,
            launch: dlg?.querySelector(".ns-launch button.on")?.textContent ?? null,
            mode: dlg?.querySelector(".ns-mode button.on")?.textContent ?? null,
            group,
            repo: dlg?.querySelector(".ns-chosen .t")?.textContent ?? null,
            ticketOpen: [...(dlg?.querySelectorAll("button.link") ?? [])].some((b) => b.textContent === "Hide"),
          };
          return { at: toLs(p), rows, why, selected, dialog };
        };
        const made = async () => {
          const ids = new Set(sessions.map((s) => s.id));
          document.querySelector<HTMLElement>(".modal.ns button.primary.cta")!.click();
          await sleep(1500);
          const s = sessions.find((x) => !ids.has(x.id));
          const placed = s ? landscape.workspaces[s.id] ?? null : null;
          return { id: s?.id ?? null, group: s?.taskGroup ?? null, placed };
        };
        const inArea = await create("5102", "Claude…");
        const madeIn = await made();
        out.createIn = { ...inArea, made: madeIn, area: landscape.areas["5102"] ?? null, firstRepo: landscape.areas["5102"]?.repos[0]?.path ?? null };
        // outside every area: only the create rows; Terminal… makes a loose terminal where it was clicked
        await fitView();
        const loose = await create(null, "Terminal…");
        const madeLoose = await made();
        out.createLoose = { ...loose, made: madeLoose };
        // From a ticket… and Resume a conversation… open the same dialog with the ticket field, or importing
        await fitView();
        const ticket = await create("5102", "From a ticket…");
        esc();
        await sleep(300);
        const importing = await create("5102", "Resume a conversation…");
        esc();
        await sleep(300);
        out.createOther = { ticket: ticket.dialog, importing: importing.dialog };
      }

      if (part === "c") {
        // 640 px wide: 5101's bar folds its last buttons behind », whose second row is remembered
        await fitView();
        await selectAreaAt("5101");
        await zoomOnArea("5101", 0.3);
        const folded = barNow();
        barBtn("more-buttons")!.click();
        await sleep(300);
        const extended = { bar: barNow(), stored: localStorage.getItem("mb.landscape.barExtended") };
        // another tab and back, the area selected again: still on two rows
        await topTab("Dashboard");
        await topTab("Landscape");
        await sleep(500);
        await fitView();
        await selectAreaAt("5101");
        await zoomOnArea("5101", 0.3);
        const remembered = barNow();
        barBtn("more-buttons")!.click();
        await sleep(300);
        const less = { bar: barNow(), stored: localStorage.getItem("mb.landscape.barExtended") };
        // a folded button on the second row runs its handler as in the row
        barBtn("more-buttons")!.click();
        await sleep(300);
        const mark = calls.length;
        barBtn("ask")!.click();
        await sleep(300);
        out.fold = { viewW: vp().clientWidth, folded, extended, remembered, less, askFromRow2: callsSince(mark, "groupStatusCheck") };
        // a workspace's bar at this width
        await pick("s1");
        await sleep(200);
        out.foldWs = barNow();
        // 5101's status grows while it's selected (three waiting, one working, one exited): the bar measures itself
        // again, folding more, and stays inside the window with ⋯ in it
        await fitView();
        await selectAreaAt("5101");
        await zoomOnArea("5101", 0.3);
        if (localStorage.getItem("mb.landscape.barExtended") === "true") barBtn("more-buttons")!.click();
        await sleep(200);
        const was = barNow();
        sessions = sessions.map((s) =>
          ["s1", "s8"].includes(s.id) ? { ...s, status: "waiting", waitingReason: "Claude needs your permission to use Bash", waitingSince: Date.now() } : s.id === "s3" ? { ...s, status: "working" } : s.id === "s4" ? { ...s, status: "dead", exitCode: 1 } : s
        );
        sessionsChanged();
        await sleep(800);
        const grown = barNow();
        const dots = selbar()?.querySelector(".ls-sb-dots")?.getBoundingClientRect();
        out.grown = { was, grown, dotsInView: !!dots && dots.right <= vp().getBoundingClientRect().right - 7 };
      }

      if (part === "d") {
        // zoomed out to cards with every area's windows and a card: each inside its area, clear of the others' names
        await fitView();
        await pinchTo(0.13);
        await sleep(600);
        const areaBoxes = Object.fromEntries([...document.querySelectorAll<HTMLElement>(".ls-world .ls-area")].map((a) => [a.dataset.area!, a.getBoundingClientRect()]));
        const names = [...document.querySelectorAll<HTMLElement>(".ls-world .ls-area")].map((a) => ({ key: a.dataset.area!, r: a.querySelector(".ls-area-title")?.getBoundingClientRect() ?? null }));
        const within = (r: DOMRect, a: DOMRect) => r.left >= a.left - 1 && r.top >= a.top - 1 && r.right <= a.right + 1 && r.bottom <= a.bottom + 1;
        const hits = (r: DOMRect, a: DOMRect | null) => !!a && r.left < a.right - 1 && r.right > a.left + 1 && r.top < a.bottom - 1 && r.bottom > a.top + 1;
        const areaOfWin = (id: string) => {
          const t = landscape.tools[id];
          return t?.area ?? (t?.session ? areaKeyOf(sessions.find((s) => s.id === t.session)!) : null);
        };
        const items = [
          ...[...document.querySelectorAll<HTMLElement>(".ls-world .ls-window[data-win]")].map((e) => ({ id: `win:${e.dataset.win}`, area: areaOfWin(e.dataset.win!), r: e.getBoundingClientRect() })),
          ...[...document.querySelectorAll<HTMLElement>(".ls-world .ls-acard[data-card]")].map((e) => ({ id: `card:${e.dataset.card}`, area: landscape.cards[e.dataset.card!]?.area ?? null, r: e.getBoundingClientRect() })),
        ];
        out.cards = {
          zoom: Math.round(zoomNow() * 1000) / 1000,
          band: [...vp().classList].find((c) => c.startsWith("ls-band-")) ?? null,
          items: items.map((it) => ({
            id: it.id,
            area: it.area,
            inside: !!it.area && !!areaBoxes[it.area] && within(it.r, areaBoxes[it.area]),
            overName: names.filter((n) => n.key !== it.area && hits(it.r, n.r)).map((n) => n.key),
            overArea: Object.entries(areaBoxes).filter(([k, a]) => k !== it.area && hits(it.r, a)).map(([k]) => k),
          })),
        };
        // a peek over a card, the area selected: Esc closes the peek, and only the next clears the selection
        await zoomOnArea("5102", 0.3);
        await selectAreaAt("5102");
        const card = node("s4")!;
        const c = at(card, 0.5, 0.5);
        for (const type of ["pointerover", "pointermove"]) card.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "mouse", pointerId: 7, ...c }));
        await sleep(PEEK_HOVER_MS + 300);
        const peekOpen = !!document.querySelector(".ls-peek");
        const bar = barNow()?.name ?? null;
        armFocus(vp());
        esc(vp());
        await sleep(300);
        const first = { peek: !!document.querySelector(".ls-peek"), bar: barNow()?.name ?? null };
        esc(vp());
        await sleep(300);
        out.peek = { peekOpen, bar, first, second: { bar: !!selbar(), selected: !!document.querySelector(".ls-area.selected") } };
      }

      const selectedArea = () => document.querySelector<HTMLElement>(".ls-world .ls-area.selected")?.dataset.area ?? null;
      if (part === "e") {
        // the area ⋯ of one that isn't a room's, and of a room's
        await fitView();
        await selectAreaAt("5102");
        await zoomOnArea("5102", 0.3);
        const plain = await menuAfter(() => barBtn("more")!.click());
        await fitView();
        await selectAreaAt("5101");
        await zoomOnArea("5101", 0.3);
        const room = await menuAfter(() => barBtn("more")!.click());
        // 5110's room (Nick and this Mac, not Sam): its header and ⋯ offer only Nick to follow (with ?samView)
        await fitView();
        await selectAreaAt("5110");
        const r5110 = await menuAfter(() => barBtn("more")!.click());
        await zoomOnArea("5110", 1);
        const header = [...document.querySelectorAll(`${areaEl("5110")} .ls-ah .team-follow button`)].map((b) => b.textContent?.trim() ?? "");
        await zoomOnArea("5101", 1);
        const header5101 = [...document.querySelectorAll(`${areaEl("5101")} .ls-ah .team-follow button`)].map((b) => b.textContent?.trim() ?? "");
        out.menus = { plain: plain.rows, room: room.rows, follow5110: { menu: (r5110.rows ?? []).filter((r) => r.startsWith("Follow")), header }, header5101 };

        // New session here… from 5102's ⋯, its first repo now client-portal on main: the dialog has them, and makes it there
        await api.landscapeUpdate({ areas: { "5102": { repos: [{ path: "/Users/you/Code/client-portal", base: "main" }] } } });
        await sleep(300);
        await fitView();
        await selectAreaAt("5102");
        barBtn("more")!.click();
        await sleep(300);
        await ctxPick("New session here…");
        await sleep(400);
        const dlg = document.querySelector<HTMLElement>(".modal.ns");
        const repo = dlg?.querySelector(".ns-chosen .t")?.textContent ?? null;
        const mark = calls.length;
        dlg?.querySelector<HTMLElement>("button.primary.cta")?.click();
        await sleep(1200);
        const made = callsSince(mark, "createSession").map((a) => {
          const o = a[0] as { repoPath?: string; baseBranch?: string; taskGroup?: string };
          return { repoPath: o.repoPath ?? null, baseBranch: o.baseBranch ?? null, taskGroup: o.taskGroup ?? null };
        });
        out.newHere = { repo, made };

        // 5102 renamed from its ⋯: still selected, under its new name, its bar there
        await fitView();
        await selectAreaAt("5102");
        barBtn("more")!.click();
        await sleep(300);
        await ctxPick("Rename…");
        await nameIt("Pathways");
        await sleep(600);
        out.renamed = { selected: selectedArea(), bar: barNow()?.name ?? null, title: document.querySelector('.ls-world .ls-area[data-area="Pathways"] .ls-area-title')?.textContent ?? null };

        // renamed again, the landscape's change held back: meanwhile s5's Artifacts opens the area the landscape holds
        renameLag = 2500;
        await fitView();
        await selectAreaAt("Pathways");
        barBtn("more")!.click();
        await sleep(300);
        await ctxPick("Rename…");
        await nameIt("Quick view");
        await pick("s5");
        await sleep(300);
        const lagging = { group: sessions.find((s) => s.id === "s5")?.taskGroup ?? null, held: Object.keys(landscape.areas).includes("Pathways") };
        barBtn("tool:artifacts")?.click();
        await sleep(600);
        const opened = Object.values(landscape.tools).filter((w) => w.tool === "artifacts").map((w) => w.area ?? null);
        await sleep(2500);
        renameLag = 0;
        out.artifactsMidRename = { ...lagging, opened, after: Object.values(landscape.tools).filter((w) => w.tool === "artifacts").map((w) => w.area ?? null) };

        // an empty area removed from its ⋯: let go, so one made again under its name isn't selected
        const all = Object.values(landscape.areas);
        const spare = { x: Math.max(...all.map((a) => a.x + a.w)) + 400, y: 0, w: 800, h: 400, repos: [] };
        await api.landscapeUpdate({ areas: { Spare: spare } });
        await sleep(300);
        await fitView();
        await selectAreaAt("Spare");
        const spareSelected = selectedArea();
        barBtn("more")!.click();
        await sleep(300);
        await ctxPick("Remove the area");
        await sleep(500);
        const afterRemove = { area: !!landscape.areas.Spare, selected: selectedArea(), bar: barNow()?.name ?? null };
        await api.landscapeUpdate({ areas: { Spare: spare } });
        await sleep(500);
        out.removed = { spareSelected, afterRemove, madeAgain: { selected: selectedArea(), bar: barNow()?.name ?? null } };
        await api.landscapeUpdate({ areas: { Spare: null } });
        await sleep(300);

        // 5101 collapsed from its ⋯, the selection let go: a click on its pill opens it and selects it
        await fitView();
        await selectAreaAt("5101");
        barBtn("more")!.click();
        await sleep(300);
        await ctxPick("Collapse to a pill");
        await sleep(400);
        armFocus(vp());
        esc(vp());
        await sleep(300);
        const before = { selected: selectedArea(), collapsed: !!landscape.areas["5101"]?.collapsed };
        document.querySelector<HTMLElement>('.ls-world .ls-area-pill[data-area="5101"], .ls-world [data-area="5101"] .ls-area-pill, .ls-world .ls-area-pill')?.click();
        await sleep(500);
        out.pill = { before, after: { selected: selectedArea(), collapsed: !!landscape.areas["5101"]?.collapsed, bar: barNow()?.name ?? null } };
      }

      if (part === "f") {
        // at 60%, s1 picked, then a Shift-click on s8's terminal: both selected
        await fitView();
        await zoomOnArea("5101", 0.6);
        await pick("s1");
        const term = node("s8")?.querySelector(".ls-term");
        pointer(term!, "pointerdown", { button: 0, shiftKey: true, ...at(term!, 0.5, 0.5) });
        pointer(term!, "pointerup", { button: 0, shiftKey: true, ...at(term!, 0.5, 0.5) });
        await sleep(300);
        out.shiftOnTerm = { bar: barNow()?.name ?? null };
        armFocus(vp());
        esc(vp());
        await sleep(300);

        // a workspace at its area's top, alone and with another: the bar above the area's name line or header, not on it
        const clearOf = (key: string) => {
          const b = barNow();
          return b && { bar: b.name, gap: areaTop(key) - (b.rect.y + b.rect.h), inView: b.inView };
        };
        const above: Record<string, unknown> = {};
        for (const z of [0.3, 0.6]) {
          await fitView();
          await zoomOnArea("5101", z);
          await pick("s1");
          above[`one@${z}`] = clearOf("5101");
          pointer(node("s8")!.querySelector(".ls-head") ?? node("s8")!, "pointerdown", { button: 0, shiftKey: true });
          await sleep(300);
          above[`two@${z}`] = clearOf("5101");
          armFocus(vp());
          esc(vp());
          await sleep(300);
        }
        out.above = above;

        // s5's changes can't be read (?gitFail): Δ ?, saying why
        await fitView();
        await pick("s5");
        await sleep(600);
        const changes = barBtn("tool:changes");
        out.gitFail = { label: changes ? [...changes.childNodes].map((n) => n.textContent?.trim() ?? "").filter(Boolean).join(" ") : null, title: changes?.title ?? null };
        armFocus(vp());
        esc(vp());
        await sleep(300);

        // Close… on s8 (uncommitted work: its own dialog, cancelled), y1 (?closeFail: reading it throws, said) and s6
        // (exited: closes): one at a time, the rest going on
        await fitView();
        for (const id of ["s8", "y1", "s6"]) {
          pointer(node(id)!.querySelector(".ls-head") ?? node(id)!, "pointerdown", { button: 0, shiftKey: true });
          await sleep(150);
        }
        const picked = barNow()?.name ?? null;
        barBtn("close")!.click();
        await sleep(400);
        const many = { title: document.querySelector(".modal.close-many h3")?.textContent ?? null, list: [...document.querySelectorAll(".modal.close-many .close-many-list li")].map((li) => li.textContent) };
        const notes = new Set<string>();
        const dialogs: string[] = [];
        document.querySelector<HTMLElement>(".modal.close-many button.primary")!.click();
        for (const end = Date.now() + 6000; Date.now() < end; ) {
          await sleep(100);
          const n = noteText();
          if (n) notes.add(n);
          const one = document.querySelector(".modal.close-dlg:not(.close-many)");
          if (one) {
            dialogs.push(one.querySelector("h3")?.textContent ?? "");
            [...one.querySelectorAll<HTMLButtonElement>("button.outline")].find((b) => b.textContent === "Cancel")!.click();
            await sleep(300);
          }
        }
        out.closeMany = { picked, many, dialogs, notes: [...notes], left: ["s8", "y1", "s6"].filter((id) => sessions.some((s) => s.id === id)) };
      }

      if (part === "g") {
        const shiftPick = async (ids: string[]) => {
          armFocus(vp());
          esc(vp());
          await sleep(200);
          await fitView();
          for (const id of ids) {
            pointer(node(id)!.querySelector(".ls-head") ?? node(id)!, "pointerdown", { button: 0, shiftKey: true });
            await sleep(150);
          }
        };
        const closeThem = async () => {
          barBtn("close")!.click();
          await sleep(400);
          document.querySelector<HTMLElement>(".modal.close-many button.primary")!.click();
        };
        const oneDialog = () => document.querySelector(".modal.close-dlg:not(.close-many)");
        const left = (ids: string[]) => ids.filter((id) => sessions.some((s) => s.id === id));

        // s1 and s8, both with uncommitted work: the first one's dialog offers Cancel all, which keeps both and asks no more
        await shiftPick(["s1", "s8"]);
        await closeThem();
        for (const end = Date.now() + 3000; !oneDialog() && Date.now() < end; ) await sleep(100);
        const first = { title: oneDialog()?.querySelector("h3")?.textContent ?? null, buttons: [...(oneDialog()?.querySelectorAll("button.outline, button.primary") ?? [])].map((b) => b.textContent?.trim() ?? "").filter((t) => !/^(Keep|Push|Discard)/.test(t)) };
        [...(oneDialog()?.querySelectorAll<HTMLButtonElement>("button.outline") ?? [])].find((b) => b.textContent === "Cancel all")?.click();
        let asked = 0;
        for (const end = Date.now() + 2000; Date.now() < end; ) {
          await sleep(100);
          if (oneDialog()) {
            asked++;
            [...oneDialog()!.querySelectorAll<HTMLButtonElement>("button.outline")].find((b) => b.textContent === "Cancel")?.click();
          }
        }
        out.cancelAll = { first, askedAfter: asked, left: left(["s1", "s8"]) };

        // s5 (its worktree read slowly, ?gitSlow) and s6 closing; while s5 is read, s4 and y1 closed too: added after s6,
        // so all four close
        await shiftPick(["s5", "s6"]);
        await closeThem();
        await sleep(300);
        await shiftPick(["s4", "y1"]);
        await closeThem();
        await sleep(7000);
        out.appended = { left: left(["s5", "s6", "s4", "y1"]), dialog: !!oneDialog() };
      }

      if (part === "h") {
        // "Hem", full but for a strip too low for a workspace, right of everything, locked "HemB" right of it and locked
        // "HemC" below it, each holding a workspace: a right-click in the strip, then Claude…, makes it there all the
        // same; Hem grows down towards the nearer edge, staying where it is, and HemC moves down whole, hemC1 with it
        const right = Math.max(...Object.values(landscape.areas).map((a) => a.x + a.w), ...Object.values(landscape.workspaces).map((w) => w.x + w.w)) + 3000;
        const like = sessions.find((s) => s.id === "s6")!;
        sessions = [...sessions, ...(["hem1", "hemB1", "hemC1"] as const).map((id, i) => ({ ...like, id, title: ["Hemmed in", "Right of it", "Below it"][i], taskGroup: ["Hem", "HemB", "HemC"][i], status: "idle" as const, exitCode: undefined }))];
        sessionsChanged();
        await api.landscapeUpdate({
          areas: { Hem: { x: right, y: 0, w: 2400, h: 2000, repos: [] }, HemB: { x: right + 2464, y: 0, w: 1200, h: 2000, repos: [], locked: true }, HemC: { x: right, y: 2064, w: 2400, h: 1200, repos: [], locked: true } },
          workspaces: { hem1: { x: right + 24, y: 48, w: 2352, h: 1400 }, hemB1: { x: right + 2488, y: 48, w: 1000, h: 800 }, hemC1: { x: right + 24, y: 2112, w: 1000, h: 600 } },
        });
        await sleep(600);
        const toWorld = (p: { x: number; y: number }) => {
          const v = vp().getBoundingClientRect();
          const c = camera()!;
          return { x: Math.round(c.x + (p.x - v.left) / c.zoom), y: Math.round(c.y + (p.y - v.top) / c.zoom) };
        };
        const before = structuredClone({ hem: landscape.areas.Hem, c: landscape.areas.HemC, c1: landscape.workspaces.hemC1, b: landscape.areas.HemB, b1: landscape.workspaces.hemB1 });
        await fitView();
        await zoomOnArea("Hem", 0.25);
        const rectOf = (sel: string) => ((r) => r && { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) })(document.querySelector(sel)?.getBoundingClientRect());
        let p: ReturnType<typeof bareAt>;
        try {
          p = bareAt("Hem");
        } catch (err) {
          throw new Error(`${err}: Hem ${JSON.stringify(rectOf('.ls-world .ls-area[data-area="Hem"]'))}, hem1 ${JSON.stringify(rectOf('.ls-world [data-front="hem1"]'))}, view ${JSON.stringify(rectOf(".ls-viewport"))}, stored ${JSON.stringify(landscape.areas.Hem)}`);
        }
        const click = toWorld(p);
        p.el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: p.x, clientY: p.y }));
        await sleep(300);
        const rows = ctxRows();
        const ids = new Set(sessions.map((s) => s.id));
        if (!rows?.includes("Claude…")) throw new Error(`the right-click at ${JSON.stringify(click)} offered ${JSON.stringify(rows)}`);
        await ctxPick("Claude…");
        await sleep(300);
        const dialog = !!document.querySelector(".modal.ns");
        document.querySelector<HTMLElement>(".modal.ns button.primary.cta")?.click();
        await sleep(1500);
        const made = sessions.find((x) => !ids.has(x.id));
        const w = made ? landscape.workspaces[made.id] : undefined;
        const hem = landscape.areas.Hem;
        const c = landscape.areas.HemC;
        const dy = c.y - before.c.y;
        out.hem = {
          dialog,
          note: noteText(),
          group: made?.taskGroup ?? null,
          inHem: !!w && w.x >= hem.x && w.x + w.w <= hem.x + hem.w && w.y >= hem.y && w.y + w.h <= hem.y + hem.h,
          // a new row just below hem1, the area's lowest, and within its own width of the click across
          byClick: !!w && Math.abs(w.x - click.x) <= w.w && w.y > landscape.workspaces.hem1.y + landscape.workspaces.hem1.h && w.y <= landscape.workspaces.hem1.y + landscape.workspaces.hem1.h + 24,
          hemStayed: hem.x === before.hem.x && hem.y === before.hem.y,
          cPushed: { dy: dy > 0, dx: c.x - before.c.x, locked: c.locked === true, c1Along: JSON.stringify(landscape.workspaces.hemC1) === JSON.stringify({ ...before.c1, y: before.c1.y + dy }) },
          bStayed: JSON.stringify([landscape.areas.HemB, landscape.workspaces.hemB1]) === JSON.stringify([before.b, before.b1]),
        };

        // s8 (its worktree read slowly, ?gitSlow) and s6 closing; while s8 is read, y1 closed on its own: its dialog
        // (?gitFail) stays until it's answered, s8's asked after it, then s6
        armFocus(vp());
        esc(vp());
        await sleep(200);
        await fitView();
        const oneDialog = () => document.querySelector(".modal.close-dlg:not(.close-many)");
        const shown = () => oneDialog()?.querySelector("h3")?.textContent ?? null;
        for (const id of ["s8", "s6"]) {
          pointer(node(id)!.querySelector(".ls-head") ?? node(id)!, "pointerdown", { button: 0, shiftKey: true });
          await sleep(150);
        }
        barBtn("close")!.click();
        await sleep(400);
        document.querySelector<HTMLElement>(".modal.close-many button.primary")!.click();
        await sleep(300);
        const y1 = node("y1")!.querySelector(".ls-head") ?? node("y1")!;
        y1.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, ...at(y1, 0.3, 0.5) }));
        await sleep(300);
        await ctxPick("Close & clean up…");
        await sleep(300);
        const single = shown();
        // s8's state is read meanwhile (4 s): y1's dialog stays, and nothing else closes
        await sleep(4500);
        const meanwhile = { dialog: shown(), left: ["s8", "s6", "y1"].filter((id) => sessions.some((s) => s.id === id)) };
        [...(oneDialog()?.querySelectorAll<HTMLButtonElement>("button.outline") ?? [])].find((b) => b.textContent === "Cancel")?.click();
        for (const end = Date.now() + 2000; oneDialog() && Date.now() < end; ) await sleep(100);
        for (const end = Date.now() + 6000; !oneDialog() && Date.now() < end; ) await sleep(100);
        const next = shown();
        [...(oneDialog()?.querySelectorAll<HTMLButtonElement>("button.outline") ?? [])].find((b) => b.textContent === "Cancel")?.click();
        await sleep(1200);
        out.waits = { single, meanwhile, next, left: ["s8", "s6", "y1"].filter((id) => sessions.some((s) => s.id === id)), dialog: !!oneDialog() };
      }
    } catch (err) {
      out.error = String(err instanceof Error ? err.stack : err);
    }
    report(`mb-landscape-bar-audit-${part}`, out);
  });

  // ?landscapeGhostAudit (with ?motion=off&lsClosed=y1): ghosts (S6b) drawn at zooms through the cards band and at 45%
  // and 100%. Each ghost: inside its area's patch and clear of another area's name line or header; every row it shows
  // wholly inside it, and its buttons inside their row; the rows it shows the first of its rows (a short one gives up
  // the last first); its kind shown only while its title is whole. Into <script id="mb-landscape-ghost-audit">.
  if (params.has("landscapeGhostAudit")) waitFor(".ls-world .ls-ghost", async () => {
    const out: Record<string, unknown> = {};
    try {
      await sleep(900);
      const shown = (e: Element) => {
        const st = getComputedStyle(e);
        const r = e.getBoundingClientRect();
        return st.display !== "none" && st.visibility !== "hidden" && r.width > 0 && r.height > 0;
      };
      const R = (r: DOMRect) => ({ x: r.left, y: r.top, w: r.width, h: r.height });
      const inside = (r: DOMRect, a: DOMRect) => r.left >= a.left - 0.5 && r.top >= a.top - 0.5 && r.right <= a.right + 0.5 && r.bottom <= a.bottom + 0.5;
      const meet = (r: DOMRect, a: DOMRect) => r.left < a.right && a.left < r.right && r.top < a.bottom && a.top < r.bottom;
      const zooms: { zoom: number; band: string | null; ghosts: Record<string, { area: string; rows: string[]; rect: Rect; kind: boolean; line: string | null }> }[] = [];
      const problems: string[] = [];
      for (const z of [0.1, 0.13, 0.15, 0.2, 0.3, 0.45, 1]) {
        await pinchTo(z);
        await sleep(400);
        const zoom = Math.round(zoomNow() * 1000) / 1000;
        const band = [...vp().classList].find((c) => c.startsWith("ls-band-")) ?? null;
        const ghosts: (typeof zooms)[number]["ghosts"] = {};
        const names = [...document.querySelectorAll<HTMLElement>(".ls-world .ls-area")].flatMap((a) =>
          [...a.querySelectorAll<HTMLElement>(":scope > .ls-area-title, :scope > .ls-area-head")].filter(shown).map((n) => ({ area: a.dataset.area ?? "", r: n.getBoundingClientRect() })),
        );
        for (const g of document.querySelectorAll<HTMLElement>(".ls-world .ls-ghost")) {
          if (!shown(g)) continue;
          const id = g.dataset.front ?? "?";
          const at = `${zoom} ${id}`;
          const gr = g.getBoundingClientRect();
          const area = g.dataset.area ?? "";
          const patch = document.querySelector(`.ls-world ${areaEl(area)}`);
          if (patch && !inside(gr, patch.getBoundingClientRect())) problems.push(`${at}: drawn past its area ${area}`);
          for (const n of names) if (n.area !== area && meet(gr, n.r)) problems.push(`${at}: drawn under ${n.area}'s name`);
          const box = g.querySelector(".lg-rows")!.getBoundingClientRect();
          if (!inside(box, gr)) problems.push(`${at}: its rows' box is past its place`);
          const rows = [...g.querySelectorAll<HTMLElement>("[data-row]")];
          // a row left out has wrapped to the column past the right edge, clipped
          const kept = rows.filter((r) => r.getBoundingClientRect().left < box.right - 1);
          kept.forEach((r, i) => {
            if (r !== rows[i]) problems.push(`${at}: shows ${r.dataset.row} without ${rows[i].dataset.row}`);
            const rr = r.getBoundingClientRect();
            if (!inside(rr, box)) problems.push(`${at}: its ${r.dataset.row} is cut by its edge`);
            for (const b of r.querySelectorAll("button"))
              if (shown(b) && !inside(b.getBoundingClientRect(), rr)) problems.push(`${at}: ${b.textContent} is past its ${r.dataset.row} row`);
            for (const n of names) if (n.area !== area && meet(rr, n.r)) problems.push(`${at}: its ${r.dataset.row} is under ${n.area}'s name`);
          });
          if (!kept.length) problems.push(`${at}: shows nothing`);
          // the title wins its head's room: the kind gives way, whole, before the title is cut
          const title = g.querySelector<HTMLElement>(".lg-title");
          const kindEl = g.querySelector<HTMLElement>(".lg-kind");
          const nameEl = g.querySelector<HTMLElement>(".lg-name");
          const kind = !!kindEl && !!nameEl && shown(kindEl) && inside(kindEl.getBoundingClientRect(), nameEl.getBoundingClientRect());
          if (title && title.scrollWidth > title.clientWidth + 0.5 && kind) problems.push(`${at}: its title is cut while its kind is shown`);
          ghosts[id] = { area, rows: kept.map((r) => r.dataset.row ?? "?"), rect: R(gr), kind, line: g.querySelector(".lg-line")?.textContent ?? null };
        }
        zooms.push({ zoom, band, ghosts });
      }
      out.zooms = zooms;
      out.problems = problems;
    } catch (err) {
      out.error = String(err instanceof Error ? err.stack : err);
    }
    report("mb-landscape-ghost-audit", out);
  });

  // ?landscapeGhostLifeAudit (with ?motion=off): a ghost's life (S6b), worked as a person would. The area tree's foot
  // without Previous, its Connected line kept; s4 closed from its menu leaving its ghost where it was, and reopened from
  // the ghost's Reopen in the same place; g2's Start fresh opening New session for its area; g1 forgotten from its ⋯,
  // its place let go; 5101's Clear ghosts (confirmed); the Loose row's menu offering Reopen all, which reopens p1.
  // Into <script id="mb-landscape-ghost-life-audit">.
  if (params.has("landscapeGhostLifeAudit")) waitFor(".ls-world .ls-ghost", async () => {
    const out: Record<string, unknown> = {};
    try {
      await sleep(900);
      await fitView();
      const ghost = (id: string) => document.querySelector<HTMLElement>(`.ls-world .ls-ghost[data-front="${CSS.escape(id)}"]`);
      const wsNode = (id: string) => document.querySelector<HTMLElement>(`.ls-world .ls-node[data-front="${CSS.escape(id)}"]`);
      // its place, as its style has it: calc(<x>px + var(--ci))
      const placeOf = (el: HTMLElement | null) => {
        const num = (v: string) => Number(/(-?[\d.]+)px/.exec(v)?.[1] ?? NaN);
        return el ? { x: num(el.style.left), y: num(el.style.top), h: num(el.style.getPropertyValue("--gh")) } : null;
      };
      const tree = document.querySelector(".area-tree");
      out.foot = { previous: [...(tree?.querySelectorAll("h2") ?? [])].some((h) => h.textContent?.includes("Previous")), connected: !!tree?.querySelector(".lt-connected") };

      // ⌘K offers every ghost at once (Previous's restore all)
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }));
      await sleep(300);
      const input = document.querySelector<HTMLInputElement>(".palette input");
      if (input) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "closed workspaces");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await sleep(200);
      }
      out.palette = [...document.querySelectorAll<HTMLElement>(".palette .row .lab")].map((r) => r.textContent ?? "").filter((t) => t.includes("closed workspaces"));
      esc(input ?? undefined);
      await sleep(300);

      // closed from its menu: no dialog for a terminal with no worktree, kept resumable, its ghost at its place
      const s4Place = { ...landscape.workspaces.s4! };
      let mark = calls.length;
      wsNode("s4")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, ...at(wsNode("s4")!, 0.5, 0.3) }));
      await sleep(300);
      await ctxPick("Close…");
      await sleep(600);
      out.closed = { kill: callsSince(mark, "killSession"), ghost: !!ghost("s4"), node: !!wsNode("s4"), stored: landscape.workspaces.s4, at: placeOf(ghost("s4")), was: s4Place };

      // Reopen: relaunched under its id, back where it was
      mark = calls.length;
      ghost("s4")!.querySelector<HTMLButtonElement>('[data-act="reopen"]')!.click();
      await sleep(900);
      out.reopened = { relaunch: callsSince(mark, "relaunchSession"), ghost: !!ghost("s4"), node: !!wsNode("s4"), nodeAt: placeOf(wsNode("s4")), stored: landscape.workspaces.s4 };

      // Start fresh, for g2 whose worktree is gone: New session, for its area
      ghost("g2")!.querySelector<HTMLButtonElement>('[data-act="fresh"]')!.click();
      await sleep(600);
      const dlg = document.querySelector(".modal");
      out.fresh = { dialog: !!dlg, title: dlg?.querySelector("h3, h2")?.textContent ?? null, mentions5101: !!dlg?.textContent?.includes("5101") };
      esc(dlg ?? undefined);
      await sleep(400);

      // Forget g1 from its menu (zoomed out to cards a ghost has no ⋯, so its right-click): let go in main, and its place
      // on the landscape
      mark = calls.length;
      out.moreZoomedOut = !!ghost("g1")!.querySelector(".ls-more");
      ghost("g1")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, ...at(ghost("g1")!, 0.5, 0.5) }));
      await sleep(300);
      const g1Menu = ctxRows();
      await ctxPick("Forget it");
      await sleep(700);
      out.forgot = { menu: g1Menu, kill: callsSince(mark, "killSession"), ghost: !!ghost("g1"), stored: landscape.workspaces.g1 ?? null };

      // 5101's Clear ghosts, confirmed
      const asked: string[] = [];
      w.confirm = (q: string) => (asked.push(q), true);
      mark = calls.length;
      const head = document.querySelector(`${areaEl("5101")} .ls-area-head`) ?? document.querySelector(`${areaEl("5101")} .ls-area-title`);
      head!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, ...at(head!, 0.2, 0.5) }));
      await sleep(300);
      const areaMenu = ctxRows();
      await ctxPick("Clear ghosts (1)…");
      await sleep(700);
      out.cleared = { menu: areaMenu, asked, kill: callsSince(mark, "killSession"), ghost: !!ghost("g2") };

      // the Loose row's menu: Reopen all (1), which reopens p1
      mark = calls.length;
      const loose = document.querySelector<HTMLElement>('.area-tree .lt-area[data-area="ungrouped"] .lt-head');
      loose!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, ...at(loose!, 0.3, 0.5) }));
      await sleep(300);
      const looseMenu = ctxRows();
      await ctxPick("Reopen all (1)");
      await sleep(900);
      out.loose = { menu: looseMenu, relaunch: callsSince(mark, "relaunchSession"), ghost: !!ghost("p1"), node: !!wsNode("p1") };
    } catch (err) {
      out.error = String(err instanceof Error ? err.stack : err);
    }
    report("mb-landscape-ghost-life-audit", out);
  });

  // ?landscapeArrangeAudit=a|b (with ?motion=off): moving, resizing, stacks and Tidy (S6b), worked as a person would, at
  // 50%. =a: s8 dragged by its header to within a few px of the api stack's left edge (a guide drawn meanwhile, the
  // place snapped to that edge), then its right edge dragged (the size box saying cols × rows, the pty resized only
  // after the drop), then 5102 locked and s5 dragged and resized (refused, said). =b: s4 and s8 picked and stacked with
  // ⌘G, its tab bringing s8 to the front, s8's tab dragged out into 5101 (the stack of one let go); 5101 tidied with T
  // and put back with the note's Undo. Into <script id="mb-landscape-arrange-audit-<part>">.
  if (params.has("landscapeArrangeAudit")) waitFor(".ls-world .ls-node", async () => {
    const part = params.get("landscapeArrangeAudit") || "a";
    const out: Record<string, unknown> = { part };
    try {
      await sleep(900);
      await fitView();
      await zoomOnArea("5101", 0.5);
      const ws = (key: string) => document.querySelector<HTMLElement>(`.ls-world .ls-node[data-ws="${CSS.escape(key)}"]`);
      const spacer = (el: HTMLElement) => el.querySelector<HTMLElement>(".ls-head .ls-spacer")!;
      const bareHead = (el: HTMLElement) => mid(spacer(el).getBoundingClientRect());
      const guidesNow = () => [...document.querySelectorAll<HTMLElement>(".ls-guides .ls-guide")].map((g) => g.dataset.axis ?? "?");
      const boxNow = () => {
        const b = document.querySelector<HTMLElement>(".ls-sizebox");
        return b && !b.hidden ? { size: b.dataset.size ?? null, label: b.textContent } : null;
      };
      const updates = (mark: number) => calls.slice(mark).filter((c) => c.fn === "landscapeUpdate").length;
      /** A drag from `from` by (dx, dy) in steps; `during` reads what's shown before the release. */
      const dragBy = async <T,>(from: { x: number; y: number }, dx: number, dy: number, during: () => T, on?: Element) => {
        pressAt(from.x, from.y, on);
        for (let i = 1; i <= 6; i++) {
          moveTo(from.x + (dx * i) / 6, from.y + (dy * i) / 6);
          await sleep(16);
        }
        const seen = during();
        upAt(from.x + dx, from.y + dy);
        await sleep(800);
        return seen;
      };
      if (part === "a") {
        // moved by its header to the api stack's left edge, give or take 2 px on screen
        const dx = ws("ws:5101/api")!.getBoundingClientRect().left - node("s8")!.getBoundingClientRect().left + 2;
        let mark = calls.length;
        const during = await dragBy(bareHead(node("s8")!), dx, 24, () => ({ guides: guidesNow(), box: boxNow() }), spacer(node("s8")!));
        out.move = { during, guidesAfter: guidesNow().length, updates: updates(mark), s8: landscape.workspaces.s8, apiX: landscape.stacks["5101/api"]?.placement.x ?? null };

        // its right edge: a size box saying cols × rows while dragging, the pty resized only after the drop
        const before = { ...landscape.workspaces.s8! };
        mark = calls.length;
        const rz = node("s8")!.querySelector<HTMLElement>(".ls-rz.r")!;
        const seen = await dragBy(mid(rz.getBoundingClientRect()), 60, 0, () => ({ box: boxNow(), resized: callsSince(mark, "sessionResize").length, guides: guidesNow() }), rz);
        out.resize = { during: seen, boxAfter: boxNow(), updates: updates(mark), before, after: landscape.workspaces.s8 };

        // 5102 locked: s5 neither moves nor resizes, and the note says why
        tools("5102", "Lock")!.click();
        await sleep(400);
        mark = calls.length;
        await dragBy(bareHead(node("s5")!), 80, 40, () => null, spacer(node("s5")!));
        const moveSaid = noteText();
        const r5 = node("s5")!.querySelector<HTMLElement>(".ls-rz.b")!;
        await dragBy(mid(r5.getBoundingClientRect()), 0, 60, () => null, r5);
        out.locked = { updates: updates(mark), moveSaid, resizeSaid: noteText(), s5: landscape.workspaces.s5 };
      } else {
        // s4 and s8 picked (Shift-clicks on their headers) and stacked with ⌘G
        for (const id of ["s4", "s8"]) {
          const p = bareHead(node(id)!);
          node(id)!.querySelector(".ls-head .ls-spacer")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, shiftKey: true, pointerId: 3, clientX: p.x, clientY: p.y }));
          window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, button: 0, pointerId: 3, clientX: p.x, clientY: p.y }));
          await sleep(150);
        }
        await sleep(300);
        out.picked = [...document.querySelectorAll<HTMLElement>(".ls-world .ls-node.picked")].map((n) => n.dataset.front);
        armFocus(vp());
        let mark = calls.length;
        key(vp(), "g", { metaKey: true });
        await sleep(900);
        const stack = () => document.querySelector<HTMLElement>('.ls-world .ls-node.stack[data-ws^="ws:5101/tabs"]');
        const tabs = () => [...(stack()?.querySelectorAll<HTMLElement>(".ls-tab[data-sid]") ?? [])].map((t) => t.dataset.sid);
        out.stacked = { groups: callsSince(mark, "setGroup"), tabs: tabs(), front: stack()?.dataset.front ?? null, stored: landscape.stacks["5101/tabs"] ?? null, s4: landscape.workspaces.s4 ?? null, s8: landscape.workspaces.s8 ?? null };

        // its other tab brings s8 to the front
        const otherId = stack()?.dataset.front === "s8" ? "s4" : "s8";
        stack()!.querySelector<HTMLElement>(`.ls-tab[data-sid="${otherId}"]`)!.click();
        await sleep(500);
        out.switched = { to: otherId, front: stack()?.dataset.front ?? null, stored: landscape.stacks["5101/tabs"]?.active ?? null };

        // s8's tab dragged out over s1 in 5101: s8 is 5101's own again where it's dropped, what it lands on pushed
        // aside, and the stack of one is let go
        const tab8 = stack()!.querySelector<HTMLElement>('.ls-tab[data-sid="s8"]')!;
        const onto = bareHead(node("s1")!);
        mark = calls.length;
        const t0 = mid(tab8.getBoundingClientRect());
        const during = await dragBy(t0, onto.x - t0.x, onto.y - t0.y, () => ({ box: boxNow() }), tab8);
        const placed = Object.fromEntries(["s1", "s4", "s8"].map((id) => [id, landscape.workspaces[id] ?? null]));
        out.unstacked = { during, groups: callsSince(mark, "setGroup"), stack: !!stack(), stored: landscape.stacks["5101/tabs"] ?? null, s8: !!node("s8"), s4: !!node("s4"), placed, api: landscape.stacks["5101/api"]?.placement ?? null };

        // T on the selected area tidies it; the note's Undo puts every place back
        const placesBefore = JSON.stringify(landscape.workspaces);
        await selectAreaAt("5101");
        armFocus(vp());
        mark = calls.length;
        key(vp(), "t");
        await sleep(800);
        const said = noteText();
        const tidied = JSON.stringify(landscape.workspaces) !== placesBefore;
        const undo = [...document.querySelectorAll<HTMLButtonElement>(".ls-note .ls-note-act")].find((b) => b.textContent === "Undo");
        undo?.click();
        await sleep(800);
        out.tidy = { said, tidied, updates: updates(mark), undo: !!undo, back: JSON.stringify(landscape.workspaces) === placesBefore };
      }
    } catch (err) {
      out.error = String(err instanceof Error ? err.stack : err);
    }
    report(`mb-landscape-arrange-audit-${part}`, out);
  });

  // ?landscapeClosedAudit=list|hold (with ?motion=off): the Closed sessions list (S6b review), worked as a person would.
  // =list (with &lsClosed=y1&lsUnplaced=y1&lsRelaunchFails=o2): its rows (o1 in 5102, o2 in 5150, which has no area,
  // and y1, which Nick took over, closed off the landscape), each one's status; ⌘K's rows for it; o1's ↺ pressed twice
  // (one relaunch), o1 placed in 5102; o2's ↺ failing, then throwing, then reopening it in 5150's area formed again, its
  // group never changed; Reopen all off with only y1 left; y1's ✕ forgetting it, the list gone. =hold (with &lsHold
  // and &lsBigResume): the landscape not read yet, every closed session listed, g1's ↺ relaunching it, and Reopen all
  // asking once about what it costs. Into <script id="mb-landscape-closed-audit-<part>">.
  if (params.has("landscapeClosedAudit")) waitFor(".area-tree", async () => {
    const part = params.get("landscapeClosedAudit") || "list";
    const out: Record<string, unknown> = { part };
    try {
      await sleep(part === "hold" ? 1200 : 900);
      const list = () => document.querySelector<HTMLElement>(".area-tree [data-closed-list]");
      const row = (id: string) => list()?.querySelector<HTMLElement>(`[data-closed-sid="${CSS.escape(id)}"]`) ?? null;
      const rows = () => [...(list()?.querySelectorAll<HTMLElement>("[data-closed-sid]") ?? [])].map((r) => r.dataset.closedSid);
      /** The list's header at the sidebar's width: its words, whether any are cut, and what it's called in full. */
      const headOf = () => {
        const label = list()?.querySelector<HTMLElement>(".lt-closed-label");
        const word = list()?.querySelector<HTMLElement>(".lt-closed-word");
        const count = list()?.querySelector<HTMLElement>(".lt-closed-n")?.getBoundingClientRect();
        const toggle = list()?.querySelector<HTMLElement>(".lt-closed-toggle");
        const tr = toggle?.getBoundingClientRect();
        return {
          text: label?.textContent ?? null,
          height: Math.round(label?.getBoundingClientRect().height ?? 0),
          wrap: label ? getComputedStyle(label).whiteSpace : null,
          ellipsis: word ? getComputedStyle(word).textOverflow : null,
          cut: !!word && word.scrollWidth > word.clientWidth,
          countShown: !!count && !!tr && count.width > 0 && count.left >= tr.left && count.right <= tr.right + 0.5,
          aria: toggle?.getAttribute("aria-label") ?? null,
          title: toggle?.title ?? null,
        };
      };
      const acts = (id: string) => [...(row(id)?.querySelectorAll<HTMLButtonElement>("button[data-act]") ?? [])].map((b) => ({ act: b.dataset.act, disabled: b.disabled }));
      const sub = (id: string) => row(id)?.querySelector(".lt-closed-sub")?.textContent ?? null;
      const inside = (r: Rect | undefined, a: Rect | undefined) => !!r && !!a && r.x >= a.x && r.y >= a.y && r.x + r.w <= a.x + a.w && r.y + r.h <= a.y + a.h;
      out.rows = rows();
      out.head = list()?.querySelector(".lt-closed-toggle")?.textContent ?? null;
      if (part === "hold") {
        out.landscapeShown = !!document.querySelector(".ls-world");
        let mark = calls.length;
        row("g1")!.querySelector<HTMLButtonElement>('[data-act="reopen"]')!.click();
        await sleep(900);
        out.reopened = { relaunch: callsSince(mark, "relaunchSession"), setGroup: callsSince(mark, "setGroup"), listed: rows() };
        // Reopen all with two that cost a lot to resume (&lsBigResume): asked once for all of them, nothing relaunched
        // until Continue (off the landscape, what it did is said in a dialog)
        const alerts: string[] = [];
        w.alert = (m?: unknown) => void alerts.push(String(m));
        mark = calls.length;
        list()!.querySelector<HTMLButtonElement>('[data-act="reopenAll"]')!.click();
        await sleep(900);
        const dialogs = [...document.querySelectorAll<HTMLElement>(".cost-dlg")];
        const asked = { dialogs: dialogs.length, title: dialogs[0]?.querySelector("h3")?.textContent ?? null, note: dialogs[0]?.querySelector(".cost-note")?.textContent ?? null, relaunchedMeanwhile: callsSince(mark, "relaunchSession").length };
        [...(dialogs[0]?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((b) => b.textContent === "Continue")?.click();
        await sleep(1500);
        out.reopenAll = { ...asked, dialogsAfter: document.querySelectorAll(".cost-dlg").length, relaunch: callsSince(mark, "relaunchSession").map((c) => c[0]), said: alerts };
      } else if (part === "retry") {
        // the closed sessions' reads failing at first (&lsClosedReadFails=2): said, then tried again until they're read
        // (&lsGoneReadFails=2: the read of which of their folders are gone likewise); the header at a count of 2
        const err = () => document.querySelector<HTMLElement>(".update-note.bad")?.textContent ?? null;
        const reads = (fn: string) => calls.filter((c) => c.fn === fn).length;
        out.early = { rows: rows().length, error: err(), reads: reads("resumableSessions"), goneReads: reads("missingFolders") };
        await sleep(4500);
        out.later = { rows: rows(), error: err(), reads: reads("resumableSessions"), goneReads: reads("missingFolders") };
        out.head = headOf();
      } else if (part === "notes") {
        // two reads failing throughout: a note of its own for each, and one dismissed stays away through its retries
        const notes = () => [...document.querySelectorAll<HTMLElement>(".statusbar .update-note.bad .un-text")].map((x) => x.textContent ?? "");
        const reads = () => calls.filter((c) => c.fn === "resumableSessions").length;
        out.both = notes();
        document.querySelector<HTMLButtonElement>('.statusbar .update-note.bad[title*="previous sessions"] button')!.click();
        await sleep(200);
        out.dismissed = notes();
        const mark = reads();
        await sleep(4500);
        out.after = { notes: notes(), retried: reads() - mark };
      } else if (part === "many") {
        // a long list: its header on one line at a two-digit count; each row's ring a ghost's, its status in its title;
        // the header's ⋯ (Reopen all, Forget all, headed as the list); a row's right-click; Forget all's question
        out.head = headOf();
        const ring = row("o1")?.firstElementChild as HTMLElement | null;
        out.ring = ring ? { cls: ring.className, border: getComputedStyle(ring).borderTopStyle, fill: getComputedStyle(ring).backgroundColor } : null;
        out.titles = { y1: row("y1")?.title ?? null, o1: row("o1")?.title ?? null };
        const menuText = () => (document.querySelector<HTMLElement>(".mb-menu")?.innerText ?? "").split("\n").map((t) => t.trim()).filter(Boolean);
        list()!.querySelector<HTMLButtonElement>('[data-act="more"]')!.click();
        await sleep(300);
        out.more = menuText();
        esc();
        await sleep(250);
        const at = row("o1")!.getBoundingClientRect();
        row("o1")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: at.left + 20, clientY: at.top + 5 }));
        await sleep(300);
        out.rowMenu = menuText();
        esc();
        await sleep(250);
        const asked: string[] = [];
        w.confirm = (q: string) => (asked.push(q), false);
        list()!.querySelector<HTMLButtonElement>('[data-act="more"]')!.click();
        await sleep(300);
        [...document.querySelectorAll<HTMLElement>(".mb-menu [role=menuitem]")].find((b) => b.textContent?.startsWith("Forget all"))?.click();
        await sleep(300);
        out.asked = asked;
      } else {
        out.subs = Object.fromEntries(["o1", "o2", "y1"].map((id) => [id, sub(id)]));
        // s7 closed with its place kept: a loose ghost, and no running workspace loose, yet the tree has its Loose row
        out.looseRow = !!document.querySelector('.area-tree .lt-area[data-area="ungrouped"]');
        // the preview refuses relaunching a copy Nick continues, as main does
        out.relaunchTaken = await w.mb.relaunchSession("y1");
        out.acts = Object.fromEntries(["o1", "y1"].map((id) => [id, acts(id)]));
        const all = () => list()?.querySelector<HTMLButtonElement>('[data-act="reopenAll"]') ?? null;
        out.allBefore = { disabled: all()?.disabled ?? null, title: all()?.title ?? null };

        // ⌘K: the list's Reopen all, and each one it can reopen
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }));
        await sleep(300);
        const input = document.querySelector<HTMLInputElement>(".palette input");
        if (input) {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "closed session");
          input.dispatchEvent(new Event("input", { bubbles: true }));
          await sleep(200);
        }
        out.palette = [...document.querySelectorAll<HTMLElement>(".palette .row .lab")].map((r) => r.textContent ?? "").filter((t) => /closed session|Closed sessions list/.test(t));
        esc(input ?? undefined);
        await sleep(300);

        // o1's ↺ pressed twice before the first is done: one relaunch, placed in 5102 as a new workspace
        let mark = calls.length;
        const o1 = row("o1")!.querySelector<HTMLButtonElement>('[data-act="reopen"]')!;
        o1.click();
        o1.click();
        await sleep(1000);
        out.o1 = { relaunch: callsSince(mark, "relaunchSession"), setGroup: callsSince(mark, "setGroup"), inArea: inside(landscape.workspaces.o1, landscape.areas["5102"]), listed: rows() };

        // o2's ↺ (5150 has no area; &lsRelaunchFails=o2): its first relaunch fails and its second throws, each said, its
        // group never changed and it still listed; the third reopens it as a new workspace in 5150's area, formed again
        const pressO2 = async () => {
          const at = calls.length;
          row("o2")!.querySelector<HTMLButtonElement>('[data-act="reopen"]')!.click();
          await sleep(1000);
          return at;
        };
        const groupOf = (id: string) => (byId(id) ?? previous.find((x) => x.id === id))?.taskGroup ?? null;
        mark = await pressO2();
        out.o2fail = { relaunch: callsSince(mark, "relaunchSession"), setGroup: callsSince(mark, "setGroup"), group: groupOf("o2"), said: noteText(), listed: rows() };
        mark = await pressO2();
        out.o2throw = { relaunch: callsSince(mark, "relaunchSession"), group: groupOf("o2"), said: noteText(), enabled: row("o2")?.querySelector<HTMLButtonElement>('[data-act="reopen"]')?.disabled === false };
        mark = await pressO2();
        out.o2 = { relaunch: callsSince(mark, "relaunchSession"), setGroup: callsSince(mark, "setGroup"), group: groupOf("o2"), inItsArea: inside(landscape.workspaces.o2, landscape.areas["5150"]), listed: rows() };

        // only y1 left, which Nick continues: Reopen all is off, saying why
        out.allAfter = { disabled: all()?.disabled ?? null, title: all()?.title ?? null };

        // y1's ✕: forgotten, and the list goes with its last row
        mark = calls.length;
        row("y1")!.querySelector<HTMLButtonElement>('[data-act="forget"]')!.click();
        await sleep(800);
        out.forgot = { kill: callsSince(mark, "killSession"), list: !!list() };
      }
    } catch (err) {
      out.error = String(err instanceof Error ? err.stack : err);
    }
    report(`mb-landscape-closed-audit-${part}`, out);
  });

  // ?landscapeFixAudit=a|b|c|n (with ?motion=off): the S6b reviews' gesture and look fixes, worked as a person would. =c:
  // a stack's card zoomed out far (at Fit and 10% to 30%: what each part of its head takes on screen, with a ticket and
  // without), and a workspace dragged past its area's inside top, let go somewhere new and where it started. =a:
  // the hover toolbar's order; a toolbar Tidy undone with ⌘Z while the keyboard is on its button, but not from the code
  // editor; a Tidy whose Undo is refused after a drag, after a lock, and when another window's change is told before its
  // save answers (__mbRaceUpdate); a snap guide's colour and reach. =n (1024 px wide, the area tree open): the note kept
  // clear of a low selection bar and of the minimap, and the bar clear of the minimap. =b: a stack's tab pressed and let
  // go after slipping 6 px at 50% and 12 px down at 100% (brought to the front, not taken out), then dragged off the
  // header (no peek where it's let go until the pointer moves on; taken out, the note's Undo putting it back); Esc
  // cancelling a move, a resize and a tab drag; the stack's card at Fit and at 30%; ghosts' status zoomed out, and their
  // type's size on screen either side of 75%. Into <script id="mb-landscape-fix-audit-<part>">.
  if (params.has("landscapeFixAudit")) waitFor(".ls-world .ls-node", async () => {
    const part = params.get("landscapeFixAudit") || "a";
    const out: Record<string, unknown> = { part };
    try {
      await sleep(900);
      if (part !== "n" && part !== "c") await fitView();
      const ws = (key: string) => document.querySelector<HTMLElement>(`.ls-world .ls-node[data-ws="${CSS.escape(key)}"]`);
      const spacer = (el: HTMLElement) => el.querySelector<HTMLElement>(".ls-head .ls-spacer")!;
      const bareHead = (el: HTMLElement) => mid(spacer(el).getBoundingClientRect());
      const updates = (mark: number) => calls.slice(mark).filter((c) => c.fn === "landscapeUpdate").length;
      const places = () => JSON.stringify(landscape.workspaces);
      const R = (r: DOMRect) => ({ x: r.left, y: r.top, w: r.width, h: r.height });
      const meet = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      const tidyBtn = (key: string) => document.querySelector<HTMLButtonElement>(`${areaEl(key)} .ls-area-tools button[data-act="tidy"]`);
      const cmdZ = (on: Element) => on.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true }));
      const stepDrag = async (from: { x: number; y: number }, dx: number, dy: number, on: Element, during?: () => unknown, cancel = false) => {
        pressAt(from.x, from.y, on);
        for (let i = 1; i <= 6; i++) {
          moveTo(from.x + (dx * i) / 6, from.y + (dy * i) / 6);
          await sleep(16);
        }
        const seen = during?.();
        if (cancel) window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
        upAt(from.x + dx, from.y + dy);
        await sleep(800);
        return seen;
      };
      if (part === "n") {
        // the note with a low selection bar: y1 (in 5110, at the foot of the view) picked, and ⌘G's refusal said
        // zoomed out its card is pressed anywhere; its header otherwise
        const y1 = node("y1")!;
        const on = y1.querySelector<HTMLElement>(".ls-head .ls-spacer") ?? y1;
        const p = mid(on.getBoundingClientRect());
        on.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, shiftKey: true, pointerId: 3, clientX: p.x, clientY: p.y }));
        window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, button: 0, pointerId: 3, clientX: p.x, clientY: p.y }));
        await sleep(500);
        // panned (the wheel) until y1's top is at the view's foot and its left edge just left of the middle: the bar
        // sits along the bottom edge there, where a centred note would be
        for (let i = 0; i < 6; i++) {
          const v = vp().getBoundingClientRect();
          const r = node("y1")!.getBoundingClientRect();
          const dx = r.left - (v.left + v.width / 2 - 80);
          const dy = r.top - (v.bottom - 24);
          if (Math.abs(dx) < 4 && Math.abs(dy) < 4) break;
          vp().dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: v.left + v.width / 2, clientY: v.top + v.height / 2, deltaX: dx, deltaY: dy }));
          await sleep(250);
        }
        await sleep(400);
        armFocus(vp());
        key(vp(), "g", { metaKey: true });
        await sleep(500);
        const n = document.querySelector<HTMLElement>(".ls-note")?.getBoundingClientRect();
        const bar = document.querySelector<HTMLElement>(".ls-selbar")?.getBoundingClientRect();
        const mm = document.querySelector<HTMLElement>(".ls-minimap")?.getBoundingClientRect();
        out.note = { said: noteText(), note: n ? R(n) : null, bar: bar ? R(bar) : null, minimap: mm ? R(mm) : null, overBar: !!(n && bar && meet(n, bar)), overMinimap: !!(n && mm && meet(n, mm)), viewport: R(vp().getBoundingClientRect()), camera: camera() };
      } else if (part === "a") {
        await zoomOnArea("5101", 0.5);
        out.toolbar = [...document.querySelectorAll<HTMLButtonElement>(`${areaEl("5101")} .ls-area-tools button[data-act]`)].map((b) => b.dataset.act);

        // Tidy from the toolbar leaves the keyboard on its button; ⌘Z there still undoes it
        const before = places();
        let b = tidyBtn("5101")!;
        b.focus();
        b.click();
        await sleep(800);
        const tidied = places() !== before;
        const focusOnButton = document.activeElement === b;
        // ⌘Z in what reads keys itself (the code editor's undo) isn't the note's
        const editor = document.createElement("div");
        editor.className = "cm-editor";
        editor.innerHTML = '<div class="cm-content" tabindex="0"></div>';
        document.body.append(editor);
        cmdZ(editor.firstElementChild!);
        await sleep(500);
        const editorKept = places() !== before;
        editor.remove();
        b.focus();
        cmdZ(document.activeElement ?? b);
        await sleep(800);
        out.undoKey = { tidied, focusOnButton, editorKept, back: places() === before };

        // Tidy, then a drag: ⌘Z can't put the old places back over the new one, and says so
        b = tidyBtn("5101")!;
        b.click();
        await sleep(800);
        await stepDrag(bareHead(node("s1")!), 48, 40, spacer(node("s1")!));
        const dragged = places();
        cmdZ(document.body);
        await sleep(600);
        out.afterDrag = { said: noteText(), unchanged: places() === dragged };

        // Tidy, then a lock: the note's Undo is refused
        tidyBtn("5101")!.click();
        await sleep(800);
        const tidiedAgain = places();
        document.querySelector<HTMLButtonElement>(`${areaEl("5101")} .ls-area-tools button[data-act="lock"]`)!.click();
        await sleep(500);
        [...document.querySelectorAll<HTMLButtonElement>(".ls-note .ls-note-act")].find((x) => x.textContent === "Undo")?.click();
        await sleep(600);
        out.afterLock = { said: noteText(), unchanged: places() === tidiedAgain };
        document.querySelector<HTMLButtonElement>(`${areaEl("5101")} .ls-area-tools button[data-act="lock"]`)!.click();
        await sleep(400);

        // Tidy whose save is answered after another window's change (main tells every window of it, and that can come
        // first): the note's Undo is refused, judged by the revision the Tidy's save made, not the newest when it answered
        await stepDrag(bareHead(node("s8")!), 60, 50, spacer(node("s8")!));
        w.__mbRaceUpdate = true;
        tidyBtn("5101")!.click();
        await sleep(800);
        const raced = places();
        [...document.querySelectorAll<HTMLButtonElement>(".ls-note .ls-note-act")].find((x) => x.textContent === "Undo")?.click();
        await sleep(600);
        out.afterRace = { raced: !w.__mbRaceUpdate, said: noteText(), unchanged: places() === raced };

        // a guide while s8 is dragged to the api stack's left edge: a colour of its own, reaching past both
        const s8 = node("s8")!;
        const api = ws("ws:5101/api")!;
        const dx = api.getBoundingClientRect().left - s8.getBoundingClientRect().left + 2;
        out.guide = await stepDrag(bareHead(s8), dx, 24, spacer(s8), () => {
          const g = document.querySelector<HTMLElement>('.ls-guides .ls-guide[data-axis="x"]');
          if (!g) return null;
          const gr = g.getBoundingClientRect();
          const tops = [s8.getBoundingClientRect().top, api.getBoundingClientRect().top];
          const bottoms = [s8.getBoundingClientRect().bottom, api.getBoundingClientRect().bottom];
          const probe = document.createElement("div");
          probe.style.cssText = "position:absolute;width:1px;height:1px;background:var(--pane-focus)";
          document.body.append(probe);
          const focus = getComputedStyle(probe).backgroundColor;
          probe.style.background = "var(--line-strong2)";
          const border = getComputedStyle(probe).backgroundColor;
          probe.remove();
          return { colour: getComputedStyle(g).backgroundColor, focus, border, past: { top: Math.min(...tops) - gr.top, bottom: gr.bottom - Math.max(...bottoms) }, width: gr.width };
        });
        await sleep(400);
      } else if (part === "c") {
        // a stack's card zoomed out far: what each part of its head takes, on screen
        const stack = () => ws("ws:5101/api")!;
        const head = () => {
          const el = stack();
          const rect = (sel: string) => el.querySelector<HTMLElement>(sel)?.getBoundingClientRect() ?? null;
          const [card, title, more, long, short] = [rect(".ls-card")!, rect(".ls-card-title")!, rect(".ls-more"), rect(".ls-chip-long")!, rect(".ls-chip-short")!];
          const ticket = rect(".ls-card-ticket");
          const chip = long.width > 0 ? long : short;
          return {
            zoom: Math.round(zoomNow() * 100) / 100,
            card: Math.round(card.width),
            title: Math.round(title.width),
            chipInside: chip.left >= card.left - 0.5 && chip.right <= card.right + 0.5,
            long: Math.round(long.width),
            short: Math.round(short.width),
            ticket: ticket ? Math.round(ticket.width) : null,
            clearOfMore: !!more && chip.right <= more.left + 0.5,
            ticketLast: !!ticket && ticket.left >= long.right,
          };
        };
        await fitView();
        await sleep(500);
        out.fit = head();
        const plainHead = () => {
          const el = node("s1")!;
          const rect = (sel: string) => el.querySelector<HTMLElement>(sel)!.getBoundingClientRect();
          return { zoom: Math.round(zoomNow() * 100) / 100, card: Math.round(rect(".ls-card").width), title: Math.round(rect(".ls-card-title").width), ticket: Math.round(rect(".ls-card-ticket").width) };
        };
        const plain: unknown[] = [plainHead()];
        const at: Record<string, unknown> = {};
        for (const z of [0.1, 0.11, 0.12, 0.13, 0.25, 0.3]) {
          await pinchTo(z);
          await sleep(400);
          at[String(z)] = head();
          plain.push(plainHead());
        }
        out.at = at;
        out.plain = plain;
        // with no ticket on its front tab, nothing else sits under the ⋯ but the chip
        const front = stack().dataset.front!;
        const had = byId(front);
        sessions = sessions.map((x): SessionInfo => (x.id === front ? { ...x, ticketId: null } : x));
        sessionsChanged();
        await sleep(500);
        const none: Record<string, unknown> = {};
        for (const z of [0.25, 0.12]) {
          await pinchTo(z);
          await sleep(400);
          none[String(z)] = head();
        }
        out.noTicket = none;
        sessions = sessions.map((x) => (x.id === front && had ? had : x));
        sessionsChanged();
        await sleep(400);

        // dragged past the inside top of its area, a workspace stays inside it while it's dragged and lands where it was
        // held; dragged past it again from there, the drop leaves it where it started, and it's let go at once
        await zoomOnArea("5101", 0.5);
        tidyBtn("5101")!.click();
        await sleep(800);
        const insideTop = () => document.querySelector<HTMLElement>(areaEl("5101"))!.getBoundingClientRect().top + AREA_HEADER * zoomNow();
        const [high] = [ws("ws:5101/api")!, node("s8")!].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
        const pastTop = async (el: HTMLElement, dy: number) => {
          const from = bareHead(el);
          const startTop = el.getBoundingClientRect().top;
          const mark = calls.length;
          pressAt(from.x, from.y, spacer(el));
          for (let i = 1; i <= 6; i++) {
            moveTo(from.x, from.y + (dy * i) / 6);
            await sleep(16);
          }
          const heldTop = el.getBoundingClientRect().top;
          const bound = insideTop();
          upAt(from.x, from.y + dy);
          await sleep(60);
          const releasedSoon = !el.classList.contains("dragging");
          const topSoon = el.getBoundingClientRect().top;
          await sleep(1800);
          return { startTop, heldTop, bound, releasedSoon, topSoon, topLater: el.getBoundingClientRect().top, updates: updates(mark) };
        };
        const far = await pastTop(high, insideTop() - high.getBoundingClientRect().top - 15);
        out.pastTop = { far, back: await pastTop(high, -15) };
      } else {
        await zoomOnArea("5101", 0.5);
        const stack = () => ws("ws:5101/api")!;
        const tabOf = (id: string) => stack().querySelector<HTMLElement>(`.ls-tab[data-sid="${CSS.escape(id)}"]`)!;
        const other = stack().dataset.front === "s2" ? "s3" : "s2";
        const tabsNow = () => [...stack().querySelectorAll<HTMLElement>(".ls-tab[data-sid]")].map((t) => t.dataset.sid);
        out.tabsBefore = tabsNow();

        // pressed and let go after slipping, never dragged out: brought to the front, though the browser's click lands on
        // the header the press and the release share rather than the tab, and it stays in its stack; 6 px at 50%, then
        // 12 px down at 100%
        let mark = calls.length;
        const slip = async (dx: number, dy: number) => {
          const id = stack().dataset.front === "s2" ? "s3" : "s2";
          const p = mid(tabOf(id).getBoundingClientRect());
          pressAt(p.x, p.y, tabOf(id));
          moveTo(p.x + dx / 2, p.y + dy / 2);
          await sleep(16);
          moveTo(p.x + dx, p.y + dy);
          await sleep(16);
          upAt(p.x + dx, p.y + dy);
          stack().querySelector(".ls-head")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: p.x + dx, clientY: p.y + dy }));
          await sleep(700);
          return { id, front: stack().dataset.front ?? null };
        };
        const half = await slip(6, 1);
        const up = await slip(0, -9);
        const down = await slip(0, 9);
        await zoomOnArea("5101", 1);
        const full = await slip(0, 12);
        await zoomOnArea("5101", 0.5);
        out.slip = { setGroup: callsSince(mark, "setGroup"), tabs: tabsNow(), half, up, down, full, other };
        let t0: { x: number; y: number };

        // dragged off the header: taken out, said with Undo, which puts it back in the stack
        mark = calls.length;
        t0 = mid(tabOf("s3").getBoundingClientRect());
        await stepDrag(t0, 30, 120, tabOf("s3"));
        const said = noteText();
        const outGroups = callsSince(mark, "setGroup");
        // the pointer resting where it let go: no peek opens over what it left there (the hover rest is 600 ms); once it
        // moves on, a peek opens as ever
        const drop = { x: t0.x + 30, y: t0.y + 120 };
        const under = document.elementFromPoint(drop.x, drop.y) ?? vp();
        under.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, cancelable: true, pointerId: PID, clientX: drop.x, clientY: drop.y }));
        await sleep(900);
        const peekAtDrop = !!document.querySelector(".ls-peek");
        under.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, cancelable: true, pointerId: PID, clientX: drop.x + 20, clientY: drop.y }));
        await sleep(900);
        const peekMovedOn = !!document.querySelector(".ls-peek");
        under.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, cancelable: true, pointerId: PID, clientX: drop.x + 20, clientY: drop.y }));
        vp().dispatchEvent(new PointerEvent("pointerleave", { bubbles: false, cancelable: true, pointerId: PID }));
        await sleep(200);
        const undo = [...document.querySelectorAll<HTMLButtonElement>(".ls-note .ls-note-act")].find((x) => x.textContent === "Undo");
        mark = calls.length;
        undo?.click();
        await sleep(900);
        out.dragOut = { peekAtDrop, peekMovedOn, said, groups: outGroups, undo: !!undo, back: callsSince(mark, "setGroup"), tabs: [...stack().querySelectorAll<HTMLElement>(".ls-tab[data-sid]")].map((t) => t.dataset.sid), s3: landscape.workspaces.s3 ?? null };

        // Esc during a move, a resize and a tab drag: nothing saved, nothing moved, nothing left drawn
        const left = () => ({ guides: document.querySelectorAll(".ls-guides .ls-guide").length, box: !document.querySelector<HTMLElement>(".ls-sizebox")?.hidden, dragging: document.querySelectorAll(".ls-world .dragging").length });
        mark = calls.length;
        let was = places();
        await stepDrag(bareHead(node("s1")!), 60, 30, spacer(node("s1")!), undefined, true);
        const move = { updates: updates(mark), same: places() === was, ...left() };
        mark = calls.length;
        was = places();
        const rz = node("s1")!.querySelector<HTMLElement>(".ls-rz.r")!;
        await stepDrag(mid(rz.getBoundingClientRect()), 80, 0, rz, undefined, true);
        const resize = { updates: updates(mark), same: places() === was, resized: callsSince(mark, "sessionResize").length, ...left() };
        mark = calls.length;
        t0 = mid(tabOf("s3").getBoundingClientRect());
        await stepDrag(t0, 30, 120, tabOf("s3"), undefined, true);
        const tab = { updates: updates(mark), setGroup: callsSince(mark, "setGroup"), ...left() };
        out.esc = { move, resize, tab };

        // ghosts' status kept whole before ticket · branch zoomed out, and their type 11 px on screen either side of 75%
        const ghosts = () => [...document.querySelectorAll<HTMLElement>(".ls-world .ls-ghost")].filter((g) => getComputedStyle(g).display !== "none");
        const status: Record<string, { text: string; whole: boolean }[]> = {};
        for (const z of [0.1, 0.15]) {
          await pinchTo(z);
          await sleep(400);
          status[String(z)] = ghosts().map((g) => {
            const s = g.querySelector<HTMLElement>(".lg-status")!;
            const foot = g.querySelector<HTMLElement>(".lg-foot")!;
            // whole: not cut, or cut only because it alone is wider than its foot
            return { text: s.textContent ?? "", whole: s.scrollWidth <= s.clientWidth + 1 || s.getBoundingClientRect().width >= foot.getBoundingClientRect().width - 1 };
          });
        }
        // its layers at 40%, at least 3 px apart on screen (box-shadow offsets, read with the zoom)
        await pinchTo(0.4);
        await sleep(400);
        out.layers = { zoom: zoomNow(), shadow: getComputedStyle(stack()).boxShadow };
        // zoomed out to cards (Fit, then 30%), the stack's card: a stack · N chip in its title row, and its other tabs'
        // names on a row of their own, one waiting on you counted first; how much of the names shows on screen
        const back = stack().dataset.front === "s2" ? "s3" : "s2";
        const backWas = byId(back);
        sessions = sessions.map((x): SessionInfo => (x.id === back ? { ...x, status: "waiting", waitingReason: "Claude needs your permission to use Bash", waitingSince: Date.now() } : x));
        sessionsChanged();
        const card = () => {
          const el = stack();
          const row = el.querySelector<HTMLElement>(".ls-card-tabs");
          const rr = row?.getBoundingClientRect();
          const names = [...(row?.querySelectorAll<HTMLElement>(".ls-card-tab") ?? [])];
          const seen = rr ? names.reduce((n, x) => n + Math.max(0, Math.min(x.getBoundingClientRect().right, rr.right) - Math.max(x.getBoundingClientRect().left, rr.left)), 0) : 0;
          return {
            zoom: Math.round(zoomNow() * 100) / 100,
            chip: el.querySelector(".ls-card-head .ls-chip-long")?.textContent ?? null,
            first: row?.firstElementChild?.className ?? null,
            needs: row?.querySelector(".ls-card-needs")?.textContent ?? null,
            names: names.map((x) => x.textContent ?? ""),
            title: el.querySelector(".ls-card-title")?.textContent ?? null,
            seen: Math.round(seen),
          };
        };
        await fitView();
        await sleep(500);
        const fit = card();
        await pinchTo(0.3);
        await sleep(500);
        out.chip = { fit, at30: card() };
        sessions = sessions.map((x) => (x.id === back && backWas ? backWas : x));
        sessionsChanged();
        const sizes: Record<string, number> = {};
        for (const z of [0.9, 0.76, 0.74, 0.6]) {
          await pinchTo(z);
          await sleep(400);
          const g = ghosts().find((x) => x.dataset.front === "g1") ?? ghosts()[0];
          const line = g?.querySelector<HTMLElement>(".lg-line");
          sizes[String(Math.round(zoomNow() * 100) / 100)] = line ? Math.round(parseFloat(getComputedStyle(line).fontSize) * zoomNow() * 100) / 100 : NaN;
        }
        out.ghosts = { status, sizes };
      }
    } catch (err) {
      out.error = String(err instanceof Error ? err.stack : err);
    }
    report(`mb-landscape-fix-audit-${part}`, out);
  });

  // ?landscapeReviewAudit (with ?motion=off&lsPersist): the S5 review's fixes, worked as a person would, in two pages
  // so each stays well inside the preview's minute. =a: placed and docked windows and a card kept through a real
  // reload; a Chat window viewing its room only while it's on screen in the live band; a mention notification going to
  // its room's area and Chat; the rail and keys refusing what the selection's menu has off; the menus of a taken-over
  // session, a terminal and a teammate's; a docked Chat placed in an area that isn't a room's. =b: Size L picked from a
  // menu opened before the area was locked; a mention refused outside the artifact's area; zoomed out to cards, the
  // windows' and card's heads at screen size; sharing an area as a room offering its artifacts once, its card following
  // them, and gone once the room is left from the Team view's list, which the Connected line opens; the Follow
  // indicator on a room's area only. Into <script id="mb-landscape-review-audit-a"> (or -b).
  if (params.has("landscapeReviewAudit")) waitFor(".ls-world .ls-node", async () => {
    const part = params.get("landscapeReviewAudit") === "b" ? "b" : "a";
    const PHASE = "mb.preview.reviewAudit";
    const was = JSON.parse(sessionStorage.getItem(PHASE) ?? "null") as { shot: unknown; stored: string } | null;
    const out: Record<string, unknown> = {};
    const shot = () => ({
      placed: Object.fromEntries([...document.querySelectorAll<HTMLElement>(".ls-world .ls-window")].map((x) => [x.dataset.win, styleRect(x)])),
      docked: [...document.querySelectorAll<HTMLElement>(".ls-dock .ls-window")].map((x) => x.dataset.win),
      cards: Object.fromEntries([...document.querySelectorAll<HTMLElement>(".ls-world .ls-acard")].map((x) => [x.dataset.card, styleRect(x)])),
    });
    const kept = () => JSON.stringify({ tools: landscape.tools, cards: landscape.cards });
    const artRow = (name: string, win = placedWin("artifacts")) => [...(win?.querySelectorAll<HTMLElement>(".art-row") ?? [])].find((r) => r.querySelector(".art-name")?.textContent === name) ?? null;
    const viewed = () => (calls.filter((c) => c.fn === "teamChatViewing").at(-1)?.args[0] as string[] | undefined) ?? [];
    const reads = (room: string, from: number) => calls.slice(from).filter((c) => c.fn === "teamChatRead" && c.args[0] === room).length;
    const says = async (room: string, text: string) => {
      (chats[room] ??= []).push(chatEntry({ kind: "message", author: NICK, at: Date.now(), text, mentions: [ME] }));
      chatChanged(room);
      await sleep(700);
    };
    const chatWin = (key: string) => [...document.querySelectorAll<HTMLElement>('.ls-world .ls-window[data-tool="chat"]')].find((x) => landscape.tools[x.dataset.win!]?.area === key) ?? null;
    const partly = (el: Element | null) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const v = vp().getBoundingClientRect();
      return r.right > v.left && r.left < v.right && r.bottom > v.top && r.top < v.bottom;
    };
    const band = () => ["live", "readonly", "cards"].find((b) => vp().classList.contains(`ls-band-${b}`)) ?? null;
    const goArea = async (key: string) => {
      document.querySelector<HTMLElement>(`.area-tree .lt-area[data-area="${CSS.escape(key)}"] .lt-head`)!.click();
      await sleep(900);
    };
    const areaMore = async (key: string, pickText: string) => {
      document.querySelector<HTMLElement>(`${areaEl(key)} .ls-ah .ls-ah-more`)!.click();
      await sleep(300);
      await ctxPick(pickText);
    };
    const closeModal = async () => {
      [...document.querySelectorAll<HTMLButtonElement>(".modal button")].find((b) => b.textContent === "Close")?.click();
      await sleep(400);
    };
    const toolCount = () => Object.keys(landscape.tools).length;
    try {
      await sleep(900);
      if (part === "a" && !was) {
        // placed (Files beside s1), docked (Search) and a card (5102's link), then the page reloaded
        await pick("s1");
        rail("Files")!.click();
        await sleep(800);
        rail("Search")!.click();
        await sleep(800);
        placedWin("search")!.querySelector<HTMLElement>('[aria-label="Dock it"]')!.click();
        await sleep(500);
        await at100("5102");
        headBtn("5102", "Artifacts")!.click();
        await sleep(800);
        artRow("React profiler docs")!.querySelector<HTMLElement>('[data-action="place"]')!.click();
        await sleep(800);
        sessionStorage.setItem(PHASE, JSON.stringify({ shot: shot(), stored: kept() }));
        location.reload();
        return;
      }
      if (part === "a") {
        sessionStorage.removeItem(PHASE);
        const area5110Was = { ...landscape.areas["5110"] };
        out.reload = { before: was!.shot, after: shot(), storedSame: kept() === was!.stored, card: document.querySelector(".ls-world .ls-acard .acard-name")?.textContent ?? null };

        // a Chat window views its room, and reads it, only on screen in the live band
        window.dispatchEvent(new Event("focus"));
        await at100("5101");
        let mark = calls.length;
        [...document.querySelectorAll<HTMLElement>(`${areaEl("5101")} .ls-ah button`)].find((b) => b.textContent?.startsWith("Chat"))!.click();
        await sleep(1000);
        await says(ROOM_5101, "@You on screen");
        const shown = { band: band(), partly: partly(chatWin("5101")), viewing: viewed().includes(ROOM_5101), reads: reads(ROOM_5101, mark) };
        await at100("5102");
        mark = calls.length;
        await says(ROOM_5101, "@You off screen");
        const offScreen = { band: band(), partly: partly(chatWin("5101")), viewing: viewed().includes(ROOM_5101), reads: reads(ROOM_5101, mark) };
        await fitView();
        await pinchTo(0.2);
        await sleep(500);
        mark = calls.length;
        await says(ROOM_5101, "@You zoomed out");
        const zoomedOut = { band: band(), partly: partly(chatWin("5101")), viewing: viewed().includes(ROOM_5101), reads: reads(ROOM_5101, mark) };
        out.chat = { shown, offScreen, zoomedOut };

        // a clicked mention notification: its room's area, with its Chat
        const chatsBefore = Object.values(landscape.tools).filter((t) => t.tool === "chat" && t.area === "5110").length;
        emit("onTeamChatOpen", ROOM_5110);
        await sleep(1500);
        const area5110 = document.querySelector(areaEl("5110"));
        out.notified = { before: chatsBefore, after: Object.values(landscape.tools).filter((t) => t.tool === "chat" && t.area === "5110").length, windowShown: partly(chatWin("5110")), areaShown: partly(area5110), tab: document.querySelector(".tab.on")?.textContent?.trim() ?? null };

        // the rail and keys against the selection's menu: an exited session (only Search), a teammate's (none)
        const KEYS = [["files", "E", { metaKey: true, shiftKey: true }], ["changes", "G", { ctrlKey: true, shiftKey: true }], ["search", "F", { metaKey: true, shiftKey: true }], ["run", "D", { metaKey: true, shiftKey: true }], ["files", "b", { metaKey: true }]] as const;
        const LABEL: Record<string, string> = { files: "Files", changes: "Changes", search: "Search", run: "Run & debug" };
        dockedWin("search")?.querySelector<HTMLElement>('[aria-label="Close Search"]')?.click();
        await sleep(400);
        const gate = async (id: string) => {
          await fitView();
          await pick(id);
          const menu = (await rightClick(node(id)!)) ?? [];
          const rows: Record<string, unknown> = {};
          for (const [tool, k, mods] of KEYS) {
            const was = kept();
            await keyDown(k, mods);
            const opened = kept() !== was;
            // what it opened, closed again by its key, so the next starts from the same place
            if (opened) await keyDown(k, mods);
            rows[`${tool}${k === "b" ? " ⌘B" : ""}`] = { menuOn: menu.some((r) => r.startsWith(LABEL[tool]) && !r.includes("(off)")), keyOpened: opened, railOff: rail(LABEL[tool])!.getAttribute("aria-disabled") === "true" };
          }
          const before = toolCount();
          rail("Files")!.click();
          await sleep(500);
          return { rows, railClickOpened: toolCount() !== before, said: noteText() };
        };
        out.gate = { s6: await gate("s6"), teammate: await gate(NICK_PANE) };

        // the menus of the real wiring: a session a teammate took over, a terminal, a teammate's
        out.menus = { y1: await rightClick(node("y1")!), s4: await rightClick(node("s4")!), teammate: await rightClick(node(NICK_PANE)!) };

        // a docked Chat placed while an area that isn't a room's is selected: refused, still docked
        const dockedChat = Object.entries(landscape.tools).find(([, t]) => t.tool === "chat" && t.area === "5110")!;
        chatWin("5110")!.querySelector<HTMLElement>('[aria-label="Dock it"]')!.click();
        await sleep(500);
        await pick("s5");
        dockedWin("chat")!.querySelector<HTMLElement>('[aria-label="Place it on the landscape"]')!.click();
        await sleep(500);
        out.dockedChat = { stillDocked: landscape.tools[dockedChat[0]]?.docked === true, said: noteText() };
        dockedWin("chat")!.querySelector<HTMLElement>('[aria-label="Close Chat"]')!.click();
        await sleep(400);

        // a mention for a room whose area is collapsed, a workspace elsewhere selected: the area opened, its Chat in it
        const chats = (area: string | null) => Object.values(landscape.tools).filter((t) => t.tool === "chat" && (area === null ? t.docked : t.area === area));
        await api.landscapeUpdate({ areas: { "5110": { collapsed: true } } });
        await sleep(400);
        await fitView();
        await pick("s1");
        emit("onTeamChatOpen", ROOM_5110);
        await sleep(1500);
        const collapsed = { open: !landscape.areas["5110"]?.collapsed, placed: chats("5110").length, docked: chats(null).length };
        // locked with no room (its size from before, just its workspaces): the docked Chat, the one already docked,
        // with the selection moved into the room's area
        const placedIds = Object.entries(landscape.tools).filter(([, t]) => t.tool === "chat").map(([id]) => id);
        await api.landscapeUpdate({ areas: { "5110": { ...area5110Was, collapsed: false, locked: true } }, tools: { ...Object.fromEntries(placedIds.map((id) => [id, null])), wd: { tool: "chat", docked: true } } });
        await sleep(400);
        await pick("s1");
        emit("onTeamChatOpen", ROOM_5110);
        await sleep(1200);
        const locked = { placed: chats("5110").length, docked: chats(null).length, scope: scopeOf(dockedWin("chat")) };
        out.hiddenRoom = { collapsed, locked };
        await api.landscapeUpdate({ areas: { "5110": { locked: false } }, tools: { wd: null } });
        await sleep(300);
      } else {
        // Files beside s1, and a card of 5102's link
        let mark = calls.length;
        await pick("s1");
        rail("Files")!.click();
        await sleep(800);
        await at100("5102");
        headBtn("5102", "Artifacts")!.click();
        await sleep(800);
        artRow("React profiler docs")!.querySelector<HTMLElement>('[data-action="place"]')!.click();
        await sleep(800);

        // Files docked, s5 selected, then Files from s1's ⋯: the docked one follows s1 there, and none opens beside it
        placedWin("files")!.querySelector<HTMLElement>('[aria-label="Dock it"]')!.click();
        await sleep(500);
        await pick("s5");
        const toolsWere = toolCount();
        node("s1")!.querySelector<HTMLElement>(".ls-more")!.click();
        await sleep(300);
        await ctxPick("Files");
        out.dockedFollows = { opened: toolCount() - toolsWere, docked: !!dockedWin("files"), placed: !!placedWin("files"), scope: scopeOf(dockedWin("files")) };
        // placed again, beside s1, for the cards band below
        dockedWin("files")!.querySelector<HTMLElement>('[aria-label="Place it on the landscape"]')!.click();
        await sleep(800);

        // Size L from s1's menu, opened before 5101 was locked: refused as the area is when it's picked
        await at100("5101");
        const sizesWere = JSON.stringify({ w: landscape.workspaces, s: landscape.stacks });
        node("s1")!.querySelector<HTMLElement>(".ls-head .ls-more")!.click();
        await sleep(300);
        await api.landscapeUpdate({ areas: { "5101": { locked: true } } });
        await sleep(400);
        const menuOpen = !!document.querySelector(".mb-ctx");
        await ctxPick("Size L");
        out.staleMenu = { menuOpen, unchanged: JSON.stringify({ w: landscape.workspaces, s: landscape.stacks }) === sizesWere, said: noteText() };
        await api.landscapeUpdate({ areas: { "5101": { locked: false } } });
        await sleep(400);

        // a mention from 5102's Artifacts with s1 (in 5101) selected: refused; with s5 (in 5102): typed into s5
        await at100("5102");
        await pick("s1");
        mark = calls.length;
        artRow("React profiler docs")!.querySelector<HTMLElement>('[data-action="mention"]')!.click();
        await sleep(400);
        const refused = { writes: calls.slice(mark).filter((c) => c.fn === "sessionWrite").length, said: noteText() };
        await pick("s5");
        mark = calls.length;
        artRow("React profiler docs")!.querySelector<HTMLElement>('[data-action="mention"]')!.click();
        await sleep(400);
        out.mention = { refused, typed: calls.slice(mark).filter((c) => c.fn === "sessionWrite").map((c) => [c.args[0], String(c.args[1]).replace(/artifact:\w+/, "artifact:…")]) };

        // zoomed out to cards: each window's head and the card's, at screen size, kept so as the camera moves
        await fitView();
        await pinchTo(0.13);
        await sleep(600);
        const heads = () =>
          [...document.querySelectorAll<HTMLElement>(".ls-world .ls-window.compact")].map((x) => {
            const r = x.getBoundingClientRect();
            const t = x.querySelector<HTMLElement>(".ls-win-t")!;
            return { tool: x.dataset.tool, w: Math.round(r.width), h: Math.round(r.height), name: t.textContent, nameH: Math.round(t.getBoundingClientRect().height), scope: x.querySelector(".ls-win-scope")?.textContent ?? null, inv: Number(x.style.getPropertyValue("--ls-inv")) };
          });
        const cardFace = () => {
          const c = document.querySelector<HTMLElement>(".ls-world .ls-acard");
          const r = c?.getBoundingClientRect();
          return c ? { w: Math.round(r!.width), h: Math.round(r!.height), name: c.querySelector(".acard-name")?.textContent ?? null, kind: c.querySelector<HTMLElement>(".acard-kind")?.offsetHeight ? c.querySelector(".acard-kind")!.textContent : null, nameH: Math.round(c.querySelector(".acard-name")!.getBoundingClientRect().height), inv: Number(c.style.getPropertyValue("--ls-inv")) } : null;
        };
        const drawn = [...document.querySelectorAll<HTMLElement>(".ls-world .ls-window.compact, .ls-world .ls-acard")].map((x) => x.getBoundingClientRect());
        const apart = drawn.every((a, i) => drawn.every((b, j) => i === j || a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top));
        const at13 = { zoom: zoomNow(), band: band(), windows: heads(), card: cardFace(), apart };
        await pinchTo(0.16);
        await sleep(300);
        out.cards = { at13, at16: { zoom: zoomNow(), windows: heads().map((h) => h.inv), card: cardFace()?.inv ?? null } };

        // 5102 shared as a room: its artifacts offered, the card moving to the room's copy; an Invite later offers none
        const cardId = Object.keys(landscape.cards)[0];
        const cardWas = { ...landscape.cards[cardId] };
        await at100("5102");
        await areaMore("5102", "Share as a team room…");
        await sleep(900);
        const offer = document.querySelector<HTMLElement>(".modal .art-share-offer");
        const offered = offer?.querySelector("button")?.textContent ?? null;
        offer?.querySelector<HTMLElement>("button")?.click();
        await sleep(1200);
        const roomId = team.rooms.find((r) => r.groupKey === "5102")?.id ?? null;
        const cardNow = landscape.cards[cardId];
        const shared = { offered, said: document.querySelector(".modal .art-share-offer")?.textContent ?? null, shelfWas: cardWas.shelf, shelf: cardNow?.shelf ?? null, room: roomId, newId: cardNow?.artifact !== cardWas.artifact, inRoom: !!roomId && !!artifactRooms[roomId]?.items.some((a) => a.id === cardNow?.artifact), name: document.querySelector(`.ls-acard[data-card="${cardId}"] .acard-name`)?.textContent ?? null };
        await closeModal();
        await areaMore("5102", "Invite a teammate…");
        await sleep(900);
        const invite = { code: !!document.querySelector(".modal .team-code"), offer: !!document.querySelector(".modal .art-share-offer") };
        await closeModal();
        out.share = { shared, invite };

        // the Connected line: the Team view's room list in the side bar; the new room left from it, its card gone
        document.querySelector<HTMLElement>(".lt-connected .connected-line")!.click();
        await sleep(600);
        const list = { title: document.querySelector(".side-title")?.textContent ?? null, rooms: [...document.querySelectorAll(".sidebar .room-list .room-card .room-name")].map((n) => n.textContent) };
        const card = [...document.querySelectorAll<HTMLElement>(".sidebar .room-list .room-card")].find((c) => c.querySelector(".room-name")?.textContent === "#5102 Pathways quick view freezes" || c.querySelector(".room-name")?.textContent?.startsWith("#5102"));
        const leaveRows = card ? await (async () => {
          card.querySelector(".room-head")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, ...at(card.querySelector(".room-head")!, 0.5, 0.3) }));
          await sleep(300);
          const rows = ctxRows();
          await ctxPick("Leave room…");
          await sleep(300);
          [...document.querySelectorAll<HTMLButtonElement>(".modal button")].find((b) => b.textContent === "Leave room")?.click();
          await sleep(1200);
          await closeModal();
          return rows;
        })() : null;
        const left = { leaveRows, roomGone: !team.rooms.some((r) => r.groupKey === "5102"), card: document.querySelector(`.ls-acard[data-card="${cardId}"] .acard-name`)?.textContent ?? null, why: document.querySelector(`.ls-acard[data-card="${cardId}"] .acard-meta`)?.textContent ?? null };
        document.querySelector<HTMLElement>(".side-head .side-back")?.click();
        await sleep(400);
        out.team = { list, left, backToTree: !!document.querySelector(".sidebar .area-tree") };

        // following a teammate: offered on a room's area only, and said once, with Stop, in the status bar
        await at100("5101");
        const follow = [...document.querySelectorAll<HTMLElement>(`${areaEl("5101")} .ls-ah .team-follow button`)].find((b) => b.textContent?.includes("Follow")) ?? null;
        follow?.click();
        await sleep(600);
        const said = () => [...document.querySelectorAll(".statusbar .team-follow.on")].map((x) => x.textContent?.replace(/Stop$/, "").trim());
        const following = {
          offered: !!follow,
          on5102: [...document.querySelectorAll(`${areaEl("5102")} .ls-ah .team-follow.on`)].map((x) => x.textContent?.replace(/Stop$/, "").trim()),
          on5101: document.querySelectorAll(`${areaEl("5101")} .ls-ah .team-follow.on`).length,
          buttons5101: document.querySelectorAll(`${areaEl("5101")} .ls-ah .team-follow button`).length,
          statusBar: said(),
        };
        document.querySelector<HTMLElement>(".statusbar .team-follow.on button")?.click();
        await sleep(400);
        out.follow = { ...following, stopped: { statusBar: said(), offered5101: !!document.querySelector(`${areaEl("5101")} .ls-ah .team-follow button`) } };
      }
    } catch (err) {
      out.error = String(err instanceof Error ? err.stack : err);
    }
    report(`mb-landscape-review-audit-${part}`, out);
  });

  // ?landscapeReadOnlyAudit (with ?areaReadOnly=5102): an area's shelf a newer Mockingbird wrote, in its Artifacts
  // window: why it can't be changed, and nothing offering to. Into <script id="mb-landscape-read-only-audit">.
  if (params.has("landscapeReadOnlyAudit")) waitFor(".ls-world .ls-node", async () => {
    const out: Record<string, unknown> = {};
    try {
      await sleep(900);
      await at100("5102");
      headBtn("5102", "Artifacts")!.click();
      await sleep(800);
      const win = placedWin("artifacts")!;
      const add = [...win.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "+ Add")!;
      const row = win.querySelector<HTMLElement>(".art-row")!;
      out.shelf = {
        add: { disabled: add.disabled, title: add.title },
        said: [...win.querySelectorAll(".art-line.warn")].map((l) => l.textContent),
        rowMenu: await rightClick(row),
        rows: artRows(win).length,
      };
      const noteRow = () => [...placedWin("artifacts")!.querySelectorAll<HTMLElement>(".art-row")].find((r) => r.querySelector(".art-name")?.textContent === "Tag list profile")!;
      // a viewer: no Edit, and its ⋯ menu's Rename and Remove shown off
      const viewer = async () => {
        const acts = document.querySelector<HTMLElement>(".modal.art-dlg .art-head-acts")!;
        const edit = [...acts.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "Edit");
        acts.querySelector<HTMLElement>(".art-more")!.click();
        await sleep(300);
        const more = [...document.querySelectorAll<HTMLButtonElement>(".mb-menu [role=menuitem]")].map((b) => `${b.textContent}${b.disabled ? " (off)" : ""}`);
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await sleep(200);
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await sleep(400);
        return { edit: edit ? { disabled: edit.disabled, title: edit.title } : null, more, closed: !document.querySelector(".modal.art-dlg") };
      };
      noteRow().click();
      await sleep(700);
      out.windowViewer = await viewer();
      // a card of the note: its menu, and its viewer
      noteRow().querySelector<HTMLElement>('[data-action="place"]')!.click();
      await sleep(800);
      const card = document.querySelector<HTMLElement>(".ls-world .ls-acard .acard")!;
      out.card = { menu: await rightClick(card) };
      card.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
      await sleep(700);
      out.cardViewer = await viewer();
      // a file dropped on the window: refused before anything is sent to main
      const mark = calls.length;
      const dt = new DataTransfer();
      dt.items.add(new File(["dropped"], "dropped.txt", { type: "text/plain" }));
      const into = placedWin("artifacts")!.querySelector<HTMLElement>(".art-window")!;
      for (const type of ["dragenter", "dragover", "drop"]) into.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
      await sleep(500);
      out.drop = { sent: calls.slice(mark).filter((c) => /^artifactsAdd/.test(c.fn)).map((c) => c.fn), said: [...placedWin("artifacts")!.querySelectorAll(".err, .art-line.err")].map((l) => l.textContent), rows: artRows(placedWin("artifacts")).length };
    } catch (err) {
      out.error = String(err instanceof Error ? err.stack : err);
    }
    report("mb-landscape-read-only-audit", out);
  });
}
// ?landscapePerf (with ?landscapeMany=<n>): frame times while the landscape is panned and pinch-zoomed at 100%, 60%
// and 30% (=<zoom>,… picks others), then zoomed from 100% to 25% and back in one sweep, into
// <script id="mb-landscape-perf">. Each step is one wheel event a frame, as a trackpad sends them. For every frame it
// keeps the interval since the last (rAF to rAF: what a person sees drop) and its main-thread time (from rAF to the
// first task after the frame, so past style, layout and paint), and with each zoom what was attached meanwhile, whether
// a selection bar rode along (?lsSelect) and how busy the main thread is at rest there. Frames of 50 ms and more (long
// animation frames) are counted too, from the page's load on.
if (params.has("landscapePerf")) {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const zooms = (params.get("landscapePerf") || "1,0.6,0.3").split(",").map(Number).filter((z) => z > 0);
  const vp = () => document.querySelector<HTMLElement>(".ls-viewport")!;
  const zoomNow = () => Number(/scale\(([-\d.e]+)\)/.exec(document.querySelector<HTMLElement>(".ls-world")?.style.transform ?? "")?.[1] ?? NaN);
  const frame = () => new Promise<number>((r) => requestAnimationFrame(r));
  const after = () => new Promise<number>((r) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => r(performance.now());
    ch.port2.postMessage(null);
  });
  const wheelAt = (init: WheelEventInit) => {
    const r = vp().getBoundingClientRect();
    vp().dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, ...init }));
  };
  // a pinch (Electron's ctrl-wheel, 0.01 a pixel) about the viewport's centre, at most ×2 an event as the camera takes it
  const pinchBy = (factor: number) => wheelAt({ deltaY: Math.max(-69, Math.min(69, -Math.log(factor) / 0.01)), ctrlKey: true });
  const zoomTo = async (z: number) => {
    for (let i = 0; i < 40 && Math.abs(zoomNow() - z) > 1e-4; i++) {
      pinchBy(z / zoomNow());
      await frame();
    }
  };
  const round = (n: number) => Math.round(n * 10) / 10;
  const stats = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    const q = (p: number) => round(s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? NaN);
    return { frames: s.length, mean: round(s.reduce((a, b) => a + b, 0) / (s.length || 1)), p50: q(0.5), p95: q(0.95), max: round(s[s.length - 1] ?? NaN), over25: s.filter((x) => x > 25).length };
  };
  const longFrames: { start: number; duration: number }[] = [];
  if (PerformanceObserver.supportedEntryTypes?.includes("long-animation-frame"))
    new PerformanceObserver((list) => longFrames.push(...list.getEntries().map((e) => ({ start: e.startTime, duration: e.duration })))).observe({ type: "long-animation-frame", buffered: true });
  /** `steps` frames, `step(i)` dispatched at the start of each. */
  const run = async (steps: number, step: (i: number) => void) => {
    const intervals: number[] = [];
    const busy: number[] = [];
    const from = performance.now();
    let last = await frame();
    for (let i = 0; i < steps; i++) {
      const t = await frame();
      intervals.push(t - last);
      last = t;
      step(i);
      busy.push((await after()) - t);
    }
    const long = longFrames.filter((f) => f.start >= from);
    return { interval: stats(intervals), main: stats(busy), longFrames: long.length, longMs: round(long.reduce((a, f) => a + f.duration, 0)) };
  };
  /**
   * The landscape at rest for `ms`, the working agents' spinners still redrawing: each frame's main-thread time
   * (rAF to the first task after it, so the terminals' drawing in it), the terminals' renders a second, and the
   * page's size. Output is parsed into every cached terminal either way, attached or not, so it isn't counted.
   */
  const rest = async (ms: number) => {
    let renders = 0;
    const subs = [...((w.__mbTerms as Map<string, { term: import("@xterm/xterm").Terminal }> | undefined)?.values() ?? [])].map((e) => e.term.onRender(() => renders++));
    const busy: number[] = [];
    const from = performance.now();
    for (let t = await frame(); t - from < ms; t = await frame()) busy.push((await after()) - t);
    const took = performance.now() - from;
    subs.forEach((s) => s.dispose());
    const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
    return { frameMs: stats(busy), mainMsPerS: round((busy.reduce((a, b) => a + b, 0) * 1000) / took), rendersPerS: round((renders * 1000) / took), domNodes: document.getElementsByTagName("*").length, heapMB: heap ? round(heap / 1048576) : null };
  };
  const attached = () => ({
    xterms: document.querySelectorAll(".ls-world .xterm").length,
    panes: document.querySelectorAll(".ls-world .pane").length,
    webgl: [...document.querySelectorAll(".ls-world .xterm-screen")].filter((s) => s.querySelector("canvas")).length,
    nodes: document.querySelectorAll(".ls-world .ls-node").length,
  });
  waitFor(".ls-world .ls-node", async () => {
    const out: Record<string, unknown> = { size: `${vp().clientWidth}×${vp().clientHeight}`, dpr: devicePixelRatio, workspaces: document.querySelectorAll(".ls-world .ls-node").length };
    try {
      await sleep(2500);
      out.startup = { longFrames: longFrames.length, longMs: round(longFrames.reduce((a, f) => a + f.duration, 0)) };
      out.zooms = [];
      for (const z of zooms) {
        await zoomTo(z);
        await sleep(1500);
        const before = attached();
        const idle = await rest(3000);
        const pan = await run(180, (i) => wheelAt({ deltaX: i < 90 ? 14 : -14, deltaY: i < 90 ? 5 : -5 }));
        await sleep(800);
        // ±8% about z: 30 frames in, 60 out, 30 back in
        const pinch = await run(120, (i) => pinchBy(i < 30 || i >= 90 ? Math.exp(0.0025) : Math.exp(-0.0025)));
        await sleep(800);
        (out.zooms as unknown[]).push({ zoom: z, reached: round(zoomNow() * 1000) / 1000, attached: before, selectionBar: !!document.querySelector(".ls-selbar"), idle, pan, pinch });
      }
      await zoomTo(1);
      await sleep(1500);
      // 100% to 25% and back, crossing every band: 60 frames each way
      const k = Math.exp(Math.log(0.25) / 60);
      out.sweep = await run(120, (i) => pinchBy(i < 60 ? k : 1 / k));
      out.sweepEnd = round(zoomNow() * 1000) / 1000;
    } catch (err) {
      out.error = String(err instanceof Error ? err.stack : err);
    }
    const tag = document.createElement("script");
    tag.type = "application/json";
    tag.id = "mb-landscape-perf";
    tag.textContent = JSON.stringify(out);
    document.body.appendChild(tag);
  });
}
// ?scrollAudit (with ?motion=full or off) checks that terminals follow their output: a terminal whose view was at the
// bottom stays there while another area is on screen (output arriving while it's off screen, back while its program
// is idle), a teammate's copy re-fitted to a wider owner screen at a smaller font, the side bar and the
// bottom panel hidden and shown, an agent's inline frame shrinking and its pane getting taller under it, and a Repaint;
// one the user scrolled up stays where they put it while output goes
// on (a teammate's copy too, through its font change), with a "Jump to latest" control that brings it back. After each step it checks every shown terminal: at its bottom (xterm's and the page's
// scroll offsets agreeing), its rows within its holder's content box, nothing scrollable below it. It writes what was
// wrong into <script id="mb-scroll-audit"> for test/uiTerminal.test.ts.
if (params.has("scrollAudit")) {
  if (!lsCamera) set("mb.landscape.camera", { x: 0, y: 0, zoom: 1 });
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
  // the bottom of an agent's view is its last drawn row (bottomLine), which the blank-rows check below verifies on its own
  const behind = (t: Term) => bottomLine(t) - t.buffer.active.viewportY;
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
        if (behind(term)) problems.push(`${step}: ${id} is ${behind(term)} lines above its bottom${followsBottom(term) ? "" : ", no longer following its output"}`);
        if (toast) problems.push(`${step}: ${id} is at its bottom and shows Jump to latest`);
        // the page's scroll offset is where xterm reads the next wheel move from: a screen short of the bottom, it jumps the view up
        const reach = Math.round((vp.scrollHeight - vp.clientHeight) / rowH);
        if (Math.abs(reach - term.buffer.active.baseY) > 0) problems.push(`${step}: ${id}'s page can scroll to line ${reach} of its ${term.buffer.active.baseY}`);
        if (Math.abs(vp.scrollTop / rowH - term.buffer.active.viewportY) >= 0.5) problems.push(`${step}: ${id}'s page is scrolled to line ${(vp.scrollTop / rowH).toFixed(1)}, its view at ${term.buffer.active.viewportY}`);
      }
      if (!holder.classList.contains("fixed") && term.rows * rowH > content + 0.5) problems.push(`${step}: ${id} has ${term.rows} rows (${(term.rows * rowH).toFixed(1)}px) in ${content}px`);
      // an agent's view of its newest output ends at its last drawn row (or its cursor), with history above rather than blank rows below
      if (id !== "s4" && !scrolledUp.includes(id)) {
        const b = term.buffer.active;
        let blank = 0;
        for (let y = term.rows - 1; y >= 0 && b.viewportY + y !== b.baseY + b.cursorY && !b.getLine(b.viewportY + y)?.translateToString(true).trim(); y--) blank++;
        if (blank && b.viewportY > 0) problems.push(`${step}: ${id} shows ${blank} blank rows below its program's last line`);
      }
      // a holder that scrolls past its terminal shows blank space below the program's last line
      const below = holder.scrollHeight - holder.clientHeight - Math.max(0, term.element!.offsetHeight + parseFloat(pad.paddingTop) + parseFloat(pad.paddingBottom) - holder.clientHeight);
      if (below > 1) problems.push(`${step}: ${id}'s pane has ${below}px to scroll below its terminal`);
    }
  };
  const vp = () => document.querySelector<HTMLElement>(".ls-viewport")!;
  const nodeOf = (id: string) => document.querySelector<HTMLElement>(`.ls-world [data-front="${CSS.escape(id)}"]`);
  // selected, and the landscape at 100%, which is where a wheel over a terminal is the terminal's
  const pickAt100 = async (id: string) => {
    press(document.querySelector(`.area-tree .lt-ws[data-sid="${CSS.escape(id)}"]`), `${id}'s row`);
    await sleep(400);
    await settle();
    vp().focus();
    vp().dispatchEvent(new KeyboardEvent("keydown", { key: "1", metaKey: true, bubbles: true, cancelable: true }));
    await sleep(300);
    await settle();
  };
  const homeView = async () => {
    await pickAt100("s1");
    press(row(".area-tree .lt-head", "#5101"), "area #5101");
    await sleep(400);
    await settle();
    vp().focus();
    vp().dispatchEvent(new KeyboardEvent("keydown", { key: "1", metaKey: true, bubbles: true, cancelable: true }));
    await sleep(300);
    await settle();
  };
  waitFor('.ls-world [data-front="s1"] .xterm', async () => {
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
      // output while another area is what's on screen; back while its programs are idle
      press(row(".area-tree .lt-head", "#5102"), "#5102");
      await sleep(400);
      await settle();
      for (let i = 0; i < 10; i++) {
        lines(20, `hidden ${i}`);
        await sleep(30);
      }
      await settle();
      await homeView();
      check("back on screen, idle");
      lines(40, "after");
      await settle();
      check("output after it came back");
      done.push("off screen and back");
      // the teammate's screen widens while their copy here is scrolled up: it re-fits at a smaller font and stays
      // where it was; then their screen narrows again, and the copy follows its output at the larger font
      const nick = live.remote.find((s) => s.id === NICK_PANE)!;
      await pickAt100(NICK_PANE);
      const copy = terms()!.get(NICK_PANE)!.term;
      copy.element!.querySelector(".xterm-screen")!.dispatchEvent(new WheelEvent("wheel", { deltaY: -400, deltaMode: 0, bubbles: true, cancelable: true }));
      await settle();
      nick.room = { ...nick.room!, cols: 240, rows: 30 };
      emit("onTeamLive", JSON.parse(JSON.stringify(live)));
      await settle();
      lines(20, "small font");
      await settle();
      check("teammate's copy at a smaller font, scrolled up", [NICK_PANE]);
      const copyLatest = nodeOf(NICK_PANE)?.querySelector(".scroll-toast.jump");
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
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "\\", metaKey: true, bubbles: true }));
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
      // an agent drawing inline (Claude Code's classic renderer) parks its cursor in its input box and leaves the rows its
      // frame gives up blank below it: as its frame shrinks, and as its pane gets taller (xterm adds those rows blank)
      const agents = ["s1", NICK_PANE];
      const frameRows = (id: string, n: number) => {
        const rule = "─".repeat(terms()!.get(id)!.term.cols);
        return [rule, "> ", rule, "  auto mode on", ...Array.from({ length: n }, (_, i) => `  agent ${i} running`)];
      };
      for (const id of agents) say(id, `${frameRows(id, 6).join("\r\n")}\r\n\x1b[2C\x1b[9A`);
      await settle();
      check("inline frame drawn");
      for (const id of agents) say(id, `\x1b[2D\x1b[9B${"\x1b[2K\x1b[1A".repeat(4)}\x1b[2K\x1b[G\x1b[1A\x1b[2K\x1b[2C\x1b[4A`);
      await settle();
      check("inline frame shrank");
      for (const step of ["bottom panel shown", "bottom panel hidden"]) {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", metaKey: true, bubbles: true }));
        await settle();
        check(`${step} under an inline frame`);
      }
      done.push("inline frame");
      // the user scrolls a pane up; output goes on; it stays, until Jump to latest
      await pickAt100("s1");
      const s1 = terms()!.get("s1")!.term;
      s1.element!.querySelector(".xterm-screen")!.dispatchEvent(new WheelEvent("wheel", { deltaY: -600, deltaMode: 0, bubbles: true, cancelable: true }));
      await settle();
      const top = s1.buffer.active.getLine(s1.buffer.active.viewportY)?.translateToString(true);
      lines(60, "while scrolled up");
      await settle();
      check("output while the user is scrolled up", ["s1"]);
      if (s1.buffer.active.getLine(s1.buffer.active.viewportY)?.translateToString(true) !== top) problems.push("output while the user is scrolled up: s1's view moved from where they put it");
      const toLatest = nodeOf("s1")?.querySelector(".scroll-toast.jump");
      if (toLatest) press(toLatest, "s1's Jump to latest");
      else s1.scrollToBottom(); // its problem is noted: the rest still runs
      await settle();
      check("Jump to latest");
      lines(20, "after the jump");
      await settle();
      check("output after Jump to latest");
      done.push("scrolled up, then back");
      press(nodeOf("s1")?.querySelector(".ls-more"), "s1's ⋯");
      await sleep(200);
      press([...document.querySelectorAll(".mb-ctx button")].find((b) => b.querySelector(".mb-ctx-t")?.textContent === "Repaint"), "s1's Repaint");
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
// ?ctxAudit (real time: pageResult) drives the context warning as a person does and writes what it saw into
// <script id="mb-ctx-audit"> for test/uiContextWarning.test.ts. =idle: s5, past 75% and idle — an amber chip whose
// popover's Compact is sent on the click only, and the chip goes once the smaller context is reported. =waiting: s2,
// past 90% while asking for permission — a red chip, Compact held back; Dismiss hides it and is remembered. =resume:
// the crashed s6, whose cold conversation asks before resuming — Cancel leaves it, Continue resumes it.
if (params.get("ctxAudit")) {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // the session's chip: every workspace past its limit has one on the landscape
  const chipOf = params.get("ctxAudit") === "waiting" ? "s2" : "s5";
  const chip = () => document.querySelector(`.ls-world [data-front="${chipOf}"] .ctx-chip`) as HTMLElement | null;
  const pop = () => document.querySelector(".ctx-pop") as HTMLElement | null;
  const button = (root: Element | null, text: string) => [...(root?.querySelectorAll("button") ?? [])].find((b) => b.textContent === text) as HTMLButtonElement | undefined;
  const count = (fn: string) => calls.filter((c) => c.fn === fn).length;
  const until = async (ok: () => boolean, ms: number) => {
    for (const end = Date.now() + ms; !ok() && Date.now() < end; ) await sleep(100);
    return ok();
  };
  (async () => {
    const out: Record<string, unknown> = {};
    const mode = params.get("ctxAudit");
    if (mode === "resume") {
      // its body's Resume in focus (?lsFocus=s6), or its card's on the landscape: the same check first
      const within = params.has("lsFocus") ? '.ls-focus [data-front="s6"]' : '.ls-world [data-front="s6"]';
      const resumeButton = () => [...document.querySelectorAll<HTMLElement>(`${within} button`)].find((b) => b.textContent?.trim().startsWith("Resume"));
      await until(() => !!resumeButton(), 5000);
      out.inBody = !!resumeButton()?.closest(".dead-body");
      const resume = () => resumeButton()?.click();
      resume();
      out.asked = await until(() => !!document.querySelector(".cost-dlg"), 3000);
      out.say = document.querySelector(".cost-dlg .cost-say")?.textContent ?? null;
      out.why = document.querySelector(".cost-dlg .cost-why")?.textContent ?? null;
      button(document.querySelector(".cost-dlg"), "Cancel")?.click();
      await sleep(400);
      out.afterCancel = { dialog: !!document.querySelector(".cost-dlg"), resumed: count("resumeSession") };
      resume();
      await until(() => !!document.querySelector(".cost-dlg"), 3000);
      button(document.querySelector(".cost-dlg"), "Continue")?.click();
      await until(() => count("resumeSession") > 0, 3000);
      out.afterContinue = { dialog: !!document.querySelector(".cost-dlg"), resumed: count("resumeSession") };
    } else if (mode === "takenOver") {
      // y1, which Nick took over, and then s1: what its ⋯, its context warning, ⌘K and the Changes tool's Second opinion
      // (with ?view=scm) offer for each, and which are off saying why
      const IDS: Record<string, string> = { "Donor entity model": "y1", "Org dropdowns remember the last org": "s1" };
      const paneOf = (title: string) => document.querySelector<HTMLElement>(`.ls-world [data-front="${IDS[title]}"]`);
      const Y1 = "Donor entity model";
      const S1 = "Org dropdowns remember the last org";
      const reach = async (title: string) => {
        (document.querySelector(`.area-tree .lt-ws[data-sid="${IDS[title]}"]`) as HTMLElement | null)?.click();
        await sleep(600);
      };
      const controls = async (title: string) => {
        await reach(title);
        await until(() => !!paneOf(title)?.querySelector(".ls-more"), 5000);
        paneOf(title)?.querySelector<HTMLElement>(".ls-more")?.click();
        await until(() => !!document.querySelector(".mb-ctx"), 2000);
        const rows = [...document.querySelectorAll<HTMLButtonElement>(".mb-ctx button")]
          .map((b) => ({ t: b.querySelector(".mb-ctx-t")?.textContent?.trim() ?? "", off: b.disabled || b.getAttribute("aria-disabled") === "true", why: b.disabled || b.getAttribute("aria-disabled") === "true" ? b.title : null }))
          .filter((b) => b.t.startsWith("Undo") || b.t.startsWith("Continue in Codex"));
        document.querySelector(".mb-ctx")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
        await sleep(250);
        return rows;
      };
      const review = () => {
        const b = document.querySelector<HTMLButtonElement>(".sc-review");
        return b ? { off: b.disabled, why: b.disabled ? b.title : null } : null;
      };
      const y1Controls = await controls(Y1);
      out.shown = await until(() => !!paneOf(Y1)?.querySelector(".ctx-chip"), 5000);
      paneOf(Y1)?.querySelector<HTMLElement>(".ctx-chip")?.click();
      await until(() => !!pop(), 2000);
      const brief = button(pop(), "Fresh session with a brief");
      out.brief = brief ? { disabled: brief.disabled, title: brief.title } : null;
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      await sleep(300);
      // ⌘K with each focused: its Undo and Continue entries, and why one's off
      const palette = async (title: string) => {
        await reach(title);
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }));
        if (!(await until(() => !!document.querySelector(".palette"), 2000))) return [{ label: "⌘K opened no palette", off: null }];
        const rows = [...document.querySelectorAll(".palette .results .row")].map((r) => ({ label: r.querySelector(".lab")?.textContent ?? "", off: r.classList.contains("off") ? (r.querySelector(".state")?.textContent ?? "") : null }));
        if (!rows.length) return [{ label: "the palette lists nothing", off: null }];
        if (title === Y1) {
          // its off Undo row chosen, by Enter with it first and then by a click: nothing runs, and the palette stays
          typeInto(".palette input", "Undo a turn of");
          await sleep(300);
          const first = () => document.querySelector<HTMLElement>(".palette .results .row");
          const after = () => ({ palette: !!document.querySelector(".palette"), undoDialog: !!document.querySelector(".undo-dlg"), turnsList: count("turnsList") });
          const row = { label: first()?.querySelector(".lab")?.textContent ?? null, off: !!first()?.classList.contains("off"), sel: !!first()?.classList.contains("sel") };
          document.querySelector(".palette input")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
          await sleep(400);
          const enter = after();
          first()?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
          await sleep(400);
          out.chosenOff = { row, enter, click: after() };
        }
        document.querySelector(".palette input")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
        await until(() => !document.querySelector(".palette"), 2000);
        return rows.filter((r) => /^(Undo a turn|Continue in)/.test(r.label));
      };
      const y1Palette = await palette(Y1);
      // the Changes tool's window, for the workspace selected; each workspace has its own
      const changes = () => document.querySelector<HTMLElement>('.ab-btn[aria-label="Changes"]')?.click();
      changes();
      await until(() => !!review(), 3000);
      const y1Review = review();
      changes();
      await until(() => !review(), 3000);
      // s1, jumped to from ⌘K: it comes into view, selected
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }));
      await until(() => !!document.querySelector(".palette"), 2000);
      [...document.querySelectorAll<HTMLElement>(".palette .results .row")].find((r) => r.querySelector(".lab")?.textContent === S1)?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      await sleep(800);
      out.controls = { y1: y1Controls, s1: await controls(S1) };
      out.palette = { y1: y1Palette, s1: await palette(S1) };
      changes();
      await until(() => review()?.off === false, 3000);
      out.review = { y1: y1Review, s1: review() };
    } else {
      out.shown = await until(() => !!chip(), 5000);
      out.tone = chip()?.classList.contains("firm") ? "firm" : chip()?.classList.contains("heads") ? "heads" : null;
      out.chip = chip()?.textContent ?? null;
      out.inHeader = !!chip()?.closest(".ls-head");
      out.popBeforeClick = !!pop();
      chip()?.click();
      await until(() => !!pop(), 2000);
      out.popTone = pop()?.classList.contains("firm") ? "firm" : "heads";
      out.headline = pop()?.querySelector(".ctx-pop-h")?.textContent ?? null;
      out.sub = pop()?.querySelector(".ctx-pop-sub")?.textContent ?? null;
      const compact = button(pop(), "Compact");
      out.compactDisabled = !!compact?.disabled;
      out.compactTitle = compact?.title ?? null;
      out.hasBrief = !!button(pop(), "Fresh session with a brief");
      out.note = pop()?.querySelector(".ctx-pop-note")?.textContent ?? null;
      out.sentBeforeClick = count("contextCompact");
      out.typedBeforeClick = count("sessionWrite");
      compact?.click();
      await sleep(400);
      out.sentAfterClick = count("contextCompact");
      if (mode === "idle") {
        out.compactingChip = chip()?.textContent ?? null;
        out.clearedAfterCompact = await until(() => !chip(), 15_000);
      } else {
        button(pop(), "Dismiss")?.click();
        await sleep(300);
        out.dismissedGone = !chip() && !pop();
        out.dismissal = JSON.parse(localStorage.getItem("mb.ctxDismissed") ?? "null");
      }
    }
    const tag = document.createElement("script");
    tag.type = "application/json";
    tag.id = "mb-ctx-audit";
    tag.textContent = JSON.stringify(out);
    document.body.appendChild(tag);
  })();
}
// ?statusAudit (with ?statusNotes): the status bar saying what ?statusNotes gives it, before following Nick from ⌘K,
// while following him, and once he shows nothing (its "waiting for a shared session" wording): how much of each note
// shows inside the bar and whether its words were cut with their whole on hover, whether the update link, the hooks
// warning and Stop show whole, and whether Following's words were cut. Into <script id="mb-status-audit"> for
// test/uiStatusBar.test.ts.
if (params.has("statusAudit")) {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const until = async (ok: () => boolean, ms: number) => {
    for (const end = Date.now() + ms; !ok() && Date.now() < end; ) await sleep(100);
    return ok();
  };
  (async () => {
    const out: Record<string, unknown> = {};
    try {
      const notes = params.get("statusNotes") === "few" ? 0 : 2;
      if (!(await until(() => !!document.querySelector(".statusbar .hooks-bad") && !!document.querySelector(".statusbar .update-link") && document.querySelectorAll(".statusbar .update-note.bad").length === notes, 8000))) throw new Error("the status bar's notes didn't all show");
      await sleep(300);
      const measure = () => {
        const bar = document.querySelector<HTMLElement>(".statusbar")!.getBoundingClientRect();
        // how much of it shows inside the bar, in px; null when it isn't there
        const shown = (el: Element | null) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return Math.max(0, Math.round(Math.min(r.right, bar.right) - Math.max(r.left, bar.left)));
        };
        const whole = (el: Element | null) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.left >= bar.left - 0.5 && r.right <= bar.right + 0.5;
        };
        const who = document.querySelector<HTMLElement>(".statusbar .team-follow .tf-who");
        const cutOf = (el: HTMLElement | null) => !!el && el.scrollWidth > el.clientWidth + 0.5;
        return {
          notes: [...document.querySelectorAll<HTMLElement>(".statusbar .update-note.bad")].map((n) => {
            const words = n.querySelector<HTMLElement>(".un-text");
            return { shown: shown(n), whole: whole(n), cut: cutOf(words), onHover: !!words && n.title.includes((words.textContent ?? "").replace(/^✕ /, "")) };
          }),
          link: whole(document.querySelector(".statusbar .update-link")),
          hooks: whole(document.querySelector(".statusbar .hooks-bad")),
          usage: shown(document.querySelector(".statusbar .usage-wrap")),
          stop: whole(document.querySelector(".statusbar .team-follow button")),
          meter: [...document.querySelectorAll<HTMLElement>(".statusbar .usage > .dim, .statusbar .usage .usage-agent > span")].map((p) => {
            const box = document.querySelector<HTMLElement>(".statusbar .usage")!.getBoundingClientRect();
            const end = document.querySelector<HTMLElement>(".statusbar")!.getBoundingClientRect().right;
            const r = p.getBoundingClientRect();
            const seenW = Math.min(r.right, box.right, end) - Math.max(r.left, box.left);
            const seenH = Math.min(r.bottom, box.bottom) - Math.max(r.top, box.top);
            return { text: p.textContent ?? "", seen: seenW <= 0 || seenH <= 0 ? "dropped" : seenW >= r.width - 0.5 && seenH >= r.height - 0.5 ? "whole" : "cut" };
          }),
          words: who?.textContent ?? null,
          cut: !!who && who.scrollWidth > who.clientWidth + 0.5,
          title: document.querySelector<HTMLElement>(".statusbar .team-follow")?.title ?? null,
          // what takes the bar's width, for a failure to say
          parts: [...document.querySelector<HTMLElement>(".statusbar")!.querySelectorAll(":scope > *, :scope > .right > *")].map((c) => `${c.className || c.tagName}: ${Math.round(c.getBoundingClientRect().width)} ${c.textContent?.slice(0, 30)}`),
          width: Math.round(bar.width),
        };
      };
      out.before = measure();
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }));
      if (!(await until(() => !!document.querySelector(".palette"), 2000))) throw new Error("⌘K opened no palette");
      typeInto(".palette input", "Follow Nick");
      await sleep(300);
      const row = [...document.querySelectorAll<HTMLElement>(".palette .results .row")].find((r) => r.querySelector(".lab")?.textContent?.startsWith("Follow Nick"));
      if (!row) throw new Error("⌘K offers no Follow Nick");
      row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      if (!(await until(() => !!document.querySelector(".statusbar .team-follow.on"), 3000))) throw new Error("following Nick isn't said in the status bar");
      await sleep(400);
      out.following = measure();
      live.views = live.views.filter((v) => v.member !== NICK);
      emit("onTeamLive", clone(live));
      await sleep(600);
      out.waiting = measure();
      document.querySelector<HTMLElement>(".statusbar .team-follow button")?.click();
      await sleep(300);
      out.stopped = !document.querySelector(".statusbar .team-follow");
    } catch (err) {
      out.error = String(err instanceof Error ? err.stack : err);
    }
    const tag = document.createElement("script");
    tag.type = "application/json";
    tag.id = "mb-status-audit";
    tag.textContent = JSON.stringify(out);
    document.body.appendChild(tag);
  })();
}
// ?copyAudit prints a long command and a long sentence into panes the way their programs do — Claude Code (s1), a
// teammate's copy of a Claude session and Codex (s3) wrap them at the pane's width themselves, cutting the path
// mid-word; a shell (s4) leaves the wrapping to the terminal — then selects them and copies, as a native selection's
// release (copy-on-select) and as ⌘C. It writes what each copy put on the clipboard into
// <script id="mb-copy-audit"> for test/uiLandscapeZoom.test.ts, in workspaces at 100%, where terminals draw with WebGL
// (each one's renderer is said), the path long enough to wrap their wider screens.
if (params.has("copyAudit")) {
  if (!lsCamera) set("mb.landscape.camera", { x: 0, y: 0, zoom: 1 });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const terms = () => w.__mbTerms as Map<string, { term: import("@xterm/xterm").Terminal }> | undefined;
  const say = (id: string, text: string) => {
    buffers[id] = (buffers[id] ?? "") + text;
    emit("onSessionData", id, text);
  };
  const written: string[] = [];
  Object.defineProperty(navigator.clipboard, "writeText", { configurable: true, value: async (text: string) => void written.push(text) });
  const PATH = `/private/tmp/claude-501/-Users-alex-Code-backoffice/1234abcd-5678-90ef-aaaa-bbbbccccdddd/scratchpad/landscape-checks/a-folder-deep-enough-for-a-wide-workspace/add-portal-users-keys.sh`;
  const SENTENCE = "That script reads every portal user from the database, generates a key pair for each one that doesn't have one yet, and writes the public half back so the next login picks it up.";
  // an agent's rows: the box two columns in, a word longer than it cut at its edge
  const agentRows = (text: string, cols: number) => {
    const width = cols - 2;
    const rows = [""];
    for (const word of text.split(" ")) {
      const row = rows[rows.length - 1];
      if (word.length > width) {
        let rest = row ? `${row} ${word}` : word;
        rows.pop();
        for (; rest.length > width; rest = rest.slice(width)) rows.push(rest.slice(0, width));
        rows.push(rest);
      } else if (row && row.length + 1 + word.length > width) rows.push(word);
      else rows[rows.length - 1] = row ? `${row} ${word}` : word;
    }
    return rows.map((r) => `  ${r}`);
  };
  waitFor('.ls-world [data-front="s1"] .xterm', async () => {
    const out: Record<string, unknown> = {};
    try {
      await sleep(800);
      const copies: Record<string, { cols: number; mouse: string; renderer: string; rows: number[]; onSelect: string[]; copyEvent: string[] }> = {};
      for (const id of ["s1", NICK_PANE, "s3", "s4"]) {
        // a tab behind its stack's front one comes to the front
        const tab = document.querySelector<HTMLElement>(`.ls-world .ls-tab[data-sid="${CSS.escape(id)}"]:not(.on)`);
        if (tab) {
          tab.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
          tab.click();
          await sleep(500);
        }
        // selected, so its terminal is attached wherever its workspace is
        document.querySelector(`.ls-world [data-front="${CSS.escape(id)}"] .ls-head`)?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
        await sleep(500);
        const term = terms()?.get(id)?.term;
        if (!term?.element?.isConnected) throw new Error(`the audit found no terminal for ${id}`);
        const cols = term.cols;
        // the WebGL renderer draws on a canvas of its own beside xterm's link layer; the DOM renderer has neither
        const gl = [...term.element.querySelectorAll(".xterm-screen canvas")].some((c) => !c.classList.contains("xterm-link-layer"));
        copies[id] = { cols, mouse: term.modes.mouseTrackingMode, renderer: gl ? "webgl" : "dom", rows: [], onSelect: [], copyEvent: [] };
        const texts = id === "s4" ? [`$ bash ${PATH}`] : [`! bash ${PATH}`, SENTENCE];
        for (const text of texts) {
          say(id, "\x1b[0m\r\n" + (id === "s4" ? text : agentRows(text, cols).join("\r\n")) + "\r\n");
          await sleep(150);
          const b = term.buffer.active;
          const last = b.baseY + b.cursorY - 1;
          let first = last;
          const head = (y: number) => b.getLine(y)?.translateToString(true).trim() ?? "";
          while (first > 0 && !text.startsWith(head(first))) first--;
          copies[id].rows.push(last - first + 1);
          term.select(0, first, (last - first + 1) * cols);
          term.element.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true }));
          window.dispatchEvent(new PointerEvent("pointerup", { button: 0, bubbles: true }));
          await sleep(50);
          copies[id].onSelect.push(written.pop() ?? "(nothing)");
          const data = new DataTransfer();
          term.textarea?.dispatchEvent(new ClipboardEvent("copy", { clipboardData: data, bubbles: true, cancelable: true }));
          copies[id].copyEvent.push(data.getData("text/plain"));
          term.clearSelection();
        }
      }
      out.copies = copies;
      out.expected = { agent: [`  ! bash ${PATH}`, `  ${SENTENCE}`], shell: [`$ bash ${PATH}`] };
    } catch (err) {
      out.error = String(err);
    }
    const tag = document.createElement("script");
    tag.type = "application/json";
    tag.id = "mb-copy-audit";
    tag.textContent = JSON.stringify(out);
    document.body.appendChild(tag);
  });
}
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
// Cards on a board (the Dashboard's, `root` ".board"; the House board's, ".house-board") dragged with the events a
// browser sends while a person drags (drop target under the pointer, the DataTransfer carried along). A drag Esc
// cancels ends as the browser ends it: dragend on the card, with no drop.
const cardDrag = (root: string) => {
  const col = (name: string) => document.querySelector<HTMLElement>(`${root} [data-col="${name}"]`);
  const cards = (name: string) => [...(col(name)?.querySelectorAll<HTMLElement>(":is(.bcol-body, .house-fold-body) > .bcard") ?? [])];
  const ids = (name: string) => cards(name).map((c) => Number(c.dataset.id));
  const card = (id: number) => document.querySelector<HTMLElement>(`${root} .bcard[data-id="${id}"]`);
  const send = (el: Element, type: string, dt: DataTransfer, x: number, y: number) =>
    el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
  /** A pointer y inside gap `gap` of a column, from where its cards sit in the layout (not where they've parted to); a column with no card list (folded), its middle. */
  const gapY = (name: string, gap: number) => {
    const list = cards(name);
    const body = col(name)!.querySelector<HTMLElement>(".bcol-body");
    if (!body) {
      const r = col(name)!.getBoundingClientRect();
      return r.top + Math.min(r.height / 2, 60);
    }
    const top = body.getBoundingClientRect().top - body.scrollTop;
    const mid = (c: HTMLElement) => top + c.offsetTop + c.offsetHeight / 2;
    if (!list.length) return top + 30;
    if (gap <= 0) return top + list[0].offsetTop + 2;
    if (gap >= list.length) return top + list[list.length - 1].offsetTop + list[list.length - 1].offsetHeight - 2;
    return (mid(list[gap - 1]) + mid(list[gap])) / 2;
  };
  let held: { src: HTMLElement; dt: DataTransfer; x: number; y: number } | null = null;
  return {
    col,
    cards,
    ids,
    card,
    start(id: number) {
      const src = card(id)!;
      const r = src.getBoundingClientRect();
      held = { src, dt: new DataTransfer(), x: r.left + r.width / 2, y: r.top + r.height / 2 };
      send(src, "dragstart", held.dt, held.x, held.y);
    },
    /** True when the place under the pointer takes the drop (its dragover cancelled the event, as a browser needs). */
    over(name: string, gap: number): boolean {
      const c = col(name)!;
      const r = c.getBoundingClientRect();
      held!.x = r.left + r.width / 2;
      held!.y = gapY(name, gap);
      return !send(document.elementFromPoint(held!.x, held!.y) ?? c, "dragover", held!.dt, held!.x, held!.y);
    },
    drop() {
      const at = document.elementFromPoint(held!.x, held!.y)!;
      send(at, "drop", held!.dt, held!.x, held!.y);
      send(held!.src, "dragend", held!.dt, held!.x, held!.y);
      held = null;
    },
    cancel() {
      send(held!.src, "dragend", held!.dt, held!.x, held!.y);
      held = null;
    },
  };
};
const boardDrag = cardDrag(".board");
// ?boardDrag=5115,In Progress,1 picks up a card and holds it over a gap of a column (0: above its first card), for a
// screenshot of the line mid-drag
const boardDragQ = params.get("boardDrag");
if (boardDragQ) {
  set("mb.tab", "dashboard");
  const [id, name, gap] = boardDragQ.split(",");
  waitFor(`.bcard[data-id="${id}"]`, () => {
    boardDrag.start(Number(id));
    setTimeout(() => boardDrag.over(name, Number(gap)), 50);
  });
}
// ?boardAudit (with ?motion=full or reduce; real time: pageResult) drags Dashboard cards up and down the In
// Progress column and into others, cancels one as Esc does, moves one with ⌥↑, and writes what it saw into
// <script id="mb-board-audit"> for test/uiBoardOrder.test.ts: the line at each gap (its owner, where it is, the
// neighbours either side, after their parting has finished), the writes, and the columns' cards after each drop.
// ?boardAudit=fail (with ?reorderFail) drops one whose reorder Azure DevOps refuses.
if (params.has("boardAudit")) {
  set("mb.tab", "dashboard");
  const b = boardDrag;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const settle = async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    for (const a of document.getAnimations()) a.finish();
  };
  const box = (el: Element | null) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom };
  };
  // how far a card has moved up or down, in whole px (0, never -0)
  const shift = (el: Element) => {
    const t = getComputedStyle(el).transform;
    return Math.round(t === "none" ? 0 : new DOMMatrix(t).m42) || 0;
  };
  /** The drop line: the element drawing it, its middle on screen, its colour and thickness; null with none shown. */
  const line = () => {
    const el = document.querySelector<HTMLElement>('.bcard[data-gap="above"], .bcard[data-gap="below"]:last-child, .bcol-body[data-gap="empty"]');
    if (!el) return null;
    const pseudo = el.matches('.bcard[data-gap="below"]') ? "::after" : "::before";
    const s = getComputedStyle(el, pseudo);
    if (s.content === "none" || s.content === "normal") return null;
    const r = el.getBoundingClientRect();
    const h = parseFloat(s.height);
    const y = el.classList.contains("bcol-body") ? r.top + parseFloat(getComputedStyle(el).paddingTop) + h / 2 : r.top + parseFloat(getComputedStyle(el).borderTopWidth) + parseFloat(s.top) + h / 2;
    return { owner: el.classList.contains("bcol-body") ? "empty" : Number(el.dataset.id), y, height: h, color: s.backgroundColor, width: parseFloat(s.width) };
  };
  /** What's on screen while hovering a gap. */
  const hover = async (name: string, gap: number) => {
    b.over(name, gap);
    await settle();
    const list = b.cards(name);
    return {
      line: line(),
      above: box(list[gap - 1] ?? null),
      below: box(list[gap] ?? null),
      shifts: Object.fromEntries(list.map((c) => [c.dataset.id, shift(c)])),
      label: document.querySelector(".drag-label")?.textContent ?? null,
      lifted: [...document.querySelectorAll<HTMLElement>(".bcard.lifted")].map((c) => Number(c.dataset.id)),
    };
  };
  const writes = () => calls.filter((c) => c.fn === "adoReorder" || c.fn === "adoMoveToColumn").map((c) => [c.fn, ...c.args]);
  const reads = () => calls.filter((c) => c.fn === "adoList").length;
  const columns = () => Object.fromEntries(["New", "In Progress", "Testing"].map((n) => [n, b.ids(n)]));
  (async () => {
    const out: Record<string, unknown> = {};
    for (let i = 0; i < 100 && b.ids("In Progress").length < 3; i++) await sleep(50);
    await sleep(300);
    out.mode = document.documentElement.dataset.motion;
    out.start = columns();
    if (params.get("boardAudit") === "fail") {
      b.start(5115);
      await hover("In Progress", 0);
      b.drop();
      await settle();
      out.optimistic = columns();
      await sleep(900);
      out.after = columns();
      out.error = document.querySelector(".board-err")?.textContent ?? null;
      out.writes = writes();
    } else {
      // up the column: the bottom card over the top gap, then over the middle one, and dropped there
      out.readsBefore = reads();
      b.start(5115);
      out.top = await hover("In Progress", 0);
      out.middle = await hover("In Progress", 1);
      b.drop();
      await settle();
      out.dropped = { columns: columns(), line: line(), lifted: document.querySelectorAll(".bcard.lifted").length };
      await sleep(700);
      out.afterDrop = { columns: columns(), writes: writes(), reads: reads() };
      // over the bottom gap, then cancelled
      b.start(5101);
      out.bottom = await hover("In Progress", 3);
      b.cancel();
      await settle();
      await sleep(300);
      out.cancelled = { columns: columns(), writes: writes(), reads: reads(), line: line(), lifted: document.querySelectorAll(".bcard.lifted").length, label: !!document.querySelector(".drag-label") };
      // into a column with no cards shown (Testing's is Sam's), then into the middle of In Progress
      b.start(5110);
      out.empty = await hover("Testing", 0);
      b.drop();
      await sleep(700);
      out.afterEmpty = { columns: columns(), writes: writes() };
      b.start(5120);
      out.across = await hover("In Progress", 1);
      b.drop();
      await sleep(900);
      out.afterAcross = { columns: columns(), writes: writes() };
      // the keyboard: the bottom card of In Progress, one place up
      const last = b.cards("In Progress").at(-1)!;
      last.focus();
      last.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", altKey: true, bubbles: true, cancelable: true }));
      await sleep(700);
      const focused = document.activeElement as HTMLElement | null;
      out.keyboard = { moved: Number(last.dataset.id), columns: columns(), writes: writes(), focused: focused?.classList.contains("bcard") ? Number(focused.dataset.id) : null, outline: focused ? getComputedStyle(focused).outlineStyle : null };
    }
    const tag = document.createElement("script");
    tag.type = "application/json";
    tag.id = "mb-board-audit";
    tag.textContent = JSON.stringify(out);
    document.body.appendChild(tag);
  })();
}
// ?houseDrag=143,Validating picks up a House board card and holds it over a column (or Parked), for a screenshot of
// the line mid-drag
const houseDragQ = params.get("houseDrag");
if (houseDragQ) {
  const [n, name] = houseDragQ.split(",");
  const h = cardDrag(".house-board");
  waitFor(`.house-card[data-id="${n}"]`, () => {
    h.start(Number(n));
    setTimeout(() => h.over(name, 0), 50);
  });
}
// ?houseBoardAudit drags House board cards between its columns with the events a browser sends — a status change, a
// drag within its own column, one over the folded Done column, a claim (its branch asked on the card) and a release —
// moves one with ⌥←, and writes what it saw into <script id="mb-house-audit"> for test/uiHouseBoard.test.ts: the
// columns' cards, their headers, the line (its owner and where it sits), the label and the House writes after each.
// =fail (with ?houseRefuse) drops one whose status change the House refuses; =narrow reports what scrolls sideways.
if (params.has("houseBoardAudit")) {
  const mode = params.get("houseBoardAudit");
  const h = cardDrag(".house-board");
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const settle = async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    for (const a of document.getAnimations()) a.finish();
  };
  const NAMES = ["Ready", "In progress", "Review", "Validating"];
  const columns = () => Object.fromEntries(NAMES.map((n) => [n, h.ids(n)]));
  const writes = () => calls.filter((c) => c.fn === "houseWrite").map((c) => c.args[1]);
  const line = () => {
    const el = document.querySelector<HTMLElement>('.house-board .bcard[data-gap="above"], .house-board .bcard[data-gap="below"]:last-child, .house-board .bcol-body[data-gap="empty"]');
    if (!el) return null;
    const pseudo = el.matches('.bcard[data-gap="below"]') ? "::after" : "::before";
    const s = getComputedStyle(el, pseudo);
    if (s.content === "none" || s.content === "normal") return null;
    return { owner: el.classList.contains("bcol-body") ? "empty" : Number(el.dataset.id), column: el.closest<HTMLElement>("[data-col]")?.dataset.col ?? null, height: parseFloat(s.height) };
  };
  const hover = async (name: string) => {
    const accepted = h.over(name, 0);
    await settle();
    return {
      accepted,
      line: line(),
      label: document.querySelector(".drag-label")?.textContent ?? null,
      labelRefused: !!document.querySelector(".drag-label.no"),
      drop: h.col(name)?.dataset.drop ?? null,
      refuseNote: h.col(name)?.querySelector(".house-refuse")?.textContent ?? null,
      lifted: [...document.querySelectorAll<HTMLElement>(".house-board .bcard.lifted")].map((c) => Number(c.dataset.id)),
    };
  };
  const text = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)].map((e) => e.textContent?.replace(/\s+/g, " ").trim() ?? "");
  (async () => {
    const out: Record<string, unknown> = {};
    for (let i = 0; i < 100 && h.ids("Ready").length < 3; i++) await sleep(50);
    await sleep(300);
    out.start = columns();
    out.heads = text(".house-board .bcol .bcol-hd, .house-board .house-col-unfold");
    out.folds = text(".house-board .house-fold-h");
    out.parkedShown = h.ids("Parked").length;
    out.doneCards = document.querySelectorAll('.house-board [data-col="Done"] .bcard').length;
    out.droppedColumn = !!h.col("Dropped");
    if (mode === "narrow") {
      const modal = document.querySelector<HTMLElement>(".house-modal")!;
      const cols = document.querySelector<HTMLElement>(".house-cols")!;
      const box = modal.getBoundingClientRect();
      out.narrow = { modalScrolls: modal.scrollWidth > modal.clientWidth, colsScroll: cols.scrollWidth > cols.clientWidth, modalInWindow: box.left >= 0 && box.right <= window.innerWidth, overflowX: getComputedStyle(cols).overflowX };
    } else if (mode === "fail") {
      h.start(143);
      await hover("Validating");
      h.drop();
      await settle();
      out.optimistic = columns();
      await sleep(900);
      out.after = columns();
      out.error = document.querySelector(".house-board .fp-note.err")?.textContent ?? null;
      out.writes = writes();
    } else {
      // Review → Validating: a status change; the line where the House's order puts it, whatever gap it's over
      h.start(143);
      out.across = await hover("Validating");
      h.drop();
      await settle();
      out.dropped = { columns: columns(), line: line(), lifted: document.querySelectorAll(".house-board .bcard.lifted").length };
      await sleep(700);
      out.afterAcross = { columns: columns(), writes: writes() };
      // within its own column: no line, nothing to drop (the House has no rank to write); Esc cancels
      h.start(149);
      out.same = await hover("Ready");
      h.cancel();
      await settle();
      out.afterSame = { writes: writes(), line: line(), label: !!document.querySelector(".drag-label") };
      // over the folded Done column: refused, and the label says why; the drop does nothing
      h.start(151);
      out.done = await hover("Done");
      h.drop();
      await sleep(500);
      out.afterDone = { columns: columns(), writes: writes(), notice: document.querySelector('.house-board [role="status"]')?.textContent ?? null };
      // Ready → In progress, unclaimed: a claim, its branch asked on the card
      h.start(146);
      out.claim = await hover("In progress");
      h.drop();
      await settle();
      const form = document.querySelector<HTMLElement>('.house-card[data-id="146"] .house-claim');
      out.asking = { columns: columns(), branch: form?.querySelector("input")?.value ?? null, writes: writes().length };
      form?.querySelector<HTMLElement>("button.primary")?.click();
      await sleep(800);
      out.afterClaim = { columns: columns(), writes: writes() };
      // In progress → Ready, claimed by you: a release
      h.start(151);
      out.release = await hover("Ready");
      h.drop();
      await sleep(800);
      out.afterRelease = { columns: columns(), writes: writes() };
      // ⌥← on a focused card: one column back along the flow, by the same write, and it keeps the focus
      const c = h.card(143)!;
      c.focus();
      c.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true, bubbles: true, cancelable: true }));
      await sleep(800);
      const focused = document.activeElement as HTMLElement | null;
      out.keyboard = { columns: columns(), writes: writes(), focused: focused?.classList.contains("house-card") ? Number(focused.dataset.id) : null };
    }
    const tag = document.createElement("script");
    tag.type = "application/json";
    tag.id = "mb-house-audit";
    tag.textContent = JSON.stringify(out).replace(/</g, "\\u003c");
    document.body.appendChild(tag);
  })();
}
// ?houseStartAudit starts a session on a House card the ways a person would — its Start button, its right-click menu,
// the ticket's own button — and writes what it saw into <script id="mb-house-start-audit"> for
// test/uiTicketStart.test.ts: which cards offer Start, the menus' rows, the confirmation's fields, what Start asked of
// the main process, the House writes, and where the window went. =fail (with ?houseStartFail=session) has the
// worktree fail; =detail starts from the ticket's dialog.
if (params.has("houseStartAudit")) {
  const mode = params.get("houseStartAudit");
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const card = (n: number) => document.querySelector<HTMLElement>(`.house-card[data-id="${n}"]`);
  const menuOf = async (n: number) => {
    const c = card(n)!;
    const b = c.getBoundingClientRect();
    c.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: b.left + 40, clientY: b.top + 20 }));
    await sleep(150);
    const rows = [...document.querySelectorAll<HTMLButtonElement>(".mb-ctx button")].map((x) => ({ text: x.textContent?.trim() ?? "", disabled: x.disabled, title: x.title }));
    return rows;
  };
  const closeMenu = async () => {
    document.querySelector(".mb-ctx")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await sleep(150);
  };
  const pop = () => {
    const el = document.querySelector<HTMLElement>(".t2s-pop");
    if (!el) return null;
    const grid = [...el.querySelectorAll<HTMLElement>(".t2s-grid > *")].map((x) => (x.querySelector("input") as HTMLInputElement | null)?.value ?? x.textContent?.replace(/\s+/g, " ").trim() ?? "");
    return {
      head: el.querySelector(".t2s-h")?.textContent ?? null,
      grid,
      agent: el.querySelector(".t2s-agent button.on")?.textContent ?? null,
      start: el.querySelector<HTMLButtonElement>(".t2s-foot button.primary")?.textContent ?? null,
      startDisabled: el.querySelector<HTMLButtonElement>(".t2s-foot button.primary")?.disabled ?? null,
      error: el.querySelector(".t2s-err")?.textContent ?? null,
      release: !!el.querySelector(".t2s-err button.link"),
      inWindow: (() => {
        const r = el.getBoundingClientRect();
        return r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight;
      })(),
    };
  };
  const starts = () => calls.filter((c) => c.fn === "houseStartSession").map((c) => c.args[1]);
  (async () => {
    const out: Record<string, unknown> = {};
    for (let i = 0; i < 100 && !card(146); i++) await sleep(50);
    await sleep(300);
    out.buttons = [146, 141, 151, 143].map((n) => !!card(n)?.querySelector(".house-start"));
    if (mode === "detail") {
      card(146)!.click();
      for (let i = 0; i < 60 && !document.querySelector(".house-acts button.primary"); i++) await sleep(50);
      out.detailButton = document.querySelector(".house-acts button.primary")?.textContent?.trim() ?? null;
      document.querySelector<HTMLElement>(".house-acts button.primary")!.click();
    } else {
      out.takenMenu = await menuOf(141);
      await closeMenu();
      out.menu = await menuOf(146);
      [...document.querySelectorAll<HTMLElement>(".mb-ctx button")].find((x) => x.textContent?.includes("Start session"))?.click();
    }
    for (let i = 0; i < 60 && !document.querySelector(".t2s-grid"); i++) await sleep(50);
    await sleep(100);
    out.pop = pop();
    if (mode !== "detail") {
      [...document.querySelectorAll<HTMLElement>(".t2s-agent button")].find((x) => x.textContent === "Codex")?.click();
      await sleep(50);
    }
    out.agentPicked = pop()?.agent ?? null;
    document.querySelector<HTMLElement>(".t2s-foot button.primary")?.click();
    await sleep(1200);
    out.after = {
      pop: pop(),
      board: !!document.querySelector(".house-modal"),
      starts: starts(),
      house: { claim: houseTickets[146].claim ? { by: houseTickets[146].claim!.by, branch: houseTickets[146].claim!.branch } : null, history: (houseHistory[146] ?? []).map((e) => e.kind) },
      session: sessions.filter((x) => x.title.startsWith("#146")).map((x) => ({ title: x.title, group: x.taskGroup, agent: x.agent })),
      shown: [...document.querySelectorAll(".ls-world .ls-node.selected")].some((n) => n.textContent?.includes("#146")),
    };
    const tag = document.createElement("script");
    tag.type = "application/json";
    tag.id = "mb-house-start-audit";
    tag.textContent = JSON.stringify(out).replace(/</g, "\\u003c");
    document.body.appendChild(tag);
  })();
}
// ?councilTicketsAudit reviews the approved plan's drafts as a person would — edits a title and tags, merges two,
// removes one, moves one up — then creates them, and writes what it saw into <script id="mb-council-tix-audit"> for
// test/uiCouncilTickets.test.ts: the rows after each step, the create button's label and whether it's enabled, and
// the create calls made (none before the click). =consent starts with the token not allowed; with ?councilTicketsFail
// the fixture House refuses the second ticket.
if (params.has("councilTicketsAudit")) {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const rows = () => [...document.querySelectorAll<HTMLElement>(".council-tix-row .t")].map((e) => e.textContent ?? "");
  const row = (i: number) => document.querySelectorAll<HTMLElement>(".council-tix-row")[i];
  const button = () => document.querySelector<HTMLButtonElement>(".council-tix-create");
  const creates = () => calls.filter((c) => c.fn === "collabCreateTickets").map((c) => (c.args[2] as TicketDraft[]).map((d) => ({ title: d.title, priority: d.priority, tags: d.tags })));
  const setText = (el: HTMLInputElement | HTMLTextAreaElement | null, text: string) => {
    if (!el) return;
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set?.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const toolbar = (label: RegExp) => [...document.querySelectorAll<HTMLButtonElement>(".council-tix-tools button")].find((b) => label.test(b.textContent ?? b.getAttribute("aria-label") ?? ""));
  const state = () => ({ rows: rows(), label: button()?.textContent ?? null, enabled: !!button() && !button()!.disabled, creates: creates().length });
  (async () => {
    const out: Record<string, unknown> = {};
    for (let i = 0; i < 100 && rows().length < 5; i++) await sleep(50);
    await sleep(300);
    out.start = state();
    if (params.get("councilTicketsAudit") === "consent") {
      out.consentAsk = document.querySelector(".council-tix-consent span")?.textContent ?? null;
      document.querySelector<HTMLButtonElement>(".council-tix-consent button.strong")?.click();
      await sleep(200);
      out.allowed = { ...state(), asking: !!document.querySelector(".council-tix-consent") };
    }
    // edit the third ticket's title and its tags
    row(2).click();
    await sleep(50);
    setText(document.querySelector<HTMLInputElement>("#ctx-title"), "Export button in the toolbar");
    setText(document.querySelector<HTMLInputElement>("#ctx-tags"), "needs-agent, frontend");
    await sleep(50);
    out.edited = { ...state(), tags: [...row(2).querySelectorAll(".chip.tag")].map((t) => t.textContent) };
    // merge the third and fourth
    row(2).querySelector<HTMLInputElement>("input")!.click();
    row(3).querySelector<HTMLInputElement>("input")!.click();
    await sleep(50);
    out.mergeLabel = toolbar(/^Merge/)?.textContent ?? null;
    toolbar(/^Merge/)?.click();
    await sleep(50);
    row(2).click();
    await sleep(50);
    out.merged = { ...state(), detail: document.querySelector<HTMLTextAreaElement>("#ctx-detail")?.value ?? null, acceptance: document.querySelector<HTMLTextAreaElement>("#ctx-acc")?.value ?? null };
    // remove the last, the spike
    row(3).click();
    await sleep(50);
    toolbar(/^Remove/)?.click();
    await sleep(50);
    out.removed = state();
    // move the merged one up
    row(2).click();
    await sleep(50);
    document.querySelector<HTMLButtonElement>('.council-tix-tools button[aria-label="Move up"]')?.click();
    await sleep(50);
    out.moved = state();
    // and create them
    button()?.click();
    await sleep(900);
    out.created = {
      ...state(),
      sent: creates(),
      result: document.querySelector<HTMLElement>(".council-tix-result")?.innerText.replace(/\s+/g, " ").trim() ?? null,
      links: [...document.querySelectorAll(".council-tix-made button.link")].map((b) => b.textContent),
      note: [...document.querySelectorAll(".collab-thread, .collab-body")].map((e) => e.textContent ?? "").join(" ").includes("Created "),
    };
    const tag = document.createElement("script");
    tag.type = "application/json";
    tag.id = "mb-council-tix-audit";
    tag.textContent = JSON.stringify(out).replace(/</g, "\\u003c");
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
// the grid's layout prefs as they were before the app ran: what checks that the landscape leaves them alone compare with
w.__mbPrefsAtLoad = Object.fromEntries([...Object.values(LEGACY_PREF_KEYS), "mb.wsOpen", "mb.collapsed", "mb.sideView"].map((k) => [k, localStorage.getItem(k)]));

// ---- wires: an empty book, changed by main's own rules (shared/wires.ts), on this file's sessions. Nothing here reaches a pane ----
import {
  carriesWork,
  createdAtAfter,
  emptyWireBook,
  finishPlan,
  isSending,
  newWire,
  parseWireSettings,
  templateOf,
  verdictRefusal,
  type FinishedStep,
  type FinishOutcome,
  type LatestMessage,
  type WireVerdict,
  rekeyedBook,
  rekeyRefusal,
  restoredWire,
  restoreRefusal,
  sameWire,
  settingsRefusal,
  wireRefusal,
  withSettings,
  withoutSession,
  type MergeView,
  type SendReply,
  type Wire,
  type WireBook,
  type WireContext,
  type WireReply,
  type WireSettings,
  type WireState,
  type WireType,
} from "../shared/wires";
let wireBook: WireBook = emptyWireBook();
if (wireBoard) wireBook = stripBoard ? stripBoardBook(stripBoard, now) : wireBoardBook(now);
else if (lsWiresQ !== null && manyQ) wireBook = manyWiresBook(sessions, Number(lsWiresQ) || 20, now);
/** Main's merge views (WireState.merges): the merge watch's, which nothing here runs. */
let wireMerges: Record<string, MergeView> = {};
if (lsGatesQ !== null) {
  wireBook = gateBoardBook(wireBook, now, lsGatesQ === "limit");
  wireMerges = gateMerges();
}
// ?lsHeldWaits (with ?lsWires): something waits at Reviewer → Tester's gate, blocked till Reviewer approves (wiresAudit.ts)
if (wireBoard && params.has("lsHeldWaits")) wireBook = heldWaitsBook(wireBook, now);
// W4a: ?landscapeWiresAudit=near|far|drag|area|pill works the wires drawn (wiresAudit.ts) for test/uiLandscapeWires.test.ts.
// W4c's parts have a finish arrive at a gate while its popover is open (`finish`), as finish_step's would, or what waits
// there sent from elsewhere (`sent`), as another window's Send would
if (params.has("landscapeWiresAudit"))
  runWiresAudit(
    {
      calls,
      waitFor,
      finish: (id, body) => {
        const w = wireBook.links[id];
        if (w) wireChanged(withLink(id, { ...w, pending: { id: `${w.pending?.id ?? "pd"}-again`, body, at: Date.now(), flags: [] } }));
      },
      sent: (id) => {
        const w = wireBook.links[id];
        if (!w?.pending) return;
        const { pending, ...rest } = w;
        wireChanged(withLink(id, { ...rest, delivery: { id: pending.id, state: "sent", at: Date.now() } }));
      },
    },
    params.get("landscapeWiresAudit") || "near"
  );
let wiresRev = 0;
const removedWires = new Map<string, Wire>();
const wireState = (): WireState => clone({ book: wireBook, refused: null, wiresRev, problems: [], ...(Object.keys(wireMerges).length ? { merges: wireMerges } : {}) });
/** The rules' view of this file's sessions: running ones, and closed ones (previous) as main's resumable. */
const wireEnds = (): Pick<WireContext, "end"> => ({
  end: (id) => {
    const s = sessions.find((x) => x.id === id) ?? previous.find((x) => x.id === id) ?? planned.find((x) => x.id === id);
    if (!s) return null;
    const running = sessions.includes(s as SessionInfo);
    return {
      id,
      title: s.ticketTitle ?? s.title,
      kind: s.shell ? "terminal" : "agent",
      debrief: !!s.debrief,
      tasks: s.role === "tasks",
      room: s.room?.roomId ?? null,
      takenOver: null,
      where: !running && s.planned ? "planned" : !running ? "closed" : s.status === "dead" ? "dead" : "running",
      placed: running || Object.hasOwn(landscape.workspaces, id) || Object.hasOwn(landscape.ghosts, id),
      folder: s.cwd,
      hooksSilent: !!s.hooksSilent,
      ticket: ticketOfSession(s),
      branch: s.branch,
    };
  },
});
/** A change made, as main makes one: counted and sent only when the book is different. */
const wireChanged = (book: WireBook, id?: string): WireReply => {
  if (book !== wireBook) {
    wireBook = book;
    wiresRev++;
    emit("onWiresChanged", wireState());
  }
  return { state: wireState(), ...(id ? { id } : {}) };
};
const wireSettings = (raw: unknown): { settings: WireSettings } | { refused: string } => {
  try {
    return { settings: parseWireSettings(raw) };
  } catch (e) {
    return { refused: (e as Error).message };
  }
};
const withLink = (id: string, w: Wire): WireBook => ({ ...wireBook, links: { ...wireBook.links, [id]: w } });
Object.assign(api, {
  wiresGet: async () => wireState(),
  wiresAdd: async (from: string, to: string, type: WireType, raw: unknown = {}): Promise<WireReply> => {
    const s = wireSettings(raw);
    if ("refused" in s) return s;
    const ctx = { ...wireEnds(), links: wireBook.links };
    const refused = wireRefusal(from, to, type, ctx) ?? settingsRefusal({ from, to, type }, s.settings, ctx);
    if (refused) return { refused };
    let id = Math.random().toString(16).slice(2, 10);
    while (Object.hasOwn(wireBook.links, id)) id = Math.random().toString(16).slice(2, 10);
    return wireChanged(withLink(id, withSettings(newWire(from, to, type, createdAtAfter(wireBook.links, Date.now())), s.settings)), id);
  },
  wiresSet: async (id: string, raw: unknown): Promise<WireReply> => {
    const s = wireSettings(raw);
    if ("refused" in s) return s;
    const w = Object.hasOwn(wireBook.links, id) ? wireBook.links[id] : undefined;
    if (!w) return { refused: `There's no wire ${JSON.stringify(id)}.` };
    const refused = settingsRefusal(w, s.settings, wireEnds());
    if (refused) return { refused };
    const next = withSettings(w, s.settings);
    return wireChanged(sameWire(next, w) ? wireBook : withLink(id, next));
  },
  wiresRemove: async (id: string): Promise<WireReply> => {
    const w = Object.hasOwn(wireBook.links, id) ? wireBook.links[id] : undefined;
    if (!w) return { refused: `There's no wire ${JSON.stringify(id)}.` };
    removedWires.set(id, w);
    const { [id]: _gone, ...links } = wireBook.links;
    return wireChanged({ ...wireBook, links }, id);
  },
  wiresRestore: async (id: string): Promise<WireReply> => {
    const w = removedWires.get(id);
    if (!w) return { refused: "That wire can't be restored any more." };
    const refused = restoreRefusal(wireBook, id, w, wireEnds());
    if (refused) return { refused };
    removedWires.delete(id);
    return wireChanged(withLink(id, restoredWire(w)), id);
  },
  wiresRekey: async (old: string, next: string): Promise<WireReply> => {
    if (old === next || (!Object.hasOwn(wireBook.notes, old) && !Object.values(wireBook.links).some((w) => w.from === old || w.to === old))) return wireChanged(wireBook);
    const moved = rekeyedBook(wireBook, old, next);
    const refused = rekeyRefusal(wireBook, moved, old, next, wireEnds());
    return refused ? { refused } : wireChanged(moved);
  },
  // W7, as main's WireService.addTerminal: refused before it starts when the wire couldn't be made, else a terminal in
  // the agent's folder and group, wired to it by a shared worktree wire
  wiresAddTerminal: async (id: string, as: { title?: string; command?: string } = {}) => {
    const s = byId(id);
    if (!s) return err("Session is no longer running");
    const ends = wireEnds();
    const agent = ends.end(id);
    const next = "\0terminal";
    const probe = agent && { ...agent, id: next, title: "its terminal", kind: "terminal" as const, debrief: false, tasks: false, where: "running" as const };
    const refused = wireRefusal(id, next, "worktree", { links: wireBook.links, end: (x) => (x === next ? probe : ends.end(x)) });
    if (refused) return err(refused);
    const made: SessionInfo = await api.createSession({ repoPath: s.repoPath, useWorktree: false, shell: true, title: as.title ?? `${s.ticketTitle ?? s.title} · terminal`, taskGroup: s.taskGroup ?? undefined });
    const t: SessionInfo = { ...made, cwd: s.cwd, repoPath: s.repoPath, branch: s.branch };
    sessions = sessions.map((x) => (x.id === t.id ? t : x));
    sessionsChanged();
    const r = await api.wiresAdd(id, t.id, "worktree");
    return "refused" in r ? err(r.refused) : t;
  },
  // a gate's acts, as main's delivery has them (wireDelivery.ts): checked, written ahead as queued, then sent a moment
  // later. Nothing reaches a pane; a stopped other end is "started" once the window says so
  wiresSend: (id: string, pendingId: string, body: string, opts?: { start?: boolean }) => gateSend(id, pendingId, body, opts, false),
  wiresSendAgain: (id: string, pendingId: string, body: string, opts?: { start?: boolean }) => gateSend(id, pendingId, body, opts, true),
  wiresMarkSent: async (id: string, pendingId: string): Promise<WireReply> => {
    const w = Object.hasOwn(wireBook.links, id) ? wireBook.links[id] : undefined;
    if (!w) return { refused: `There's no wire ${JSON.stringify(id)}.` };
    if (w.delivery?.id !== pendingId || w.delivery.state !== "unconfirmed") return { refused: "Only what may have reached the other end can be marked sent." };
    const { pending, ...rest } = w;
    return wireChanged(withLink(id, { ...rest, ...(pending && pending.id !== pendingId ? { pending } : {}), delivery: { ...w.delivery, state: "sent", at: Date.now(), why: "Marked sent by you." } }));
  },
  wiresMoreRounds: async (id: string): Promise<WireReply> => gateRounds(id, (r) => (r.used < r.limit ? "It has rounds left." : { limit: r.used + 1, used: r.used })),
  wiresResetRounds: async (id: string): Promise<WireReply> => gateRounds(id, (r) => ({ limit: r.limit, used: 0 })),
  // W5: a person's Finish step, as main's wires:finish has it (WireTools.finish, WireDelivery.offer): the verdict's rules,
  // the plan (finishPlan), what the verdict takes back taken, each wire that readies given its template with {summary}
  // filled in (the rest of a template stays as written: nothing here reads a diff or files), and the note written. Its
  // gates ask: nothing here sends by itself
  wiresFinish: async (id: string, summary: string, verdict?: WireVerdict): Promise<FinishOutcome> => {
    await later(null, FINISH_ANSWER_MS);
    // as main's: a person finishes a step between turns
    const s = byId(id);
    if (s?.status === "working") return { refused: `“${s.title}” is working: finish its step once its turn ends.` };
    if (s?.status === "waiting") return { refused: `“${s.title}” is waiting on you mid-turn: answer it, then finish its step once its turn ends.` };
    const text = String(summary ?? "").trim();
    if (!text) return { refused: "summary is empty: say what this step did." };
    if (!Object.values(wireBook.links).some((w) => w.from === id && carriesWork(w.type)))
      return { refused: "This workspace has no handoff or feedback wire out, so finishing its step readies nothing. Its summary is kept for any workspace that reads its context.", kept: true };
    const why = verdictRefusal(id, verdict, wireBook.links);
    if (why) return { refused: why };
    const ends = wireEnds();
    const links = { ...wireBook.links };
    const steps = finishPlan(id, verdict, { ...ends, links: wireBook.links }).map((step): FinishedStep => {
      const done: FinishedStep = { ...step, toTitle: ends.end(step.to)?.title ?? step.to };
      if (step.withdraws) {
        const { pending: _taken, ...rest } = links[step.wire];
        links[step.wire] = rest;
      }
      if (step.does !== "readies") return done;
      const pending = { id: `pd-finish-${++finishes}`, body: templateOf(links[step.wire]).split("{summary}").join(text), at: Date.now(), ...(verdict ? { verdict } : {}), flags: [] };
      links[step.wire] = { ...links[step.wire], pending };
      return { ...done, pending: { id: pending.id, flags: [] }, gate: "ask", went: { state: "ready" } };
    });
    const { verdict: _was, ...note } = Object.hasOwn(wireBook.notes, id) ? wireBook.notes[id] : { hops: 0 };
    wireChanged({ ...wireBook, links, notes: { ...wireBook.notes, [id]: { ...note, summary: { text, at: Date.now() }, ...(verdict ? { verdict } : {}) } } });
    return { steps, redacted: 0 };
  },
  // a session's latest message, whole, as main's wires:lastMessage reads it from its conversation: the board's Reviewer
  // has its review, the others none here
  wiresLastMessage: async (id: string): Promise<LatestMessage> => {
    await later(null, 200);
    if (Object.hasOwn(LATEST_MESSAGES, id)) return { text: LATEST_MESSAGES[id], at: Date.now() - 60_000 };
    return { text: null, at: null, why: "Mockingbird hasn't seen a conversation in it yet" };
  },
});
// ---- W9: pipeline templates, as main's templates:* calls (src/main/templates.ts, WireService.layOut) ----
/** settings.pipelineTemplates: ?lsTemplates' (boardTemplates; =broken: not a list), else none saved. */
let tplStore: unknown = params.has("lsTemplates") ? boardTemplates(params.get("lsTemplates")) : [];
/** ?lsLayOutFails=<n>: the first n lay-outs are refused, as main refuses one while the wires file is read-only. */
let layOutFails = Number(params.get("lsLayOutFails") ?? 0);
const tplWhy = (e: unknown) => (e instanceof Error ? e.message : String(e));
Object.assign(api, {
  templatesList: async () => readTemplates(tplStore),
  // main's draft: the chain's steps and their terminals, the wires among them, a ticket kickoff as {ticket}; nothing here
  // is secret, so nothing is redacted
  templatesDraft: async (ids: string[]) => {
    const known = (id: string) => byId(id) ?? previous.find((x) => x.id === id) ?? planned.find((x) => x.id === id);
    const agents = ids.map(known);
    if (agents.some((a) => !a)) return err("This Mac has no session in that chain any more.");
    const links = Object.values(wireBook.links);
    const terms = [...new Set(links.filter((w) => w.type === "worktree" && ids.includes(w.from) && !ids.includes(w.to)).map((w) => w.to))].flatMap((id) => (known(id)?.shell ? [known(id)!] : []));
    const all = [...(agents as SessionInfo[]), ...terms];
    const keyOf = new Map(all.map((x, i) => [x.id, `s${i + 1}`]));
    const unsaid: string[] = [];
    const steps: TemplateStep[] = all.map((x, i) => {
      const shares = x.shell ? links.find((w) => w.type === "worktree" && w.to === x.id)!.from : x.planned?.sharesWith ?? (agents as SessionInfo[]).slice(0, i).find((y) => !y.planned && !x.planned && y.cwd === x.cwd)?.id;
      if (!x.planned && !x.shell) unsaid.push(x.title);
      return {
        key: keyOf.get(x.id)!,
        name: x.title,
        agent: x.shell ? "terminal" : (x.agent ?? "claude"),
        ...(x.model && !x.shell ? { model: x.model } : {}),
        ...(x.effort && !x.shell ? { effort: x.effort } : {}),
        folder: shares && keyOf.has(shares) ? { sameAs: keyOf.get(shares)! } : x.planned ? (x.planned.worktree ? "new" : "checkout") : x.repoPath && x.cwd !== x.repoPath ? "new" : "checkout",
        prompt: kickoffAsTicket(x.planned?.prompt ?? "").text,
      };
    });
    const wires: TemplateWire[] = links
      .filter((w) => keyOf.has(w.from) && keyOf.has(w.to))
      .map((w) => ({
        from: keyOf.get(w.from)!,
        to: keyOf.get(w.to)!,
        type: w.type,
        ...(w.type === "handoff" || w.type === "feedback" ? { when: w.when, gate: w.gate } : {}),
        ...(w.template !== undefined ? { template: w.template } : {}),
        ...(w.files?.length ? { files: w.files } : {}),
        ...(w.rounds ? { rounds: w.rounds.limit } : {}),
      }));
    const body: TemplateBody = { startFirst: true, steps, wires };
    try {
      parseTemplateBody(body);
    } catch (e) {
      return err(`This chain can't be a template: ${tplWhy(e)}`);
    }
    const notes = unsaid.length
      ? [`What ${unsaid.map((t) => `“${t}”`).join(", ")} ${unsaid.length === 1 ? "was" : "were"} told as ${unsaid.length === 1 ? "it" : "they"} started isn't kept once running: say it here${terms.length ? `, and what ${terms.length === 1 ? "its terminal runs" : "each terminal runs"}` : ""}.`]
      : terms.length
        ? [`What ${terms.length === 1 ? "its terminal runs" : "its terminals run"} isn't kept: say it here.`]
        : [];
    return { name: (agents as SessionInfo[]).map((x) => x.title).join(" → ").slice(0, 60), body, notes } satisfies TemplateDraft;
  },
  templatesSave: async (name: string, body: unknown) => {
    const n = String(name ?? "").trim();
    if (!n) return err("Name the template.");
    const read = readTemplates(tplStore);
    if (read.broken) return err(read.broken);
    if ([...read.templates.map((t) => t.template.name), ...read.refused.flatMap((r) => (r.name ? [r.name] : []))].some((t) => t.toLowerCase() === n.toLowerCase()))
      return err(`There's a template called “${n}” already: name this one another way, or remove that one first.`);
    try {
      tplStore = [...(tplStore as unknown[]), { id: `tpl-${Date.now().toString(36)}`, name: n, savedAt: Date.now(), ...parseTemplateBody(body) }];
    } catch (e) {
      return err(`It can't be saved: ${tplWhy(e)}`);
    }
    return readTemplates(tplStore);
  },
  templatesRemove: async (id: string) => {
    const read = readTemplates(tplStore);
    if (read.broken) return err(read.broken);
    if (!Array.isArray(tplStore)) return err("That template isn't saved any more: there are no saved templates.");
    const at = tplStore.findIndex((v) => !!v && typeof v === "object" && (v as { id?: unknown }).id === id);
    if (at < 0) return err("That template isn't saved any more.");
    tplStore = tplStore.filter((_v, i) => i !== at);
    return readTemplates(tplStore);
  },
  // main's templates:setAside: a copy kept, said, and the list started empty; refused when the list reads fine
  templatesSetAside: async () => {
    if (!readTemplates(tplStore).broken) return err("The saved templates read as a list: there's nothing to set aside.");
    tplStore = [];
    return { file: "/Users/you/.mockingbird/pipelineTemplates-set-aside-2026-11-12T15-00-00-000Z.json", list: readTemplates([]) };
  },
  // as main's TemplateLayOuts: the area made (when the window sent one for an area that has none) before the lay-out,
  // and taken back, when it's as it was made, if the lay-out is refused
  templatesLayOut: async (req: LayOutRequest) => {
    const made = req.newArea && !Object.hasOwn(landscape.areas, req.area) ? req.area : null;
    if (made) {
      const r = await api.landscapeUpdate({ areas: { [made]: req.newArea } });
      if (r && "error" in r) return err(`Its area couldn't be made: ${r.error}`);
    }
    const as = made ? JSON.stringify(landscape.areas[made]) : null;
    const r = await api.previewLayOutNow(req);
    if (r && "error" in r) {
      if (made && JSON.stringify(landscape.areas[made]) === as) await api.landscapeUpdate({ areas: { [made]: null } });
      return r;
    }
    return { ...r, madeArea: !!made } satisfies LayOutReply;
  },
  // templatesLayOut's lay-out itself, once its area is made (the window never calls it), as main's WireService.layOut:
  // checked whole first, then the steps (not started), their wires, and the first step started when the template says
  // so, with what waited for it; a refusal once steps are made takes them all back
  previewLayOutNow: async (req: LayOutRequest) => {
    await startLag();
    if (layOutFails > 0) {
      layOutFails--;
      return err("landscape.json is read-only: wires can't be saved until it can be written");
    }
    let body: TemplateBody;
    try {
      body = parseTemplateBody(req.template);
    } catch (e) {
      return err(`“${req.name}” can't be laid out: ${tplWhy(e)}`);
    }
    const room = team.rooms.find((r) => r.groupKey === req.area)?.id ?? null;
    const plan = layOutPlan(body, { room: !!room, ticket: !!req.ticketId });
    if (plan.problems.length) return err(`“${req.name}” can't be laid out as it is: ${plan.problems.join(" ")}`);
    if (startsAtOrchestrator(body)) {
      if (!req.repoPath) return err(`“${body.steps[0].name}” works in a worktree of the ticket's repo on its branch: choose a repo.`);
      const first = body.steps[0];
      const id = `orch${Date.now().toString(36)}`;
      const o: SessionInfo = {
        ...session(id, { title: first.name, agent: first.agent as "claude" | "codex", role: "orchestrator", taskGroup: req.area, ticketId: req.ticketId ?? null, status: "working", createdAt: Date.now() }),
        repoPath: req.repoPath,
        cwd: WT(`${req.ticketId}-orchestrator`),
        branch: `${req.ticketId}-orchestrator`,
      };
      sessions = [...sessions, o];
      buffers[id] = `${C.dim}(UI preview: the Orchestrator would be told this)${C.reset}\r\n${orchestratorKickoff({ ticketId: String(req.ticketId), title: req.ticketTitle ?? "", description: req.ticketDescription ?? "", told: withTicket(first.prompt, ticketLine(req.ticketId, req.ticketTitle)), template: body }).replace(/\n/g, "\r\n")}\r\n> `;
      if (req.ticketId && !pipelines[req.ticketId]) {
        pipelineOf(req.ticketId).title = req.ticketTitle ?? undefined;
        pipelinesChanged();
      }
      sessionsChanged();
      return { steps: [{ key: first.key, id, title: first.name }], wires: [], started: id, notes: [`It reads #${req.ticketId} and proposes the rest as its plan, which comes to Needs you: nothing more is made until you lay it out.`] } satisfies LayOutReply;
    }
    if (!req.repoPath && body.steps.some((x) => x.folder === "new")) return err("Its steps work in worktrees of their own, which need a repo: choose one.");
    const steps: LayOutReply["steps"] = [];
    const idOf = new Map<string, string>();
    const undo = (why: string) => {
      const gone = new Set(steps.map((x) => x.id));
      planned = planned.filter((x) => !gone.has(x.id));
      wireBook = { ...wireBook, links: Object.fromEntries(Object.entries(wireBook.links).filter(([, w]) => !gone.has(w.from) && !gone.has(w.to))) };
      wiresRev++;
      emit("onWiresChanged", wireState());
      return err(`Couldn't lay out “${req.name}”: ${why}. Nothing was left.`);
    };
    const line = ticketLine(req.ticketId, req.ticketTitle);
    let n = 0;
    for (const p of plan.steps) {
      const st = p.step;
      if (st.agent === "terminal") continue;
      const id = `pl${Date.now().toString(36)}${n++}`;
      const shares = typeof st.folder === "object" ? planned.find((x) => x.id === idOf.get((st.folder as { sameAs: string }).sameAs)) : undefined;
      planned = [
        ...planned,
        {
          ...session(id, { title: st.name, agent: st.agent as "claude" | "codex", taskGroup: req.area, status: "idle", createdAt: Date.now(), branch: null, ...(req.ticketId ? { ticketId: req.ticketId } : {}) }),
          repoPath: shares ? shares.repoPath : req.repoPath,
          cwd: shares ? shares.cwd : (req.repoPath ?? "/Users/you"),
          ...(st.model ? { model: st.model } : {}),
          planned: { worktree: st.folder === "new", ...(shares ? { sharesWith: shares.id } : {}), ...(st.prompt.trim() ? { prompt: withTicket(st.prompt, line) } : {}) },
        },
      ];
      steps.push({ key: st.key, id, title: st.name });
      idOf.set(st.key, id);
    }
    const wires: string[] = [];
    for (const p of plan.wires) {
      if (p.skipped || p.afterStart) continue;
      const r: WireReply = await api.wiresAdd(idOf.get(p.wire.from), idOf.get(p.wire.to), p.wire.type, wireSettingsOf(p.wire, p.gate));
      if ("refused" in r) return undo(`${p.wire.from} → ${p.wire.to} was refused: ${r.refused}`);
      wires.push(r.id!);
    }
    sessionsChanged();
    const notes = [...(plan.forced ? [roomAsked(plan.forced)] : []), ...plan.steps.flatMap((p) => (p.terminal && !p.terminal.laid ? [`“${p.step.name}” ${p.terminal.why.replace(/^It /, "")}`] : []))];
    if (!body.startFirst) return { steps, wires, started: null, notes } satisfies LayOutReply;
    const first = plan.steps[0].step;
    const started = await api.previewStartPlanned(idOf.get(first.key)!);
    if (started && typeof started === "object" && "error" in started) return { steps, wires, started: null, notes: [...notes, `“${first.name}” didn't start: ${started.error}.`] } satisfies LayOutReply;
    for (const p of plan.wires) {
      if (!p.afterStart || p.skipped) continue;
      const to = body.steps.find((x) => x.key === p.wire.to)!;
      if (p.wire.type === "worktree") {
        const t = await api.wiresAddTerminal(started.id, { title: to.name, command: to.prompt });
        if (t && "error" in t) notes.push(`“${to.name}” wasn't made on “${first.name}”'s tree: ${t.error}`);
        else steps.push({ key: to.key, id: t.id, title: to.name });
        continue;
      }
      const r: WireReply = await api.wiresAdd(idOf.get(p.wire.from), idOf.get(p.wire.to), p.wire.type, wireSettingsOf(p.wire, p.gate));
      if ("refused" in r) notes.push(`${p.wire.from} → ${p.wire.to} wasn't made: ${r.refused}`);
      else wires.push(r.id!);
    }
    return { steps, wires, started: started.id, notes } satisfies LayOutReply;
  },
});
// ---- W17: the Orchestrators' plans, as main's plans:* calls (src/main/plans.ts) ----
// ?lsPlan (with ?lsWires): the wires board's area has an Orchestrator with a plan held for #5120 (planAudit.ts'
// boardPlan); =room shares that area as a team room's; =gone holds it and then lets it go, as a newer plan would;
// =council holds a Council's Orchestrator's plan instead, in the Council's own area on no ticket (councilPlan, W18).
const lsPlanQ = params.get("lsPlan");
const planOrch = wireBoard && lsPlanQ !== null ? (lsPlanQ === "council" ? councilPlan(session, WT, now) : boardPlan(session, WT, now)) : null;
if (planOrch && lsPlanQ === "council") councils[0].implementedIn = planOrch.orchestrator.id;
if (planOrch) {
  sessions.push(planOrch.orchestrator);
  const like = team.rooms.find((r) => r.admin === ME) ?? team.rooms[0];
  if (lsPlanQ === "room" && like && !team.rooms.some((r) => r.groupKey === WIRE_AREA)) team.rooms.push({ ...clone(like), id: "R5120ccccccccccccccccc", name: "#5120 Donor export", groupKey: WIRE_AREA });
}
let heldPlans: { id: string; from: string; at: number; replaces?: string; plan: Plan; notes?: string[] }[] = planOrch ? [planOrch.held] : [];
/** Why a plan id is gone, as main says it to a dialog still open on one. */
const spentPlans = new Map<string, string>();
const plansChanged = () => emit("onPlansChanged");
/** Main's view of a held plan: its Orchestrator, its area's other workspaces (each with why a plan can't name it), and whether it can be laid out now. */
function planView(h: (typeof heldPlans)[number]): PlanView | null {
  const me = byId(h.from);
  if (!me) return null;
  const area = (me.taskGroup ?? "").split("/")[0];
  const room = team.rooms.find((r) => r.groupKey === area)?.id ?? null;
  // a Council's area is named for it, not a work item: its Orchestrator is on no ticket
  const ticket = /^\d+$/.test(area) ? area : null;
  const endOf = (x: SessionInfo, refusal: string | null) => ({ id: x.id, title: x.ticketTitle ?? x.title, kind: x.shell ? ("terminal" as const) : ("agent" as const), agent: x.shell ? null : (x.agent ?? "claude"), repo: x.repoPath, branch: x.branch, ticket: x.ticketId ?? ticket, refusal });
  const existing = Object.fromEntries(
    [...sessions, ...previous, ...planned]
      .filter((x) => x.id !== me.id && (x.taskGroup ?? "").split("/")[0] === area)
      .map((x) => [x.id, endOf(x, x.debrief ? "it's a morning brief or wrap-up, which takes no wires." : x.role === "tasks" ? "it's the Helpdesk tasks workspace, which takes no wires." : null)])
  );
  const view: Omit<PlanView, "problem"> = {
    id: h.id,
    held: { from: h.from, ticket, at: h.at, ...(h.replaces ? { replaces: h.replaces } : {}), plan: clone(h.plan), ...(h.notes ? { notes: [...h.notes] } : {}) },
    me: endOf(me, null),
    ticketTitle: ticket ? (pipelines[ticket]?.title ?? "Stream the donor export") : null,
    council: councils.find((c) => c.implementedIn === me.id)?.title ?? null,
    area,
    room,
    existing,
    installed: ["claude", "codex"],
    repos: [...new Set([me.repoPath, ...Object.values(existing).map((e) => e.repo)].filter((r): r is string => !!r))],
    newer: newerAt !== null && viewingPlan === h.id ? { at: newerAt } : null,
  };
  let problem: string | null = null;
  try {
    checkPlan(h.plan, planCtx(view));
  } catch (e) {
    problem = tplWhy(e);
  }
  return { ...view, id: h.id, problem };
}
/** The plan the dialog says is open (plans:viewing), and when a newer one was proposed while it was (?lsPlan=newer). */
let viewingPlan: string | null = null;
let newerAt: number | null = null;
const planCtx = (v: Omit<PlanView, "problem">): PlanContext => ({ me: v.me, existing: v.existing, installed: v.installed, catalog: null, repos: v.repos, room: !!v.room, ticket: v.held.ticket });
if (lsPlanQ === "gone" && planOrch)
  setTimeout(() => {
    spentPlans.set(planOrch.held.id, "That plan was replaced by a newer one from “Orchestrator”: open that one instead.");
    heldPlans = [];
    plansChanged();
  }, 4000);
// ?lsPlan=roomgone: 5120 is a team room's area as the dialog opens, and stops being one a few seconds in (main doesn't
// call that a plan change, so the dialog still shows it as a room's)
if (lsPlanQ === "roomgone" && planOrch) {
  const like = team.rooms.find((r) => r.admin === ME) ?? team.rooms[0];
  if (like && !team.rooms.some((r) => r.groupKey === WIRE_AREA)) team.rooms.push({ ...clone(like), id: "R5120ccccccccccccccccc", name: "#5120 Donor export", groupKey: WIRE_AREA });
  setTimeout(() => void (team.rooms = team.rooms.filter((r) => r.groupKey !== WIRE_AREA)), 4000);
}
Object.assign(api, {
  plansList: async () => heldPlans.flatMap((h) => {
    const v = planView(h);
    return v ? [v] : [];
  }),
  // main's plans:viewing: a plan proposed while the dialog's open waits for it to close (?lsPlan=newer proposes one 2 s in)
  plansViewing: async (id: string | null) => {
    viewingPlan = id;
    if (id && lsPlanQ === "newer" && newerAt === null)
      setTimeout(() => {
        if (viewingPlan !== id) return;
        newerAt = Date.now();
        plansChanged();
      }, 2000);
    if (!id && newerAt !== null) {
      newerAt = null;
      plansChanged();
    }
  },
  // main's plans:layOut: read and checked again, then made once: the steps not started, their wires, the steps only the
  // Orchestrator hands off to started with their prompts, its handoffs counted sent
  plansLayOut: async (id: string, shownRaw: unknown, at: { area?: unknown; room?: unknown } | undefined): Promise<PlanLaidOut | { error: string }> => {
    await startLag();
    const h = heldPlans.find((x) => x.id === id);
    if (!h) return err(spentPlans.get(id) ?? "That plan isn't held any more: it was laid out, dismissed or replaced.");
    const v = planView(h);
    if (!v) return err("Its Orchestrator was forgotten, so its plan can't be laid out.");
    if (!at || at.area !== v.area || at.room !== v.room) {
      plansChanged();
      return err(
        `The plan can't be laid out as it was shown: ${at?.area !== v.area ? "its Orchestrator has moved to another area since the plan was shown, so its steps would go there" : !v.room ? "its area isn't a team room's any more, as it was when the plan was shown: its steps wouldn't be room sessions, and its gates would be as the plan says" : "its area has become a team room's since the plan was shown: its steps would start as room sessions, and every gate would ask"}. Reopen it to see where it would go now.`
      );
    }
    let shown: Plan;
    let layout;
    try {
      shown = readShownPlan(shownRaw);
      layout = checkPlan(shown, planCtx(v));
    } catch (e) {
      return err(`The plan can't be laid out: ${tplWhy(e)}`);
    }
    heldPlans = heldPlans.filter((x) => x.id !== id);
    spentPlans.set(id, "That plan was laid out already.");
    plansChanged();
    const me = byId(h.from)!;
    const steps: PlanLaidOut["steps"] = [];
    const idOf = new Map<string, string>();
    const endId = (k: string) => (k === PLAN_ME ? me.id : (idOf.get(k) ?? k));
    const line = ticketLine(v.held.ticket, v.ticketTitle);
    let n = 0;
    for (const p of layout.steps) {
      const st = p.step;
      if (st.agent === "terminal") continue;
      const sid = `pp${Date.now().toString(36)}${n++}`;
      const shares = st.folder === "orchestrator" ? me : typeof st.folder === "object" ? planned.find((x) => x.id === idOf.get((st.folder as { sameAs: string }).sameAs)) : undefined;
      planned = [
        ...planned,
        {
          ...session(sid, { title: st.name, agent: st.agent as "claude" | "codex", taskGroup: v.area, status: "idle", createdAt: Date.now(), branch: null, ticketId: v.held.ticket }),
          repoPath: shares ? shares.repoPath : (p.repo ?? me.repoPath),
          cwd: shares ? shares.cwd : (p.repo ?? me.repoPath ?? "/Users/you"),
          planned: { worktree: st.folder === "new", ...(shares ? { sharesWith: shares.id } : {}), prompt: withTicket(st.prompt, line) },
        },
      ];
      steps.push({ key: st.key, id: sid, title: st.name });
      idOf.set(st.key, sid);
    }
    const wires: string[] = [];
    const wireAt = new Map<number, string>();
    for (const [j, p] of layout.wires.entries()) {
      if (p.skipped || p.afterStart) continue;
      if (p.wire.type === "worktree") {
        const to = shown.steps.find((x) => x.key === p.wire.to)!;
        const t = await api.wiresAddTerminal(me.id, { title: to.name, command: to.prompt });
        if (t && "error" in t) return err(`Couldn't lay out the plan: “${to.name}” wasn't made: ${t.error}`);
        steps.push({ key: to.key, id: t.id, title: to.name });
        continue;
      }
      const r: WireReply = await api.wiresAdd(endId(p.wire.from), endId(p.wire.to), p.wire.type, { ...(p.wire.template?.trim() ? { template: p.wire.template } : {}), ...(p.wire.when ? { when: p.wire.when } : {}), ...(p.wire.type === "handoff" || p.wire.type === "feedback" ? { gate: p.gate } : {}), ...(p.wire.rounds ? { limit: p.wire.rounds } : {}) });
      if ("refused" in r) return err(`Couldn't lay out the plan: ${p.wire.from} → ${p.wire.to} was refused: ${r.refused}`);
      wires.push(r.id!);
      wireAt.set(j, r.id!);
    }
    sessionsChanged();
    const notes = layout.forced ? [`In a team room's area every gate asks, so ${layout.forced === 1 ? "its automatic gate was" : `its ${layout.forced} automatic gates were`} laid out asking.`] : [];
    let started: string | null = null;
    for (const p of layout.steps) {
      if (!p.starts) continue;
      const sid = idOf.get(p.step.key)!;
      const r = await api.previewStartPlanned(sid);
      if (r && typeof r === "object" && "error" in r) {
        notes.push(`“${p.step.name}” didn't start: ${r.error}.`);
        continue;
      }
      started ??= sid;
      for (const [j, w] of layout.wires.entries()) {
        const wid = wireAt.get(j);
        if (w.sentByLayOut && w.wire.to === p.step.key && wid) wireChanged(withLink(wid, { ...wireBook.links[wid], delivery: { id: `laid-${wid}`, state: "sent", at: Date.now(), why: `Lay out sent it: “${p.step.name}” started with its prompt from the plan.` } }));
        if (w.afterStart && !w.skipped && w.wire.from === p.step.key && w.wire.type !== "worktree") {
          const r2: WireReply = await api.wiresAdd(sid, endId(w.wire.to), w.wire.type, { ...(w.wire.when ? { when: w.wire.when } : {}), gate: w.gate });
          if ("refused" in r2) notes.push(`${p.step.name} → ${w.wire.to} wasn't made: ${r2.refused}`);
          else wires.push(r2.id!);
        }
      }
    }
    return { steps, wires, started, notes, area: v.area } satisfies PlanLaidOut;
  },
  // main's plans:dismiss: it goes, and its Orchestrator is told, with the note
  plansDismiss: async (id: string, note: string) => {
    const h = heldPlans.find((x) => x.id === id);
    if (!h) return err(spentPlans.get(id) ?? "That plan isn't held any more: it was laid out, dismissed or replaced.");
    heldPlans = heldPlans.filter((x) => x.id !== id);
    spentPlans.set(id, "That plan was dismissed.");
    plansChanged();
    const me = byId(h.from);
    return { told: me ? { to: me.id, title: me.title, told: note.trim() ? "delivered, with your note" : "delivered" } : { to: h.from, title: null, notTold: "Its Orchestrator isn't running, so it wasn't told." } };
  },
});
/** How long main takes to finish a step and answer. */
const FINISH_ANSWER_MS = 600;
let finishes = 0;
/** What the preview's sessions said last (wires:lastMessage). */
const LATEST_MESSAGES: Record<string, string> = {
  "wb-reviewer": "Two changes before merge:\n1. The stream is disposed before the response ends.\n2. The email column needs the DonorPII grant.",
  "wb-builder": "Streams the export instead of loading 40k rows; tests pass.",
};
/** How long main takes to write a send ahead and answer, and then for the other end's queue to take it. */
const GATE_ANSWER_MS = 1600;
const GATE_SENT_MS = 900;
async function gateSend(id: string, pendingId: string, body: string, opts: { start?: boolean } | undefined, again: boolean): Promise<SendReply> {
  await later(null, GATE_ANSWER_MS);
  const w = Object.hasOwn(wireBook.links, id) ? wireBook.links[id] : undefined;
  if (!w) return { refused: `There's no wire ${JSON.stringify(id)}.` };
  const b = wireEnds().end(w.to);
  const to = b ? `“${b.title}”` : "the other end";
  if (isSending(w)) return { refused: w.delivery!.id === pendingId ? `It's on its way to ${to} already.` : `Another message on this wire is still on its way to ${to}: send this once it has gone.` };
  if (!w.pending || w.pending.id !== pendingId) {
    if (w.delivery?.id === pendingId && (w.delivery.state === "sent" || w.delivery.state === "placed")) return { refused: `That was sent to ${to} already.` };
    return { refused: w.pending ? "What was waiting there has been replaced by something newer: send that instead." : "There's nothing waiting on this wire to send." };
  }
  const unconfirmed = w.delivery?.id === pendingId && w.delivery.state === "unconfirmed";
  if (!again && unconfirmed) return { refused: `It may have reached ${to} already: send it again, or mark it sent.` };
  if (again && !unconfirmed) return { refused: "Send again is for what may have reached the other end already: this one can simply be sent." };
  if (!body.trim()) return { refused: "There's nothing to send." };
  if (b && b.where !== "running" && b.where !== "planned" && !opts?.start) {
    const start = b.where === "dead" ? "resume" : "reopen";
    return { refused: `${to} isn't running: sending this ${start === "resume" ? "resumes" : "reopens"} it, which rereads its conversation.`, start };
  }
  // a step not started yet is started by the Send, with no cost to ask (main's startEnd)
  if (b?.where === "planned") {
    const started = await api.previewStartPlanned(w.to);
    if (started && typeof started === "object" && "error" in started) return { refused: `Couldn't start ${to}: ${started.error}` };
  }
  const sent = again ? `${pendingId}-sent` : pendingId;
  const counted = !again && w.delivery?.id === pendingId && w.delivery.state !== "held";
  const rounds = w.rounds && !counted ? { ...w.rounds, used: w.rounds.used + 1 } : w.rounds;
  wireChanged(withLink(id, { ...w, pending: { ...w.pending, id: sent, body }, delivery: { id: sent, state: "queued", at: Date.now(), attempt: `a-${sent}` }, ...(rounds ? { rounds } : {}) }));
  setTimeout(() => {
    const now = wireBook.links[id];
    if (now?.delivery?.id !== sent || now.delivery.state !== "queued") return;
    const { pending, ...rest } = now;
    wireChanged(withLink(id, { ...rest, ...(pending && pending.id !== sent ? { pending } : {}), delivery: { ...now.delivery, state: "sent", at: Date.now() } }));
  }, GATE_SENT_MS);
  return { state: wireState() };
}
function gateRounds(id: string, change: (r: NonNullable<Wire["rounds"]>) => NonNullable<Wire["rounds"]> | string): WireReply {
  const w = Object.hasOwn(wireBook.links, id) ? wireBook.links[id] : undefined;
  if (!w) return { refused: `There's no wire ${JSON.stringify(id)}.` };
  if (!w.rounds) return { refused: "Only a feedback wire counts rounds." };
  const next = change(w.rounds);
  if (typeof next === "string") return { refused: next };
  return wireChanged(next.limit === w.rounds.limit && next.used === w.rounds.used ? wireBook : withLink(id, { ...w, rounds: next }));
}
// Mark merged… readies the wires waiting on that pull request, flagged and held, as main's merge watch does once the user marks it
const markMergedBeforeWires = api.pipelinePrMarkMerged;
api.pipelinePrMarkMerged = async (ticket: string, url: string, asked: string) => {
  const r = await markMergedBeforeWires(ticket, url, asked);
  if (r && typeof r === "object" && "error" in r) return r;
  const pr = pipelines[ticket]?.prs.find((x) => x.url === url);
  for (const [id, w] of Object.entries(wireBook.links)) {
    const a = wireEnds().end(w.from);
    if (w.when !== "pr-merged" || !Object.hasOwn(wireMerges, id) || !pr || !a) continue;
    const { [id]: _was, ...rest } = wireMerges;
    wireMerges = rest;
    const flag = `You marked PR ${pr.id} to ${pr.target} merged: Mockingbird couldn't read it.`;
    wireChanged(withLink(id, { ...w, pending: { id: `pd-merge-${pr.id}`, body: `PR ${pr.id} to ${pr.target} (${pr.branch} → ${pr.base}) merged.\n\n“${a.title}” hasn't finished a step with a summary yet.`, at: Date.now(), flags: [flag] } }));
  }
  return r;
};
// a forgotten session's wires go with it, as main drops them at sessions:kill once the kill has gone through
const killSessionBeforeWires = api.killSession;
api.killSession = async (id: string, forget?: boolean) => {
  const r = await killSessionBeforeWires(id, forget);
  if (forget && !(r && typeof r === "object" && "error" in r)) {
    const { book, dropped } = withoutSession(wireBook, id);
    if (book !== wireBook) {
      wireBook = book;
      wiresRev++;
      emit("onWiresChanged", { ...wireState(), dropped: clone(dropped) });
    }
  }
  return r;
};
// W5: ?lsFinish=<session> (with ?lsWires; &lsVerdict=changes|approve) opens its Finish step from its right-click menu, for a screenshot
if (params.has("lsFinish")) openFinishShot(params.get("lsFinish")!, params.get("lsVerdict"), waitFor);
// W6, with ?wires=chain|fanout: &stripFolded starts with the pipeline strip folded away, as the pref has it after a fold;
// &stripMore opens its +n chip's list, for a screenshot
if (stripBoard && params.has("stripFolded")) localStorage.setItem("mb.pipelineStrip.folded", "true");
if (stripBoard && params.has("stripMore")) waitFor(".ls-strip-more", (el) => setTimeout(() => el.click(), 300));
