import { describe, expect, it, vi } from "vitest";
import type { PipelinePr, PipelineRequest, SessionInfo, TicketPipeline } from "../src/shared/types";
import type { JoinRequestSummary, TeamRoomSummary } from "../src/shared/team/types";
import { LOOSE_GROUP, areaKeyOf } from "../src/shared/landscape";
import { ROOMS_STARTING, newWire, type GateContext, type Wire, type WireEnd } from "../src/shared/wires";
import {
  DISMISS_KEEP_MS,
  KIND_LABEL,
  DISMISS_MAX,
  currentIndex,
  dismiss,
  dismissedFrom,
  goCan,
  namedSendRefusal,
  needsByArea,
  needsItems,
  needsLabel,
  planItems,
  selectionAfter,
  shownItems,
  stepItem,
  targetOf,
  undismiss,
  wireItems,
  type NeedsItem,
  type NeedsLast,
  type NeedsSel,
  type NeedsWires,
} from "../src/renderer/needsYouModel";
import { needsActions, TAKEN_BACK_WHY } from "../src/renderer/workspaceActions";
import type { PlanView } from "../src/shared/plans";

const MIN = 60_000;
const NOW = 1_800_000_000_000;
const sess = (id: string, over: Partial<SessionInfo> = {}): SessionInfo => ({
  id,
  title: id,
  repoPath: "/Users/you/Code/backoffice",
  cwd: "/Users/you/Code/backoffice",
  branch: null,
  ticketId: null,
  ticketTitle: null,
  taskGroup: "5101",
  status: "idle",
  createdAt: NOW - 90 * MIN,
  kind: "work",
  extraDirs: [],
  waitingReason: null,
  waitingSince: null,
  agent: "claude",
  ...over,
});
const roomTag = (over: Partial<NonNullable<SessionInfo["room"]>>): NonNullable<SessionInfo["room"]> => ({
  roomId: "R1",
  sessionId: "x",
  owner: "nick",
  ownerName: "Nick Smith",
  remote: false,
  online: true,
  live: true,
  lookers: [],
  cols: 80,
  rows: 24,
  git: null,
  repo: null,
  repoName: null,
  guards: { secrets: true, coauthors: true },
  ...over,
});
const room = (over: Partial<TeamRoomSummary> = {}): TeamRoomSummary =>
  ({ id: "R5101", name: "#5101 Org dropdowns", groupKey: "5101", members: [], online: [], signalingUrl: "", signaling: "online", ...over }) as TeamRoomSummary;
const request = (over: Partial<JoinRequestSummary> = {}): JoinRequestSummary => ({
  roomId: "R5101",
  id: "lee",
  name: "Lee Park",
  fingerprint: "a1b2",
  inviter: "sam",
  inviterName: "Sam",
  admin: "me",
  adminName: "You",
  role: "admin",
  state: "waiting",
  at: NOW - 3 * MIN,
  expiresAt: NOW + 6 * 24 * 60 * MIN,
  ...over,
});

/** The fixture the preview uses, give or take: a permission prompt, a question, two finished, a join request, and what never counts. */
const fixture = (): SessionInfo[] => [
  sess("perm", { status: "waiting", waitingReason: "Claude needs your permission to use Bash", waitingSince: NOW - 4 * MIN, title: "API: last org per user" }),
  sess("ask", { status: "waiting", waitingReason: "Claude has a question for you", waitingSince: NOW - 1 * MIN, taskGroup: "5102" }),
  sess("done", { status: "idle", finishedAt: NOW - 12 * MIN, title: "Release notes" }),
  sess("done2", { status: "idle", finishedAt: NOW - 2 * MIN, taskGroup: null }),
  sess("idle", { status: "idle" }), // started at its prompt: finished nothing
  sess("busy", { status: "working" }),
  sess("dead", { status: "dead", finishedAt: NOW - 5 * MIN }),
  sess("theirs", { status: "waiting", waitingReason: "Claude needs your permission to use Bash", waitingSince: NOW, room: roomTag({ remote: true }) }),
  sess("took", { status: "idle", finishedAt: NOW, room: roomTag({ takenOver: { by: "nick", byName: "Nick Smith", at: NOW } }) }),
  sess("brief", { status: "waiting", waitingReason: "Claude needs your permission to use Read", waitingSince: NOW, debrief: true }),
];
const items = (sessions = fixture(), asks: { request: JoinRequestSummary; room: TeamRoomSummary }[] = [{ request: request(), room: room() }]) =>
  needsItems(sessions, asks, areaKeyOf, (s) => s.title);

describe("what needs you", () => {
  it("lists a session's prompt or question, a join request and finished sessions, in that order, newest first within each", () => {
    const got = items();
    expect(got.map((i) => [i.kind, i.id])).toEqual([
      ["question", "s:ask"],
      ["permission", "s:perm"],
      ["join", "join:R5101:lee:" + (NOW - 3 * MIN)],
      ["finished", "s:done2"],
      ["finished", "s:done"],
    ]);
    expect(got.find((i) => i.id === "s:perm")).toMatchObject({ text: "API: last org per user wants to use Bash", code: "Bash", area: "5101", at: NOW - 4 * MIN, session: "perm" });
    expect(got.find((i) => i.id === "s:ask")).toMatchObject({ text: "ask: Claude has a question for you", code: null, area: "5102" });
    expect(got.find((i) => i.kind === "join")).toMatchObject({ text: "Lee Park wants to join #5101 Org dropdowns", area: "5101", session: null, join: { roomId: "R5101", key: `R5101:lee:${NOW - 3 * MIN}` } });
    expect(got.find((i) => i.id === "s:done")).toMatchObject({ text: "Release notes is done and idle", at: NOW - 12 * MIN });
    // a loose workspace's counts toward no area
    expect(got.find((i) => i.id === "s:done2")!.area).toBe(LOOSE_GROUP);
  });

  it("leaves out teammates' sessions, copies a teammate took over, morning briefs, and sessions working, exited or only idle", () => {
    const ids = items().map((i) => i.id);
    for (const id of ["theirs", "took", "brief", "busy", "dead", "idle"]) expect(ids).not.toContain(`s:${id}`);
  });

  it("leaves out join requests this install only passed on, and answered ones", () => {
    const asks = [
      { request: request({ role: "inviter" }), room: room() },
      { request: request({ id: "kim", state: "accepted" }), room: room() },
    ];
    expect(items([], asks)).toEqual([]);
  });

  it("counts each area's shown items for its badges", () => {
    const counts = needsByArea(items());
    expect(Object.fromEntries(counts)).toEqual({ "5101": 3, "5102": 1, [LOOSE_GROUP]: 1 });
  });

  it("lists a teammate's ask to type in one of this install's sessions with the prompts, one item per teammate asking", () => {
    const ask = (member: string, name: string, at: number) => ({ member, name, at });
    const sessions = [
      ...fixture(),
      sess("shared", { status: "working", title: "Release notes for #5101", room: roomTag({ typingAsks: [ask("nick", "Nick Smith", NOW - 2 * MIN), ask("sam", "Sam Lee", NOW - 30 * MIN)] }) }),
      // a teammate's copy and a copy a teammate took over have nothing to answer here
      sess("theirs2", { room: roomTag({ remote: true, typingAsks: [ask("nick", "Nick Smith", NOW)] }) }),
      sess("took2", { room: roomTag({ typingAsks: [ask("nick", "Nick Smith", NOW)], takenOver: { by: "nick", byName: "Nick Smith", at: NOW } }) }),
    ];
    const got = items(sessions);
    expect(got.map((i) => [i.kind, i.id])).toEqual([
      ["question", "s:ask"],
      ["typing", "type:shared:nick"],
      ["permission", "s:perm"],
      ["typing", "type:shared:sam"],
      ["join", "join:R5101:lee:" + (NOW - 3 * MIN)],
      ["finished", "s:done2"],
      ["finished", "s:done"],
    ]);
    expect(got.find((i) => i.id === "type:shared:nick")).toMatchObject({ text: "Nick wants to type in Release notes for #5101", session: "shared", typing: { member: "nick", name: "Nick Smith" }, at: NOW - 2 * MIN, area: "5101" });
    // asked again is a new item: a Dismiss holds only for the ask it was given to
    const again = items(sessions.map((s) => (s.id === "shared" ? { ...s, room: roomTag({ typingAsks: [ask("nick", "Nick Smith", NOW)] }) } : s)));
    expect(again.find((i) => i.id === "type:shared:nick")!.sig).not.toBe(got.find((i) => i.id === "type:shared:nick")!.sig);
  });

  it("says an ask to type into a terminal is one: a shell on your Mac, outside the room's sandbox", () => {
    const sessions = [sess("term", { status: "idle", shell: true, agent: undefined, title: "shared shell", room: roomTag({ typingAsks: [{ member: "nick", name: "Nick Smith", at: NOW }] }) })];
    expect(items(sessions).find((i) => i.id === "type:term:nick")).toMatchObject({ text: "Nick wants to type in shared shell, a terminal: a shell on your Mac, outside the room's sandbox" });
  });
});

describe("N and ⇧N", () => {
  const list = items();
  it("go to the next and previous item round the end, from the one the view is on", () => {
    const at = currentIndex(list, { session: "perm", area: null });
    expect(at).toBe(1);
    expect(stepItem(list, at, 1)!.id).toBe(list[2].id);
    expect(stepItem(list, at, -1)!.id).toBe("s:ask");
    expect(stepItem(list, list.length - 1, 1)!.id).toBe("s:ask"); // round the end
    expect(stepItem(list, 0, -1)!.id).toBe("s:done");
  });
  it("start from the first (N) or the last (⇧N) when the view is on none", () => {
    expect(currentIndex(list, { session: "busy", area: null })).toBe(-1);
    expect(stepItem(list, -1, 1)!.id).toBe("s:ask");
    expect(stepItem(list, -1, -1)!.id).toBe("s:done");
    expect(stepItem([], -1, 1)).toBeNull();
  });
  it("take a selected area with no session selected as being on its join request", () => {
    expect(list[currentIndex(list, { session: null, area: "5101" })].kind).toBe("join");
    expect(currentIndex(list, { session: null, area: "5102" })).toBe(-1);
  });
  /**
   * N pressed `times` from `sel`, as the window does it: the item the view is on from the selection and where N last
   * went (currentIndex), the next item (stepItem), and the selection going there leaves (selectionAfter).
   */
  const walk = (all: NeedsItem[], times: number, onLandscape: (area: string) => boolean, sel: NeedsSel = { session: null, area: null }, dir: 1 | -1 = 1) => {
    const seen: string[] = [];
    let last: NeedsLast | null = null;
    for (let i = 0; i < times; i++) {
      const next: NeedsItem = stepItem(all, currentIndex(all, sel, last), dir)!;
      seen.push(next.id);
      sel = selectionAfter(next, sel, onLandscape);
      last = { id: next.id, sel };
    }
    return seen;
  };
  it("walk the items in the tray's order, visiting each once before coming round, by the selection each leaves", () => {
    expect(walk(list, list.length + 1, () => true)).toEqual([...list.map((i) => i.id), list[0].id]);
    expect(walk(list, list.length, () => true, { session: null, area: null }, -1)).toEqual([...list].reverse().map((i) => i.id));
  });
  it("move on past two join requests for one room, which select the same area", () => {
    const two = items(fixture(), [{ request: request(), room: room() }, { request: request({ id: "kim", name: "Kim Lo", at: NOW - 2 * MIN }), room: room() }]);
    const joins = two.filter((i) => i.kind === "join").map((i) => i.id);
    expect(joins).toHaveLength(2);
    const seen = walk(two, two.length, () => true);
    expect(seen).toEqual(two.map((i) => i.id));
    expect(seen.filter((id) => joins.includes(id))).toEqual(joins);
  });
  it("move on past a join request whose room has no area on the landscape, which selects nothing", () => {
    expect(walk(list, list.length + 1, (area) => area !== "5101")).toEqual([...list.map((i) => i.id), list[0].id]);
  });
  it("go by the selection once it's changed since: N from a workspace picked meanwhile goes on from it", () => {
    const at = currentIndex(list, { session: "done", area: null }, { id: list[0].id, sel: { session: list[0].session, area: null } });
    expect(list[at].id).toBe("s:done");
    // N's place gone from the list (answered meanwhile): the selection says where the view is
    expect(currentIndex(list, { session: "perm", area: null }, { id: "s:gone", sel: { session: "perm", area: null } })).toBe(currentIndex(list, { session: "perm", area: null }));
  });
});

describe("Dismiss", () => {
  it("takes an item off until its state changes: a new prompt, another turn ending", () => {
    const sessions = fixture();
    const perm = items(sessions).find((i) => i.id === "s:perm")!;
    const done = items(sessions).find((i) => i.id === "s:done")!;
    let d = dismiss([], perm, NOW);
    d = dismiss(d, done, NOW);
    expect(shownItems(items(sessions), d).map((i) => i.id)).not.toEqual(expect.arrayContaining(["s:perm", "s:done"]));
    // the same states again: still dismissed
    expect(shownItems(items(fixture()), d).some((i) => i.id === "s:perm" || i.id === "s:done")).toBe(false);
    // a new prompt (it worked, and waits again) and another turn's end bring them back
    const later = fixture().map((s) =>
      s.id === "perm" ? { ...s, waitingSince: NOW + MIN, waitingReason: "Claude needs your permission to use Write" } : s.id === "done" ? { ...s, finishedAt: NOW + 2 * MIN } : s
    );
    expect(shownItems(items(later), d).map((i) => i.id)).toEqual(expect.arrayContaining(["s:perm", "s:done"]));
    // the same session finishing rather than waiting is a new state too
    const finished = fixture().map((s) => (s.id === "perm" ? { ...s, status: "idle" as const, waitingReason: null, waitingSince: null, finishedAt: NOW + MIN } : s));
    expect(shownItems(items(finished), d).some((i) => i.id === "s:perm")).toBe(true);
  });

  it("lets a second prompt worded like a dismissed one through: each prompt's own time tells them apart", () => {
    const sessions = fixture().map((s) => (s.id === "perm" ? { ...s, waitingAt: NOW - 4 * MIN } : s));
    const d = dismiss([], items(sessions).find((i) => i.id === "s:perm")!, NOW);
    // still waiting, the same words, a new prompt's event
    const again = sessions.map((s) => (s.id === "perm" ? { ...s, waitingAt: NOW - MIN } : s));
    const back = shownItems(items(again), d).find((i) => i.id === "s:perm");
    expect(back).toMatchObject({ text: "API: last org per user wants to use Bash", at: NOW - MIN });
  });

  it("is undone: the item listed again in the state it was dismissed in", () => {
    const perm = items().find((i) => i.id === "s:perm")!;
    const done = items().find((i) => i.id === "s:done")!;
    const d = undismiss(dismiss(dismiss([], perm, NOW), done, NOW), perm);
    expect(d.map((x) => x.sig)).toEqual([done.sig]);
    expect(shownItems(items(), d).some((i) => i.id === "s:perm")).toBe(true);
  });

  it("keeps the list short: the newest few hundred, none older than a few days", () => {
    const item = (n: number): NeedsItem => ({ id: `s:${n}`, sig: `s:${n}|f|${n}`, kind: "finished", at: n, area: "a", session: String(n), join: null, typing: null, pipeline: null, text: "", code: null });
    let d = dismiss([], item(0), NOW - DISMISS_KEEP_MS - 1);
    d = dismiss(d, item(1), NOW);
    expect(d.map((x) => x.sig)).toEqual(["s:1|f|1"]); // the old one let go
    for (let n = 2; n < DISMISS_MAX + 20; n++) d = dismiss(d, item(n), NOW);
    expect(d).toHaveLength(DISMISS_MAX);
    expect(d[0].sig).toBe(`s:${DISMISS_MAX + 19}|f|${DISMISS_MAX + 19}`);
    // dismissing one again moves it to the front, once
    d = dismiss(d, item(DISMISS_MAX + 5), NOW);
    expect(d.filter((x) => x.sig === `s:${DISMISS_MAX + 5}|f|${DISMISS_MAX + 5}`)).toHaveLength(1);
  });

  it("keeps a dismissal however old while its state is still current, so an unrelated Dismiss brings nothing back", () => {
    const item = (n: number): NeedsItem => ({ id: `s:${n}`, sig: `s:${n}|f|${n}`, kind: "finished", at: n, area: "a", session: String(n), join: null, typing: null, pipeline: null, text: "", code: null });
    const current = [item(0).sig, item(1).sig];
    let d = dismiss([], item(0), NOW - DISMISS_KEEP_MS - 1);
    d = dismiss(d, item(1), NOW, current);
    expect(shownItems([item(0), item(1)], d)).toEqual([]);
    // and with the list full, before any that's over
    for (let n = 2; n < DISMISS_MAX + 20; n++) d = dismiss(d, item(n), NOW, current);
    expect(d).toHaveLength(DISMISS_MAX);
    expect(shownItems([item(0), item(1)], d)).toEqual([]);
    // once its state has moved on it's let go like any other
    expect(dismiss(d, item(1), NOW, [item(1).sig]).map((x) => x.sig)).not.toContain(item(0).sig);
  });

  it("says a count of items in words that agree with it", () => {
    expect(needsLabel(1)).toBe("1 needs you");
    expect(needsLabel(2)).toBe("2 need you");
  });

  it("reads saved dismissals back, letting go of (and saying) what isn't one", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(dismissedFrom([{ sig: "a", at: 1 }, { sig: 2 }, null])).toEqual([{ sig: "a", at: 1 }]);
    expect(dismissedFrom("nope")).toEqual([]);
    expect(dismissedFrom(null)).toEqual([]);
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([expect.stringMatching(/2 saved Needs you dismissals weren't readable/), expect.stringMatching(/aren't a list/)]);
    warn.mockRestore();
  });
});

describe("Go there", () => {
  it("goes to the workspace as the sessions are now, or to a join request's room area", () => {
    const sessions = fixture();
    const list = items(sessions);
    const perm = list.find((i) => i.id === "s:perm")!;
    expect(targetOf(perm, sessions)).toEqual({ session: sessions[0] });
    expect(targetOf(list.find((i) => i.kind === "join")!, sessions)).toEqual({ area: "5101", roomId: "R5101", requestKey: `R5101:lee:${NOW - 3 * MIN}` });
    expect(targetOf(perm, sessions.slice(1))).toEqual({ no: "That session isn't running any more" });
  });

  it("is off, saying why, for a copy a teammate took over since, as every other action of a taken-over copy is", () => {
    const sessions = fixture();
    const perm = items(sessions).find((i) => i.id === "s:perm")!;
    const took = sessions.map((s) => (s.id === "perm" ? { ...s, room: roomTag({ takenOver: { by: "nick", byName: "Nick Smith", at: NOW } }) } : s));
    expect(targetOf(perm, took)).toEqual({ no: "Nick Smith continues it on their laptop: take it back to answer it here" });
    const back = sessions.map((s) => (s.id === "perm" ? { ...s, room: roomTag({ takenOver: { by: "nick", byName: "Nick Smith", at: NOW, back: true } }) } : s));
    expect(targetOf(perm, back)).toEqual({ no: TAKEN_BACK_WHY });
  });

  it("is the item's actions' row, with Dismiss, from the one action model", () => {
    const go = vi.fn();
    const off = vi.fn();
    const sessions = fixture();
    const perm = items(sessions).find((i) => i.id === "s:perm")!;
    const rows = needsActions({ go: goCan(targetOf(perm, sessions), go), goTitle: "Bring it into view", dismiss: off });
    expect(rows.map((r) => [r.key, r.label, !!r.disabled, !!r.primary])).toEqual([
      ["go", "Go there", false, true],
      ["dismiss", "Dismiss", false, false],
    ]);
    expect(rows[0].title).toBe("Bring it into view");
    rows[0].onPick();
    expect(go).toHaveBeenCalledWith({ session: sessions[0] });
    rows[1].onPick();
    expect(off).toHaveBeenCalled();
    // gone: Go there stays, off with the reason, and does nothing
    const gone = needsActions({ go: goCan(targetOf(perm, []), go), goTitle: "Bring it into view", dismiss: off });
    expect(gone[0]).toMatchObject({ key: "go", disabled: true, title: "That session isn't running any more" });
    gone[0].onPick();
    expect(go).toHaveBeenCalledTimes(1);
  });

  it("answers a typing ask from its row: Go there first and main, then Allow for 15 min and Deny, each main's call", async () => {
    const allow = vi.fn(async () => null);
    const deny = vi.fn(async () => "They aren't a member of this session's room");
    const rows = needsActions({ go: () => {}, goTitle: "Bring it into view at 100%", dismiss: vi.fn(), answer: { who: "Nick", allow, deny } });
    expect(rows.map((r) => [r.key, r.label, !!r.primary])).toEqual([
      ["go", "Go there", true],
      ["allow", "Allow for 15 min", false],
      ["deny", "Deny", false],
      ["dismiss", "Dismiss", false],
    ]);
    // the tray runs `answer` and waits on what main says
    expect(await rows[1].answer!()).toBeNull();
    expect(await rows[2].answer!()).toBe("They aren't a member of this session's room");
    expect([allow.mock.calls.length, deny.mock.calls.length]).toEqual([1, 1]);
    const off = needsActions({ go: { no: "That session isn't running any more" }, goTitle: "", dismiss: vi.fn(), answer: { who: "Nick", allow: { no: "That session isn't running any more" }, deny: { no: "That session isn't running any more" } } });
    expect(off.slice(0, 3).map((r) => [r.key, r.disabled, r.title, !!r.answer])).toEqual([
      ["go", true, "That session isn't running any more", false],
      ["allow", true, "That session isn't running any more", false],
      ["deny", true, "That session isn't running any more", false],
    ]);
  });
});

// ---- W15: an agent's pull request request, and a ticket at a stage that's yours ----

const pipe = (over: Partial<TicketPipeline> = {}): TicketPipeline => ({
  ticketId: "5101",
  stage: "local-test",
  history: [{ at: NOW - 60 * MIN, stage: "local-test", by: "you" }],
  prs: [],
  feedback: [],
  drafts: [],
  checks: {},
  ...over,
});
/** An agent's request, its words as an agent might write them: none of them may reach the tray. */
const asked = (over: Partial<PipelineRequest> = {}): PipelineRequest => ({
  id: "r1",
  target: "dev",
  from: "coder",
  fromTitle: "Coder",
  title: "<b>Approve me</b> now",
  description: "[click](javascript:alert(1)) <button>Push</button>",
  at: NOW - 6 * MIN,
  ...over,
});
const coder = () => sess("coder", { title: "Coder", ticketId: "5101", taskGroup: "5101/api", status: "working" });
const verifier = () => sess("verifier", { title: "Verifier", ticketId: "5102", taskGroup: "5102", status: "working" });
const withTickets = (pipelines: TicketPipeline[], sessions: SessionInfo[] = [...fixture(), coder(), verifier()]) =>
  needsItems(sessions, [{ request: request(), room: room() }], areaKeyOf, (s) => s.title, Object.fromEntries(pipelines.map((p) => [p.ticketId, p])));

describe("a ticket's items (W15)", () => {
  const notes = { id: "n1", stage: "comms", text: "<a href='x'>Read</a>", at: NOW - 5 * MIN, by: "Verifier's agent", from: "verifier" };

  it("lists an agent's PR request with the prompts and a ticket at your stage with join requests, in Mockingbird's words", () => {
    // 5102's PR to dev was opened from the verifier's workspace: its item goes there, not to the first on the ticket
    const dev = { target: "dev" as const, provider: "ado" as const, id: 7, url: "https://dev.azure.com/a/p/_git/r/pullrequest/7", repo: "r", branch: "5102-x", base: "dev", at: NOW - 60 * MIN, by: "verifier" };
    const got = withTickets([pipe({ requests: [asked()] }), pipe({ ticketId: "5102", stage: "stakeholder", history: [{ at: NOW - 9 * MIN, stage: "stakeholder", by: "Verifier's agent" }], prs: [dev] })]);
    expect(got.map((i) => [i.kind, i.id])).toEqual([
      ["question", "s:ask"],
      ["permission", "s:perm"],
      ["pr", "pr:5101:dev"],
      ["join", "join:R5101:lee:" + (NOW - 3 * MIN)],
      ["ticket", "ticket:5102"],
      ["finished", "s:done2"],
      ["finished", "s:done"],
    ]);
    // the one that asked is where N goes, its area the count's; the ticket's item goes to its session there
    expect(got.find((i) => i.kind === "pr")).toEqual({
      id: "pr:5101:dev",
      sig: "pr:5101:r1",
      kind: "pr",
      at: NOW - 6 * MIN,
      area: "5101",
      session: "coder",
      join: null,
      typing: null,
      pipeline: { ticket: "5101", request: "r1" },
      text: "Coder asks to open the PR to dev · #5101",
      code: null,
    });
    expect(got.find((i) => i.kind === "ticket")).toMatchObject({ text: "#5102 is ready for your stakeholder testing", session: "verifier", area: "5102", at: NOW - 9 * MIN, pipeline: { ticket: "5102", request: null } });
    // the agent's title, description and notes never: they're shown in the form Open opens, marked as the agent's
    for (const i of got) expect(i.text).not.toMatch(/Approve me|javascript|<|Read/);
  });

  it("says patch notes are drafted only for an agent's, at the stages they're written at", () => {
    const at = (stage: string, drafts: TicketPipeline["drafts"]) => withTickets([pipe({ ticketId: "5102", stage, drafts })]).filter((i) => i.kind === "ticket");
    expect(at("comms", [notes])).toEqual([expect.objectContaining({ id: "ticket:5102", sig: "ticket:5102|notes|n1", text: "#5102's patch notes are drafted", at: NOW - 5 * MIN, session: "verifier" })]);
    expect(at("prod-test", [notes])).toHaveLength(1);
    // the user's own, one they've edited (an edit drops who drafted it), and an agent's left behind at Coding: none
    expect(at("comms", [{ ...notes, by: undefined, from: undefined }])).toEqual([]);
    expect(at("coding", [notes])).toEqual([]);
    expect(at("comms", [])).toEqual([]);
  });

  it("is a new state for a newer request, and for the ticket coming back to your stage, so a Dismiss lets those through", () => {
    const one = withTickets([pipe({ requests: [asked()] })]).find((i) => i.kind === "pr")!;
    const newer = withTickets([pipe({ requests: [asked({ id: "r2", at: NOW })] })]).find((i) => i.kind === "pr")!;
    expect([newer.id, newer.sig === one.sig]).toEqual([one.id, false]);
    const back = (at: number) => withTickets([pipe({ ticketId: "5102", stage: "stakeholder", history: [{ at, stage: "stakeholder" }] })]).find((i) => i.kind === "ticket")!;
    expect(back(NOW - 9 * MIN).sig).not.toBe(back(NOW).sig);
  });

  it("goes to another of this install's workspaces on the ticket when the one that asked has gone, and to none when there's none", () => {
    const sessions = [sess("other", { title: "Other", ticketId: "5101" }), sess("theirs", { ticketId: "5101", room: roomTag({ remote: true }) })];
    const gone = withTickets([pipe({ requests: [asked()] })], sessions).find((i) => i.kind === "pr")!;
    expect([gone.session, gone.area, gone.text]).toEqual(["other", "5101", "Coder asks to open the PR to dev · #5101"]);
    // a teammate's copy or one a teammate took over is never where it goes
    const none = withTickets([pipe({ requests: [asked()] })], [sessions[1], sess("took", { ticketId: "5101", room: roomTag({ takenOver: { by: "nick", byName: "Nick Smith", at: NOW } }) })]).find((i) => i.kind === "pr")!;
    expect([none.session, none.area]).toEqual([null, "5101"]);
    expect(targetOf(none, sessions)).toEqual({ no: "No workspace on #5101 is open here: Open shows its pipeline" });
    expect(targetOf(gone, sessions)).toEqual({ session: sessions[0] });
  });

  it("is Open, the main action, and a request's Dismiss… for a note, from the one action model: each only what it's given", () => {
    const open = vi.fn();
    const dismissRequest = vi.fn();
    const dismiss = vi.fn();
    const go = vi.fn();
    const rows = needsActions({ go, goTitle: "", dismiss, open: { can: open, title: "Open the pull request form" }, dismissRequest });
    expect(rows.map((r) => [r.key, r.label, !!r.primary, !!r.disabled, !!r.answer])).toEqual([
      ["open", "Open", true, false, false],
      ["dismissRequest", "Dismiss…", false, false, false],
    ]);
    rows[0].onPick();
    rows[1].onPick();
    expect([open.mock.calls.length, dismissRequest.mock.calls.length, dismiss.mock.calls.length, go.mock.calls.length]).toEqual([1, 1, 0, 0]);
    // a ticket's: Open and the tray's own Dismiss; Open off, saying why, when it can't open
    const ticket = needsActions({ go, goTitle: "", dismiss, open: { can: { no: "The pipelines couldn't be read" }, title: "Open #5102's pipeline" } });
    expect(ticket.map((r) => [r.key, r.label, !!r.disabled])).toEqual([
      ["open", "Open", true],
      ["dismiss", "Dismiss", false],
    ]);
    expect(ticket[0].title).toBe("The pipelines couldn't be read");
  });
});

// ---- W5: a wire's gate and a pull request Mockingbird can't follow, in Needs you ----

/** One end of a wire as the rules see it: running, of this Mac's, unless `over` says otherwise. */
const end = (id: string, over: Partial<WireEnd> = {}): WireEnd => ({ id, title: id[0].toUpperCase() + id.slice(1), kind: "agent", debrief: false, room: null, takenOver: null, where: "running", placed: true, folder: `/wt/${id}`, hooksSilent: false, ...over });
const gateCtx = (links: Record<string, Wire>, ends: Record<string, Partial<WireEnd>> = {}, more: Partial<GateContext> = {}): GateContext => {
  const all: Record<string, WireEnd> = Object.fromEntries(["reviewer", "builder", "tester", "spike"].map((id) => [id, end(id, ends[id])]));
  return { end: (id) => all[id] ?? null, links, notes: {}, fileRefusal: null, ...more };
};
const pending = (id: string, at = NOW - 2 * MIN) => ({ id, body: "1. The stream disposes early.", at, flags: [] });
const link = (from: string, to: string, type: Wire["type"], over: Partial<Wire> = {}): Wire => ({ ...newWire(from, to, type, NOW - 60 * MIN), ...over });
/** Every end on the landscape, as a running workspace of this install's in area 5120, but spike's (a ghost) and tester's (closed, no place). */
const placeAll = (id: string) => (id === "spike" ? { session: null, area: "5120" } : id === "tester" ? null : { session: id, area: "5120" });
const wiresOf = (links: Record<string, Wire>, ends: Record<string, Partial<WireEnd>> = {}, more: Partial<GateContext> = {}): NeedsWires => ({ ctx: gateCtx(links, ends, more), place: placeAll });

describe("a wire's item (W5)", () => {
  it("is there while its gate waits on you: ready, at its limit, may have arrived, or blocked with something waiting", () => {
    const links: Record<string, Wire> = {
      loop: link("reviewer", "builder", "feedback", { rounds: { limit: 3, used: 1 }, pending: pending("p-loop") }),
      ghost: link("builder", "spike", "handoff", { pending: pending("p-ghost", NOW - 5 * MIN) }),
      limit: link("builder", "tester", "feedback", { rounds: { limit: 3, used: 3 }, pending: pending("p-limit", NOW - 7 * MIN) }),
      unsure: link("reviewer", "spike", "handoff", { pending: pending("p-unsure"), delivery: { id: "p-unsure", state: "unconfirmed", at: NOW - 9 * MIN, why: "It may have reached “Spike”." } }),
    };
    const got = wireItems(wiresOf(links, { spike: { where: "closed" } }));
    // in the order the wires were made (the same here: then by id), as needsItems sorts them by rank and time after
    expect(got.map((i) => [i.id, i.sig, i.label, i.text, i.wire?.face, i.session, i.area, i.at])).toEqual([
      ["wire:ghost", "wire:ghost|p-ghost|ready", "Wire ready", "Builder → Spike: ready to send (sending reopens it)", "ready", "builder", "5120", NOW - 5 * MIN],
      ["wire:limit", "wire:limit|p-limit|limit", "Wire at its limit", "Builder → Tester: at its limit, 3 of 3 rounds", "limit", "builder", "5120", NOW - 7 * MIN],
      ["wire:loop", "wire:loop|p-loop|ready", "Wire ready", "Reviewer → Builder: ready to send (round 2 of 3)", "ready", "reviewer", "5120", NOW - 2 * MIN],
      ["wire:unsure", "wire:unsure|p-unsure|unconfirmed", "Wire may have arrived", "Reviewer → Spike: it may have arrived", "unconfirmed", "reviewer", "5120", NOW - 9 * MIN],
    ]);
    // blocked with something waiting: its other end's hooks silent; and something on its way to one whose hooks are silent
    const silent = { builder: { hooksSilent: true } };
    const held = wireItems(wiresOf({ h: link("reviewer", "builder", "handoff", { pending: pending("p-h") }) }, silent));
    expect(held.map((i) => [i.id, i.label, i.text, i.wire?.face])).toEqual([["wire:h", "Wire blocked", "Reviewer → Builder: hooks not reporting", "blocked"]]);
    const stuck = wireItems(wiresOf({ q: link("reviewer", "builder", "handoff", { pending: pending("p-q"), delivery: { id: "p-q", state: "queued", at: NOW } }) }, silent));
    expect(stuck.map((i) => [i.id, i.sig, i.wire?.face])).toEqual([["wire:q", "wire:q|p-q|blocked", "blocked"]]);
  });

  it("isn't there while nothing of its waits on you: idle, on its way, sent, held for approve, waiting on its pull request, or carrying no work", () => {
    const links: Record<string, Wire> = {
      idle: link("reviewer", "spike", "handoff"),
      going: link("builder", "spike", "handoff", { pending: pending("p-go"), delivery: { id: "p-go", state: "queued", at: NOW } }),
      sent: link("tester", "spike", "handoff", { delivery: { id: "p-s", state: "sent", at: NOW } }),
      approve: link("reviewer", "tester", "handoff"),
      fb: link("reviewer", "builder", "feedback", { rounds: { limit: 3, used: 0 } }),
      merge: link("builder", "tester", "handoff", { when: "pr-merged", since: NOW - 60 * MIN }),
      context: link("builder", "reviewer", "context"),
    };
    const ctx = gateCtx(links, {}, { notes: { reviewer: { hops: 0, verdict: "changes" } }, mergeView: (w) => (w === links.merge ? { blocked: "Can't tell whether PR 11 to dev merged (3 tries): 503." } : null) });
    expect(wireItems({ ctx, place: (id) => ({ session: id, area: "5120" }) })).toEqual([]);
  });

  it("is a new state for each pending, so a Dismiss lets a newer finish through", () => {
    const at = (id: string) => wireItems(wiresOf({ loop: link("reviewer", "builder", "feedback", { rounds: { limit: 3, used: 1 }, pending: pending(id) }) }))[0];
    expect(at("p1").id).toBe(at("p2").id);
    expect(at("p1").sig).not.toBe(at("p2").sig);
    expect(shownItems([at("p2")], dismiss([], at("p1"), NOW))).toHaveLength(1);
  });

  it("is a new state when the same pending goes from blocked to ready, so Send there is a new row and a Dismiss of the block lets it through", () => {
    const loop = { loop: link("reviewer", "builder", "feedback", { rounds: { limit: 3, used: 1 }, pending: pending("p") }) };
    const blocked = wireItems(wiresOf(loop, { builder: { hooksSilent: true } }))[0];
    const ready = wireItems(wiresOf(loop))[0];
    expect([blocked.wire?.face, ready.wire?.face, blocked.wire?.pending, ready.wire?.pending]).toEqual(["blocked", "ready", "p", "p"]);
    expect(blocked.sig).not.toBe(ready.sig);
    expect(shownItems([ready], dismiss([], blocked, NOW))).toEqual([ready]);
  });

  it("leaves out a wire an end of which a teammate took over, and one blocked only for what's everyone's: the book unsaved, rooms starting", () => {
    const loop = { loop: link("reviewer", "builder", "feedback", { rounds: { limit: 3, used: 1 }, pending: pending("p") }) };
    expect(wireItems(wiresOf(loop, { builder: { takenOver: "Nick continues “Builder” on their laptop." } }))).toEqual([]);
    expect(wireItems(wiresOf(loop, {}, { fileRefusal: "landscape.json can't be written: disk full." }))).toEqual([]);
    expect(wireItems(wiresOf(loop, {}, { roomsUnknown: ROOMS_STARTING }))).toEqual([]);
  });

  it("goes to its source, else its other end, else where it's drawn; a wire with neither end on the landscape has none", () => {
    const from = (to: string, place: NeedsWires["place"]) => wireItems({ ctx: gateCtx({ w: link("spike", to, "handoff", { pending: pending("p") }) }), place })[0] ?? null;
    // spike is a ghost: Builder, the other end, is where Go there and N go
    expect([from("builder", placeAll)?.session, from("builder", placeAll)?.area]).toEqual(["builder", "5120"]);
    // both ends drawn but neither a running workspace of this install's: counted in the source's area, nowhere to go
    const ghostly = from("builder", (id) => ({ session: null, area: id === "spike" ? "5120" : "5101" }));
    expect([ghostly?.session, ghostly?.area]).toEqual([null, "5120"]);
    expect(targetOf(ghostly!, [])).toEqual({ no: "Neither end of that wire is a running workspace here: Show has its gate" });
    expect(from("builder", () => null)).toBeNull();
  });

  it("ranks with the prompts, and lists beside a ticket's items without taking their place", () => {
    const wires = wiresOf({ loop: link("reviewer", "builder", "feedback", { rounds: { limit: 3, used: 1 }, pending: pending("p", NOW - 30 * MIN) }) });
    const got = needsItems([...fixture(), coder()], [], areaKeyOf, (s) => s.title, { "5101": pipe({ requests: [asked()] }) }, wires);
    expect(got.map((i) => i.kind)).toEqual(["question", "permission", "pr", "wire", "finished", "finished"]);
  });
});

describe("a wire item's Send (W5)", () => {
  const item = { wire: { id: "loop", pending: "p1", face: "ready" as const } };
  const w = (over: Partial<Wire> = {}) => link("reviewer", "builder", "feedback", { rounds: { limit: 3, used: 1 }, pending: pending("p1"), ...over });

  it("sends only the pending the item named, while it still waits", () => {
    expect(namedSendRefusal(item, w())).toBeNull();
    // a newer finish replaced it: what's there now wasn't what was shown
    expect(namedSendRefusal(item, w({ pending: pending("p2") }))).toBe("What waits there now is newer than what you were shown: nothing was sent.");
    expect(namedSendRefusal(item, w({ pending: undefined, delivery: { id: "p1", state: "sent", at: NOW } }))).toBe("What waited there has gone: it was sent, or taken back.");
    expect(namedSendRefusal(item, w({ delivery: { id: "p1", state: "queued", at: NOW } }))).toBe("It's on its way already.");
    expect(namedSendRefusal(item, undefined)).toBe("That wire has gone.");
    expect(namedSendRefusal({ wire: null }, w())).toBe("It isn't a wire's item.");
  });

  it("is Send and Show while it's ready, Send an answer the tray takes only from a pointer; Show alone otherwise", async () => {
    const send = vi.fn(async () => null);
    const show = vi.fn();
    const dismissIt = vi.fn();
    const ready = needsActions({ go: vi.fn<() => void>(), goTitle: "", dismiss: dismissIt, wire: { send, show } });
    expect(ready.map((r) => [r.key, r.label, !!r.primary, !!r.answer])).toEqual([
      ["send", "Send", true, true],
      ["show", "Show", false, false],
      ["dismiss", "Dismiss", false, false],
    ]);
    await ready[0].answer!();
    ready[1].onPick();
    expect([send.mock.calls.length, show.mock.calls.length, dismissIt.mock.calls.length]).toEqual([1, 1, 0]);
    const other = needsActions({ go: vi.fn<() => void>(), goTitle: "", dismiss: dismissIt, wire: { send: null, show } });
    expect(other.map((r) => [r.key, !!r.primary])).toEqual([
      ["show", true],
      ["dismiss", false],
    ]);
  });
});

describe("a pull request's item (W16 in Needs you)", () => {
  const URL11 = "https://dev.azure.com/a/p/_git/backoffice/pullrequest/11";
  const pr = (over: Partial<PipelinePr> = {}): PipelinePr => ({ target: "dev", provider: "ado", id: 11, url: URL11, repo: "backoffice", branch: "5101-x", base: "dev", at: NOW - 90 * MIN, by: "coder", ...over });
  const of = (prs: PipelinePr[], over: Partial<TicketPipeline> = {}) => withTickets([pipe({ stage: "pr-dev", prs, ...over })]).filter((i) => i.kind === "merge");

  it("is there once the merge watch can't read it three times, or saw it closed and nothing replaced it", () => {
    const unread = of([pr({ watch: { failures: 3, why: "503", at: NOW - 4 * MIN } })]);
    expect(unread).toEqual([
      {
        id: `merge:5101:${URL11}`,
        sig: `merge:5101:${URL11}|unread`,
        kind: "merge",
        at: NOW - 4 * MIN,
        area: "5101",
        session: "coder",
        join: null,
        typing: null,
        pipeline: null,
        merge: { ticket: "5101", url: URL11 },
        label: "Merge unknown",
        text: "Can't tell whether PR 11 to dev merged",
        code: null,
      },
    ]);
    const closed = of([pr({ closedAt: NOW - 8 * MIN })]);
    expect(closed.map((i) => [i.label, i.text, i.sig, i.at])).toEqual([["PR closed", "PR 11 to dev was closed without merging", `merge:5101:${URL11}|closed:${NOW - 8 * MIN}`, NOW - 8 * MIN]]);
    // seen closed is a new state: a Dismiss of it unreadable lets it through
    expect(closed[0].sig).not.toBe(unread[0].sig);
    // a label of its own, not an agent's request's; the ticket said in its text only where the area isn't the ticket's
    expect(KIND_LABEL.merge).not.toBe(KIND_LABEL.pr);
    const elsewhere = withTickets([pipe({ stage: "pr-dev", prs: [pr({ closedAt: NOW })] })], [{ ...coder(), taskGroup: "Backoffice" }]).find((i) => i.kind === "merge")!;
    expect([elsewhere.area, elsewhere.text]).toEqual(["Backoffice", "PR 11 to dev was closed without merging · #5101"]);
  });

  it("isn't there for two failed reads, a merge, a closed one replaced by a newer, or a ticket that's done", () => {
    expect(of([pr({ watch: { failures: 2, why: "503", at: NOW } })])).toEqual([]);
    expect(of([pr({ mergedAt: NOW, watch: { failures: 3, why: "503", at: NOW } })])).toEqual([]);
    expect(of([pr({ closedAt: NOW - 8 * MIN }), pr({ id: 12, url: URL11.replace(/11$/, "12"), at: NOW - 5 * MIN })])).toEqual([]);
    expect(of([pr({ closedAt: NOW })], { stage: "done" })).toEqual([]);
  });

  it("is Check now and Mark merged…, each only what it's given; with no workspace on its ticket, there's nowhere to go", () => {
    const check = vi.fn();
    const mark = vi.fn();
    const rows = needsActions({ go: vi.fn<() => void>(), goTitle: "", dismiss: vi.fn(), merge: { check, mark } });
    expect(rows.map((r) => [r.key, r.label, !!r.primary, !!r.answer])).toEqual([
      ["check", "Check now", true, false],
      ["markMerged", "Mark merged…", false, false],
      ["dismiss", "Dismiss", false, false],
    ]);
    rows[1].onPick();
    expect([check.mock.calls.length, mark.mock.calls.length]).toEqual([0, 1]);
    const nowhere = withTickets([pipe({ stage: "pr-dev", prs: [pr({ closedAt: NOW })] })], []).find((i) => i.kind === "merge")!;
    expect(targetOf(nowhere, [])).toEqual({ no: "No workspace on #5101 is open here: Check now and Mark merged… are in Needs you" });
  });
});

describe("Finish step… on a finished step's item (W5)", () => {
  it("comes after Go there, only where it's given, off saying why when it can't open", () => {
    const finish = vi.fn();
    const rows = needsActions({ go: vi.fn<() => void>(), goTitle: "", dismiss: vi.fn(), finish });
    expect(rows.map((r) => [r.key, r.label])).toEqual([
      ["go", "Go there"],
      ["finish", "Finish step…"],
      ["dismiss", "Dismiss"],
    ]);
    rows[1].onPick();
    expect(finish).toHaveBeenCalledTimes(1);
    expect(needsActions({ go: vi.fn<() => void>(), goTitle: "", dismiss: vi.fn() }).map((r) => r.key)).toEqual(["go", "dismiss"]);
    const off = needsActions({ go: vi.fn<() => void>(), goTitle: "", dismiss: vi.fn(), finish: { no: "It's still working" } })[1];
    expect([off.disabled, off.title]).toEqual([true, "It's still working"]);
  });
});

// ---- W17: an Orchestrator's held plan, under W5's row rules ----

describe("an Orchestrator's plan's item (W17)", () => {
  const orch = () => sess("orch", { title: "Orchestrator", ticketId: "5101", taskGroup: "5101", role: "orchestrator" });
  const plan = (over: Partial<PlanView> = {}): PlanView => ({
    id: "pl-1",
    held: { from: "orch", ticket: "5101", at: NOW - 3 * MIN, plan: { summary: "Stream it.", steps: [{ key: "coder", name: "Coder", agent: "codex", folder: "orchestrator", prompt: "Implement {ticket}." }], wires: [] } },
    me: { id: "orch", title: "Orchestrator", kind: "agent", agent: "claude", repo: "/r", branch: "b", ticket: "5101", refusal: null },
    ticketTitle: "Stream the donor export",
    area: "5101",
    room: null,
    existing: {},
    installed: ["claude", "codex"],
    repos: ["/r"],
    problem: null,
    newer: null,
    ...over,
  });

  it("says in Mockingbird's words who proposes how many workspaces, in its Orchestrator's area", () => {
    const [item] = planItems([plan()], [orch()], areaKeyOf);
    expect(item).toMatchObject({ id: "plan:orch", kind: "plan", area: "5101", session: "orch", text: "Orchestrator proposes 1 workspace · #5101", plan: { id: "pl-1", face: "ready" } });
    expect(item.label).toBeUndefined();
  });

  it("has its face in its state: a plan that can't be laid out as it stands is a row of its own, labelled so", () => {
    const [ready] = planItems([plan()], [orch()], areaKeyOf);
    const [blocked] = planItems([plan({ problem: "\u201cCoder\u201d works in a folder that has gone." })], [orch()], areaKeyOf);
    expect([ready.sig, blocked.sig]).toEqual(["plan:pl-1|ready", "plan:pl-1|blocked"]);
    expect([blocked.id, blocked.label, blocked.plan?.face]).toEqual(["plan:orch", "Plan blocked", "blocked"]);
    // a state dismissed blocked doesn't hide it ready
    expect(shownItems([ready], [{ sig: blocked.sig, at: NOW }])).toEqual([ready]);
    // a newer plan is a new state too
    expect(planItems([plan({ id: "pl-2" })], [orch()], areaKeyOf)[0].sig).toBe("plan:pl-2|ready");
  });

  it("ranks with the prompts and wires, beside them", () => {
    const wires = wiresOf({ loop: link("reviewer", "builder", "feedback", { rounds: { limit: 3, used: 1 }, pending: pending("p", NOW - 30 * MIN) }) });
    const got = needsItems([...fixture(), orch()], [], areaKeyOf, (x) => x.title, {}, wires, [plan()]);
    // newest first within the rank: the plan, 3 minutes old, before the older prompt
    expect(got.map((i) => i.kind)).toEqual(["question", "plan", "permission", "wire", "finished", "finished"]);
  });

  it("is Open and Dismiss…, each opening the dialog; off, saying why, once the plan isn't listed", () => {
    const open = vi.fn();
    const turnDown = vi.fn();
    const acts = needsActions({ go: { no: "" }, goTitle: "", dismiss: vi.fn(), open: { can: open, title: "Open the plan" }, dismissRequest: turnDown, dismissTitle: "Turn the plan down, with a note for its Orchestrator: nothing is made" });
    expect(acts.map((a) => [a.key, a.label, !!a.primary, !!a.disabled, a.title])).toEqual([
      ["open", "Open", true, false, "Open the plan"],
      ["dismissRequest", "Dismiss\u2026", false, false, "Turn the plan down, with a note for its Orchestrator: nothing is made"],
    ]);
    acts[0].onPick();
    acts[1].onPick();
    expect([open.mock.calls.length, turnDown.mock.calls.length]).toEqual([1, 1]);
    const gone = { no: "That plan isn't held any more: it was laid out, dismissed or replaced." };
    const off = needsActions({ go: { no: "" }, goTitle: "", dismiss: vi.fn(), open: { can: gone, title: "Open the plan" }, dismissRequest: gone, dismissTitle: "x" });
    expect(off.map((a) => [a.key, !!a.disabled, a.title])).toEqual([
      ["open", true, gone.no],
      ["dismissRequest", true, gone.no],
    ]);
  });
});
