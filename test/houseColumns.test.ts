import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "./helpers";
import { builderHome, fakeHouse, type FakeHouse } from "./fakeHouse";
import { loopbackRoom, until } from "../src/main/team/loopback";
import { houseOfRoom } from "../src/main/team/board";
import { HouseService } from "../src/main/team/houseService";
import {
  boardMove,
  CLOSE_REFUSAL,
  columnLayout,
  DEFAULT_FOLDS,
  groupRows,
  landingGap,
  moveCard,
  moveWrite,
  placeOf,
  stepPlace,
  type HousePlace,
} from "../src/renderer/team/houseColumns";
import type { HouseRow, HouseTicket, HouseView, HouseWrite } from "../src/shared/team/house";

const ticket = (n: number, status: string, over: Partial<HouseTicket> = {}): HouseTicket => ({ n, title: `Ticket ${n}`, status, priority: "medium", kind: "engineering", tags: [], claim: null, blockedBy: [], waiting: null, ...over });
const row = (n: number, status: string, over: Partial<HouseTicket> = {}, rest: Partial<HouseRow> = {}): HouseRow => ({ n, ticket: ticket(n, status, over), owner: null, ...rest });
const mine = (n: number, status: string, over: Partial<HouseTicket> = {}): HouseRow => row(n, status, { claim: { by: "Ryan", branch: `feature/${n}`, at: null }, ...over }, { owner: { name: "Ryan", member: null, self: true } });

describe("the House board's columns", () => {
  // the open backlog in the House's order, then the room's tickets outside it
  const open = [row(146, "ready", { priority: "high" }), mine(141, "in_progress", { priority: "high" }), row(143, "review", { priority: "high" }), row(142, "ready"), row(147, "parked"), row(148, "ready"), row(160, "triage"), row(149, "parked", { priority: "low" })];
  const added = [row(139, "done", { priority: "high" }), row(138, "dropped", { priority: "low" }), row(137, "done", { priority: "low" }), { n: 150, ticket: null, owner: null, problem: "The House answered 404" }];
  const order = open.map((r) => r.n);
  const ns = (rows: HouseRow[]) => rows.map((r) => r.n);

  it("groups the tickets by status, each column in the House's order, a status it doesn't know apart, and an unread ticket on its own", () => {
    // whatever order they come in
    const g = groupRows([...open, ...added].reverse(), order);
    expect(ns(g.ready)).toEqual([146, 142, 148]);
    expect(ns(g.in_progress)).toEqual([141]);
    expect(ns(g.review)).toEqual([143]);
    expect(ns(g.validating)).toEqual([]);
    expect(ns(g.parked)).toEqual([147, 149]);
    // outside the open backlog: by priority, as the House lists
    expect(ns(g.done)).toEqual([139, 137]);
    expect(ns(g.dropped)).toEqual([138]);
    expect(ns(g.other)).toEqual([160]);
    expect(ns(g.unread)).toEqual([150]);
    expect(placeOf("in_progress")).toBe("in_progress");
    expect(placeOf("triage")).toBe("other");
  });

  it("shows a move on its way in its new column, where the House's order puts it", () => {
    const g = groupRows([...open].reverse(), order, { 148: { status: "review" }, 146: { status: "review" } });
    expect(ns(g.review)).toEqual([146, 143, 148]);
    expect(ns(g.ready)).toEqual([142]);
    expect(landingGap(g.review, row(142, "ready"), order)).toBe(2);
    expect(landingGap(groupRows(open, order).in_progress, row(146, "ready", { priority: "high" }), order)).toBe(0);
    // a ticket outside the open backlog lands by its priority
    expect(landingGap(groupRows(open, order).ready, row(137, "done", { priority: "low" }), order)).toBe(3);
  });

  it("folds Parked and Done to start with, hides Dropped until asked, and neither Done nor Dropped takes a card", () => {
    const g = groupRows([...open, ...added], order);
    expect(DEFAULT_FOLDS).toEqual({ parked: true, done: true, showDropped: false });
    expect(columnLayout(g, DEFAULT_FOLDS)).toEqual([
      { place: "ready", name: "Ready", count: 3, folded: false, accepts: true },
      { place: "in_progress", name: "In progress", count: 1, folded: false, accepts: true },
      { place: "review", name: "Review", count: 1, folded: false, accepts: true },
      { place: "validating", name: "Validating", count: 0, folded: false, accepts: true },
      { place: "done", name: "Done", count: 2, folded: true, accepts: false },
    ]);
    const all = columnLayout(g, { parked: false, done: false, showDropped: true });
    expect(all.map((c) => [c.place, c.folded, c.accepts])).toEqual([
      ["ready", false, true],
      ["in_progress", false, true],
      ["review", false, true],
      ["validating", false, true],
      ["done", false, false],
      ["dropped", false, false],
    ]);
    expect(all.at(-1)!.count).toBe(1);
  });

  it("makes a drag into In progress a claim, back to Ready a release, any other move a status change, and refuses Done and Dropped", () => {
    const unclaimed = row(146, "ready");
    const claimed = mine(141, "in_progress");
    expect(boardMove(unclaimed, "ready", "in_progress")).toEqual({ kind: "claim" });
    expect(boardMove(row(147, "parked"), "parked", "in_progress")).toEqual({ kind: "claim" });
    expect(boardMove(claimed, "in_progress", "ready")).toEqual({ kind: "release" });
    expect(boardMove(claimed, "in_progress", "review")).toEqual({ kind: "status", status: "review" });
    expect(boardMove(mine(143, "review"), "review", "in_progress")).toEqual({ kind: "status", status: "in_progress" });
    expect(boardMove(unclaimed, "ready", "parked")).toEqual({ kind: "status", status: "parked" });
    expect(boardMove(row(143, "review"), "review", "validating")).toEqual({ kind: "status", status: "validating" });
    for (const to of ["done", "dropped"] as HousePlace[]) {
      expect(boardMove(claimed, "in_progress", to)).toEqual({ refused: CLOSE_REFUSAL });
      expect(boardMove(row(152, "validating"), "validating", to)).toEqual({ refused: CLOSE_REFUSAL });
    }
    expect(boardMove(unclaimed, "ready", "ready")).toBeNull();
    expect(boardMove({ n: 150, ticket: null, owner: null }, "other", "ready")).toBeNull();
    expect(CLOSE_REFUSAL).toBe("Only House staff close tickets");

    expect(moveWrite(unclaimed, { kind: "claim" }, "ready", "feature/146-x")).toEqual({ kind: "claim", n: 146, branch: "feature/146-x" });
    expect(moveWrite(claimed, { kind: "release" }, "in_progress")).toEqual({ kind: "release", n: 141 });
    expect(moveWrite(claimed, { kind: "status", status: "review" }, "in_progress")).toEqual({ kind: "event", n: 141, event: "status", status: "review", text: "Moved from In progress to Review on the room's board." });
    // ⌥← ⌥→ along the House's flow, Done at the end of it
    expect(stepPlace("ready", -1)).toBe("parked");
    expect(stepPlace("parked", -1)).toBeNull();
    expect(stepPlace("validating", 1)).toBe("done");
    expect(stepPlace("dropped", 1)).toBeNull();
  });

  it("shows a move at once, and puts the card back with the House's own message when it refuses", async () => {
    const shown: [number, string | null][] = [];
    const show = (n: number, s: string | null) => void shown.push([n, s]);
    const r = row(143, "review");
    const w = moveWrite(r, { kind: "status", status: "validating" }, "review");
    expect(await moveCard(r, "review", "validating", w, async () => ({ message: "Moved" }), show)).toEqual({ ok: true });
    expect(shown).toEqual([[143, "validating"]]);

    shown.length = 0;
    expect(await moveCard(r, "review", "validating", w, async () => ({ error: "The House answered 409: #143 has moved on" }), show)).toEqual({ error: "Couldn't move #143 to Validating — it's back in Review: The House answered 409: #143 has moved on" });
    expect(shown).toEqual([
      [143, "validating"],
      [143, null],
    ]);

    shown.length = 0;
    const thrown = await moveCard(r, "review", "validating", w, async () => Promise.reject(new Error("the window lost the main process")), show);
    expect(thrown).toEqual({ error: expect.stringMatching(/it's back in Review: the window lost the main process$/) });
    expect(shown.at(-1)).toEqual([143, null]);
  });
});

// ---- the moves, written to a fake House on this Mac by the board's own write path ----

const RYAN_T = "hb_RYAN_secret_token_000111";
const PROJECT = "atticus-backoffice";
let stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.reverse()) await s();
  stops = [];
});

async function board(): Promise<{ h: FakeHouse; svc: HouseService; roomId: string; view: () => HouseView }> {
  const h = await fakeHouse({ [RYAN_T]: "Ryan Ellerbroek" });
  stops.push(() => h.close());
  h.item(146, { title: "Donor export skips archived donors", status: "ready", priority: "high" });
  h.item(141, { title: "Last-org API", status: "ready" });
  h.item(143, { title: "Org dropdown", status: "review", assignee: "Ryan Ellerbroek", branch: "feature/143-org" });
  h.item(152, { title: "Gift aid totals", status: "validating" });
  const { members, roomId } = await loopbackRoom(["Ryan"], { dir: tempDir("t") });
  const svc = new HouseService({
    roomGroups: () => [{ roomId, groupKey: "5110" }],
    sessions: () => [],
    knownRepos: () => [],
    emit: () => undefined,
    log: (context, err) => `${context}: ${err instanceof Error ? err.message : String(err)}`,
    notify: () => undefined,
    overlapsChanged: () => undefined,
    copiesFile: path.join(tempDir("copies"), "copies.json"),
    consentFile: path.join(tempDir("consent"), "house-consent.json"),
    home: builderHome(PROJECT, h, RYAN_T),
    allowHttpLoopback: true,
    timing: { pollMs: 60_000, sessionsMs: 30, fetchMs: 60_000, timeoutMs: 3000, nudgeGapMs: 20, nudgeListGapMs: 50 },
  });
  svc.start(members[0].team);
  stops.push(() => svc.stop());
  await svc.write(roomId, { kind: "project", project: PROJECT });
  await until(() => houseOfRoom(members[0].team.room(roomId)!).project === PROJECT, "the room to have the project");
  await svc.idle();
  await until(() => !!svc.view(roomId).open, "the board to be read");
  return { h, svc, roomId, view: () => svc.view(roomId) };
}

describe("a card dragged on the House board", () => {
  it("reaches the House as the claim, release or status change it is, with the member's own token", async () => {
    const { h, svc, roomId, view } = await board();
    const rowOf = (n: number) => [...(view().open ?? []), ...view().added].find((r) => r.n === n)!;
    // the board's own write, as the window sends it
    const drag = async (n: number, to: HousePlace, branch?: string) => {
      const r = rowOf(n);
      const from = placeOf(r.ticket!.status);
      const mv = boardMove(r, from, to);
      if (!mv || "refused" in mv) return mv;
      const w: HouseWrite = moveWrite(r, mv, from, branch);
      const before = h.requests.length;
      await svc.write(roomId, w);
      await svc.idle();
      return h.requests.slice(before).filter((q) => q.method !== "GET").map((q) => ({ call: `${q.method} ${q.path.split("/external/")[1]}`, body: q.body, mine: q.token === RYAN_T }));
    };

    expect(await drag(146, "in_progress", "feature/146-donor-export")).toEqual([{ call: "POST work-items/146/claim", body: { branch: "feature/146-donor-export" }, mine: true }]);
    expect(h.items.get(146)).toMatchObject({ assignee: "Ryan Ellerbroek", branch: "feature/146-donor-export", status: "in_progress" });
    await until(() => rowOf(146).owner?.self === true, "the claim to show as Ryan's");

    expect(await drag(146, "ready")).toEqual([{ call: "POST work-items/146/release", body: null, mine: true }]);
    expect(h.items.get(146)).toMatchObject({ assignee: null, status: "ready" });

    expect(await drag(143, "validating")).toEqual([{ call: "POST work-items/143/events", body: { event: "progress", note: "Moved from Review to Validating on the room's board.", status: "validating" }, mine: true }]);
    expect(h.items.get(143)!.status).toBe("validating");
    expect(h.items.get(143)!.history.at(-1)).toMatchObject({ event: "status_changed", to_status: "validating" });
    expect(await drag(141, "parked")).toEqual([{ call: "POST work-items/141/events", body: { event: "progress", note: "Moved from Ready to Parked on the room's board.", status: "parked" }, mine: true }]);

    // Done and Dropped: refused on the board, and nothing reaches the House
    const sent = h.requests.length;
    expect(await drag(152, "done")).toEqual({ refused: CLOSE_REFUSAL });
    expect(await drag(152, "dropped")).toEqual({ refused: CLOSE_REFUSAL });
    // a status write for either is refused before the House too
    await expect(svc.write(roomId, { kind: "event", n: 152, event: "status", status: "done" as never, text: "x" })).rejects.toThrow(/only staff close a ticket/);
    expect(h.requests.length).toBe(sent);
  });

  it("goes back where it was, with the House's message, when the House refuses the move", async () => {
    const { h, svc, roomId, view } = await board();
    h.state.refuseStatus = (it, to) => (it.number === 143 && to === "validating" ? `#${it.number} can't go to validating while its review is open` : null);
    const r = [...(view().open ?? [])].find((x) => x.n === 143)!;
    const mv = boardMove(r, "review", "validating");
    expect(mv).toEqual({ kind: "status", status: "validating" });
    const shown: [number, string | null][] = [];
    const res = await moveCard(r, "review", "validating", moveWrite(r, mv as { kind: "status"; status: "validating" }, "review"), (w) => svc.write(roomId, w), (n, s) => void shown.push([n, s]));
    expect(res).toEqual({ error: "Couldn't move #143 to Validating — it's back in Review: The House answered 409: #143 can't go to validating while its review is open" });
    expect(shown).toEqual([
      [143, "validating"],
      [143, null],
    ]);
    expect(h.items.get(143)!.status).toBe("review");
  });
});
