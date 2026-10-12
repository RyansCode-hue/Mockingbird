import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { TAB_LABELS } from "../src/renderer/tabs";
import {
  accessFlags,
  accessOf,
  agreement,
  effortOptions,
  initials,
  isLong,
  kindLabel,
  moveAt,
  moveSeat,
  roundsGrid,
  seedSeats,
  specsOf,
  summaryOf,
  threadItems,
  unusedModel,
  waited,
} from "../src/renderer/collabView";
import type { CollabMessage, CollabParticipant, CollabRoom } from "../src/shared/types";

let n = 0;
const msg = (speaker: string, round: number, extra: Partial<CollabMessage> = {}): CollabMessage => ({ id: `m${++n}`, speaker, text: `${speaker} r${round}`, round, at: n, ...extra });
const seat = (key: string, extra: Partial<CollabParticipant> = {}): CollabParticipant =>
  ({ key, label: key, agent: "claude", model: key, effort: null, readsCode: true, color: 0, conversationId: null, lastSeen: 0, ...extra }) as CollabParticipant;
const room = (messages: CollabMessage[], over: Partial<CollabRoom> = {}): CollabRoom =>
  ({ id: "r", title: "t", brief: "b", repoPath: null, participants: [seat("opus"), seat("gpt6"), seat("fable")], messages, mode: "auto", maxRounds: 3, round: 2, running: false, speaking: null, plan: null, implementedIn: null, createdAt: 0, ...over }) as CollabRoom;

describe("thread", () => {
  it("puts a round divider before the first model message of each round, not before notes or your messages", () => {
    const items = threadItems([msg("you", 0), msg("system", 0), msg("opus", 1), msg("gpt6", 1), msg("you", 1), msg("opus", 2)]);
    expect(items.map((i) => (i.type === "divider" ? `--${i.round}` : i.message.speaker))).toEqual(["you", "system", "--1", "opus", "gpt6", "you", "--2", "opus"]);
  });
  it("folds only long messages", () => {
    expect(isLong("short")).toBe(false);
    expect(isLong("x".repeat(901))).toBe(true);
    expect(isLong(Array(16).fill("line").join("\n"))).toBe(true);
  });
});

describe("agreement", () => {
  it("counts the seated models that agreed in the latest round with stances", () => {
    const r = room([msg("opus", 1, { stance: "continue" }), msg("opus", 2, { stance: "agree" }), msg("gpt6", 2, { stance: "agree" }), msg("fable", 2, { stance: "continue" })]);
    expect(agreement(r)).toEqual({ round: 2, agree: 2, of: 3 });
  });
  it("ignores models that left, and is null before anyone has taken a stance", () => {
    const r = room([msg("opus", 1, { stance: "agree" }), msg("gone", 1, { stance: "agree" })], { participants: [seat("opus"), seat("gone", { removed: true })] });
    expect(agreement(r)).toEqual({ round: 1, agree: 1, of: 1 });
    expect(agreement(room([msg("you", 0)]))).toBeNull();
  });
});

describe("rounds grid", () => {
  it("has a column per seated model plus any that left after speaking, and a row per round", () => {
    const r = room([msg("you", 0), msg("opus", 1), msg("gone", 1), msg("gpt6", 1)], {
      participants: [seat("opus"), seat("gpt6"), seat("gone", { removed: true }), seat("silent", { removed: true })],
      round: 1,
    });
    const g = roundsGrid(r);
    expect(g.columns.map((c) => c.key)).toEqual(["opus", "gpt6", "gone"]);
    expect(g.rows.map((row) => row.round)).toEqual([1]);
  });
  it("places your messages before the round that followed them; lookups, plans and errors share their model's cell", () => {
    const brief = msg("you", 0);
    const nudge = msg("you", 1);
    const late = msg("you", 2);
    const lookup = msg("opus", 2, { kind: "lookup", askedBy: "gpt6" });
    const r = room([brief, msg("system", 0), msg("opus", 1), msg("gpt6", 1), nudge, lookup, msg("opus", 2), msg("gpt6", 2, { kind: "error" }), late]);
    const g = roundsGrid(r);
    expect(g.rows[0].before).toEqual([brief]);
    expect(g.rows[1].before).toEqual([nudge]);
    expect(g.after).toEqual([late]);
    expect(g.rows[1].cells.opus.map((m) => m.kind ?? "turn")).toEqual(["lookup", "turn"]);
    expect(g.rows[1].cells.gpt6[0].kind).toBe("error");
  });
  it("adds the round in progress while the room runs", () => {
    expect(roundsGrid(room([msg("opus", 1)], { round: 1, running: true })).rows.map((r) => r.round)).toEqual([1, 2]);
  });
});

describe("small formats", () => {
  it("summarises a message by its first real line, without markdown", () => {
    expect(summaryOf("\n## **Proposal:** cache `tags`\nmore")).toBe("Proposal: cache tags");
    expect(summaryOf("- one\n- two")).toBe("one");
    expect(summaryOf("*Background:* the _tag_load_ runs")).toBe("Background: the tag_load runs");
    expect(summaryOf("x".repeat(200), 20)).toBe(`${"x".repeat(19)}…`);
  });
  it("shows waiting time as m:ss", () => {
    expect(waited(0, 42_000)).toBe("0:42");
    expect(waited(0, 605_500)).toBe("10:05");
  });
  it("gives a room two letters for the rail, skipping filler words", () => {
    expect(initials("How to make Atticus-Snipper (Pathways) perform better")).toBe("MA");
    expect(initials("CSV export")).toBe("CE");
    expect(initials("")).toBe("?");
  });
});

describe("editing models in the sidebar", () => {
  it("treats code access as one ladder: none, read, run, docker", () => {
    for (const a of ["none", "read", "run", "docker"] as const) expect(accessOf(accessFlags(a))).toBe(a);
    expect(accessFlags("run")).toEqual({ readsCode: true, runsCommands: true, usesDocker: false });
    // older seats that only stored readsCode
    expect(accessOf({ readsCode: true })).toBe("read");
    expect(accessOf({ readsCode: false })).toBe("none");
  });
  it("turns the seated models into the specs a change sends, keeping keys so conversations carry on", () => {
    const r = room([], { participants: [seat("opus", { effort: "high", runsCommands: true }), seat("gone", { removed: true }), seat("gpt6", { agent: "codex", readsCode: false })] });
    expect(specsOf(r.participants)).toEqual([
      { key: "opus", label: "opus", agent: "claude", model: "opus", effort: "high", readsCode: true, runsCommands: true, usesDocker: false },
      { key: "gpt6", label: "gpt6", agent: "codex", model: "gpt6", effort: null, readsCode: false, runsCommands: false, usesDocker: false },
    ]);
  });
  it("moves a seat into another's place in the speaking order", () => {
    const s = [{ key: "a" }, { key: "b" }, { key: "c" }];
    expect(moveSeat(s, "c", "a").map((x) => x.key)).toEqual(["c", "a", "b"]);
    expect(moveSeat(s, "a", "c").map((x) => x.key)).toEqual(["b", "c", "a"]);
    expect(moveSeat(s, "a", "zz")).toBe(s);
  });
});

describe("access chips", () => {
  it("light every permission a level includes, and toggle one at a time within the rules", async () => {
    const { hasAccess, toggleAccess } = await import("../src/renderer/collabView");
    expect(["read", "run", "docker"].map((l) => hasAccess("docker", l as any))).toEqual([true, true, true]);
    expect(["read", "run", "docker"].map((l) => hasAccess("read", l as any))).toEqual([true, false, false]);
    expect(toggleAccess("none", "docker")).toBe("docker"); // turning docker on brings read and run
    expect(toggleAccess("docker", "docker")).toBe("run"); // off: just docker
    expect(toggleAccess("docker", "run")).toBe("read"); // run off takes docker with it
    expect(toggleAccess("run", "read")).toBe("none"); // read off takes everything
    expect(toggleAccess("read", "run")).toBe("run");
  });
});

describe("a new room's seats", () => {
  const catalog = (presets: { key: string; model: string }[], defaults?: { key: string; model: string }[]) => ({
    presets: presets.map((p) => ({ ...p, label: p.key, agent: "claude" as const })),
    ...(defaults ? { defaults: defaults.map((p) => ({ ...p, label: p.key, agent: "claude" as const })) } : {}),
    efforts: { claude: [], codex: [] },
  });
  it("has none to seat or add before the catalog has loaded", () => {
    expect(seedSeats(catalog([]))).toEqual([]);
    expect(unusedModel(catalog([]), [])).toBeNull();
  });
  it("starts with the catalog's defaults, else its presets", () => {
    expect(seedSeats(catalog([{ key: "a", model: "m-a" }, { key: "b", model: "m-b" }], [{ key: "b", model: "m-b" }])).map((s) => s.model)).toEqual(["m-b"]);
    expect(seedSeats(catalog([{ key: "a", model: "m-a" }])).map((s) => s.model)).toEqual(["m-a"]);
  });
  it("adds the first model not seated yet, and none once every one is", () => {
    const c = catalog([{ key: "a", model: "m-a" }, { key: "b", model: "m-b" }]);
    expect(unusedModel(c, [{ agent: "claude", model: "m-a" }])?.key).toBe("b");
    expect(unusedModel(c, [{ agent: "claude", model: "m-a" }, { agent: "claude", model: "m-b" }])).toBeNull();
  });
  it("moves a seat, new ones included, one place earlier or later", () => {
    const seats = [{ label: "a" }, { label: "b" }, { label: "c" }];
    expect(moveAt(seats, 2, 1).map((s) => s.label)).toEqual(["a", "c", "b"]);
    expect(moveAt(seats, 0, -1)).toBe(seats);
    expect(moveAt(seats, 2, 3)).toBe(seats);
  });
  it("offers each CLI's own effort levels after its default", () => {
    const c = { presets: [], efforts: { claude: ["low", "high"], codex: ["minimal"] } };
    expect(effortOptions(c, "codex", "default").map((o) => o.value)).toEqual(["", "minimal"]);
  });
});

describe("always-allowed kinds", () => {
  it("read as the command, or the tool and where", () => {
    expect(kindLabel("Bash: docker exec")).toBe("docker exec");
    expect(kindLabel("WebFetch: docs.python.org")).toBe("WebFetch in docs.python.org");
  });
});

describe("Council's name", () => {
  it("is what the tab says, while the tab's id stays the saved one", () => {
    expect(TAB_LABELS.collaborate).toBe("Council");
  });

  it("is never called a room in what people or models read: rooms are team rooms", () => {
    // prose only: comments, and identifiers like `room.title` or `collab-room-row`, aren't shown
    const prose = /\b(?:a|the|this|that|new|delete|from|in) rooms?\b|\brooms?(?:'s)? (?:list|details|files?)\b|\bRoom stopped\b/i;
    for (const file of ["src/renderer/Council.tsx", "src/renderer/CollabModels.tsx", "src/renderer/collabView.ts", "src/main/collab.ts"]) {
      const code = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|\s)\/\/ .*$/gm, "$1");
      expect(code.match(prose)?.[0] ?? null, file).toBeNull();
    }
  });
});
