import { describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "../src/shared/types";
import type { JoinRequestSummary, TeamRoomSummary } from "../src/shared/team/types";
import { LOOSE_GROUP, areaKeyOf } from "../src/shared/landscape";
import {
  DISMISS_KEEP_MS,
  DISMISS_MAX,
  currentIndex,
  dismiss,
  dismissedFrom,
  goCan,
  needsByArea,
  needsItems,
  needsLabel,
  selectionAfter,
  shownItems,
  stepItem,
  targetOf,
  undismiss,
  type NeedsItem,
  type NeedsLast,
  type NeedsSel,
} from "../src/renderer/needsYouModel";
import { needsActions, TAKEN_BACK_WHY } from "../src/renderer/workspaceActions";

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
    const item = (n: number): NeedsItem => ({ id: `s:${n}`, sig: `s:${n}|f|${n}`, kind: "finished", at: n, area: "a", session: String(n), join: null, typing: null, text: "", code: null });
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
    const item = (n: number): NeedsItem => ({ id: `s:${n}`, sig: `s:${n}|f|${n}`, kind: "finished", at: n, area: "a", session: String(n), join: null, typing: null, text: "", code: null });
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
