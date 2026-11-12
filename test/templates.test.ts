import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { draftTemplate, FOLDER_MARK, removedTemplate, savedTemplates, setAsideTemplates } from "../src/main/templates";
import { tempDir } from "./helpers";
import { readTemplates, ticketKickoffPrompt, type TemplateBody } from "../src/shared/pipelineTemplates";
import type { SessionInfo } from "../src/shared/types";
import { emptyWireBook, newWire, type Wire, type WireBook } from "../src/shared/wires";

const REPO = "/Users/sam/Code/backoffice";
const session = (id: string, over: Partial<SessionInfo> = {}): SessionInfo =>
  ({ id, title: id, ticketTitle: null, repoPath: REPO, branch: id, taskGroup: "5120", status: "idle", agent: "claude", cwd: `${REPO}/.worktrees/${id}`, kind: "work", ...over }) as SessionInfo;
const wire = (from: string, to: string, type: Wire["type"], at: number, over: Partial<Wire> = {}): Wire => ({ ...newWire(from, to, type, at), ...over });

/** Builder (running, its own worktree) → Reviewer (in its folder) → Tester (not started), Dev server on Builder's tree. */
function chain() {
  const all: Record<string, SessionInfo> = {
    b: session("b", { title: "Builder", agent: "codex", model: "gpt-5.5" }),
    r: session("r", { title: "Reviewer", cwd: `${REPO}/.worktrees/b` }),
    t: session("t", { title: "Tester", planned: { worktree: true, prompt: `${ticketKickoffPrompt(5120, "Donor export", "It times out.")}\n\nThen run ${REPO}/.worktrees/b/e2e.sh with token ghp_${"a1".repeat(18)}.` } }),
    d: session("d", { title: "Dev server", shell: true, agent: undefined, cwd: `${REPO}/.worktrees/b` }),
    x: session("x", { title: "Elsewhere" }),
  };
  const book: WireBook = {
    ...emptyWireBook(),
    links: {
      w1: wire("b", "r", "handoff", 1),
      w2: wire("r", "b", "feedback", 2, { rounds: { limit: 4, used: 3 } }),
      w3: wire("r", "t", "handoff", 3, { gate: "automatic", template: `{summary}\n\nIn ${REPO}/.worktrees/b` }),
      w4: wire("b", "d", "worktree", 4),
      w5: wire("t", "x", "context", 5),
    },
  };
  return { all, book, deps: { sessionOf: (id: string) => all[id], book: () => book } };
}

describe("Save as template's draft", () => {
  it("keeps each step's agent, name, model, Tell it and folder, its terminal and wires; secrets, folders and the ticket taken out, each said", () => {
    const { deps } = chain();
    const d = draftTemplate(["b", "r", "t"], deps);
    expect(d.name).toBe("Builder → Reviewer → Tester");
    expect(d.body.startFirst).toBe(true);
    expect(d.body.steps).toEqual([
      { key: "s1", name: "Builder", agent: "codex", model: "gpt-5.5", folder: "new", prompt: "" },
      { key: "s2", name: "Reviewer", agent: "claude", folder: { sameAs: "s1" }, prompt: "" },
      { key: "s3", name: "Tester", agent: "claude", folder: "new", prompt: `{ticket}\n\nThen run ${FOLDER_MARK}/e2e.sh with token [redacted].` },
      { key: "s4", name: "Dev server", agent: "terminal", folder: { sameAs: "s1" }, prompt: "" },
    ]);
    expect(d.body.wires).toEqual([
      { from: "s1", to: "s2", type: "handoff", when: "finished", gate: "ask" },
      { from: "s2", to: "s1", type: "feedback", when: "finished", gate: "ask", rounds: 4 },
      { from: "s2", to: "s3", type: "handoff", when: "finished", gate: "automatic", template: `{summary}\n\nIn ${FOLDER_MARK}` },
      { from: "s1", to: "s4", type: "worktree" },
    ]);
    expect(d.notes).toEqual([
      "The ticket kickoff a step was told is {ticket} here: it's filled in with the ticket it's laid out for.",
      "1 secret-looking value was replaced with [redacted]: redaction is a net, so read what's below before saving it.",
      `2 mentions of the chain's folders became ${FOLDER_MARK}: a template is laid out in other folders.`,
      "1 wire to workspaces outside the chain isn't kept.",
      "What “Builder”, “Reviewer” were told as they started isn't kept once running: say it here, and what its terminal runs.",
    ]);
    // nothing of this Mac's is in it
    expect(JSON.stringify(d.body)).not.toContain("/Users/");
  });

  it.each<[string, string[], RegExp]>([
    ["a terminal as a step", ["b", "d"], /“Dev server” is a terminal/],
    ["a teammate's session", ["b", "r~0f1e2d3c4b5a~n1"], /teammate's session/],
    ["a session gone", ["b", "nobody"], /no session "nobody"/],
    ["no chain", [], /no chain to save/],
  ])("is refused for %s", (_what, ids, re) => {
    expect(() => draftTemplate(ids, chain().deps)).toThrow(re);
  });

  it("is refused while the book can't be read", () => {
    const { deps } = chain();
    expect(() => draftTemplate(["b"], { ...deps, book: () => ({ refused: "landscape.json can't be read" }) })).toThrow("landscape.json can't be read");
  });
});

const body = (): TemplateBody => ({
  startFirst: true,
  steps: [
    { key: "s1", name: "Builder", agent: "codex", folder: "new", prompt: "Implement {ticket}." },
    { key: "s2", name: "Reviewer", agent: "claude", folder: { sameAs: "s1" }, prompt: "Review it." },
  ],
  wires: [{ from: "s1", to: "s2", type: "handoff", when: "finished", gate: "ask" }],
});
const HOME = "/Users/sam";
const save = (name: unknown, b: unknown, stored: unknown) => savedTemplates(name, b, stored, { home: HOME, now: () => 42, newId: () => "tpl-new" });

describe("saving a template", () => {
  it("adds it after every entry already there, ones this version can't read kept as they are", () => {
    const newer = { id: "tpl-n", name: "Newer", savedAt: 1, colour: "teal", ...body() };
    const broken = { id: "tpl-b", name: "Broken", savedAt: 2, startFirst: true, steps: "three", wires: [] };
    const r = save("  Build and review ", body(), [newer, broken]);
    expect(r.template).toEqual({ id: "tpl-new", name: "Build and review", savedAt: 42, ...body() });
    expect(r.list).toEqual([newer, broken, r.template]);
    // and read back, it's what was saved: the round trip a lay-out starts from
    expect(readTemplates(r.list).templates.at(-1)).toEqual({ template: r.template, unknown: [] });
  });

  it.each<[string, unknown, unknown, RegExp]>([
    ["no name", "  ", body(), /Name the template/],
    ["a name of two lines", "a\nb", body(), /one line/],
    ["a name another has, any case", "newer", body(), /called “newer” already/],
    ["a name a refused entry has", "Broken", body(), /called “Broken” already/],
    ["a body that isn't one", "X", { ...body(), steps: [] }, /It can't be saved: It has no steps/],
    ["a body with a field this version doesn't know", "X", { ...body(), colour: "teal" }, /doesn't know \(colour\)/],
    ["a secret in a prompt", "X", { ...body(), steps: [{ ...body().steps[0], prompt: `use ghp_${"a1".repeat(18)}` }, body().steps[1]] }, /“Builder”'s prompt holds 1 secret-looking value/],
    ["a secret in what a wire carries", "X", { ...body(), wires: [{ ...body().wires[0], template: "password: 'correct horse'" }] }, /Builder → Reviewer's What flows holds 1 secret-looking value/],
    ["a folder in the home folder", "X", { ...body(), steps: [body().steps[0], { ...body().steps[1], prompt: `read ${HOME}/notes.md` }] }, /“Reviewer”'s prompt names a folder in your home folder/],
    ["a ~/ path", "X", { ...body(), steps: [{ ...body().steps[0], prompt: "see ~/Code" }, body().steps[1]] }, /names a folder in your home folder/],
  ])("is refused for %s, changing nothing", (_what, name, b, re) => {
    const stored = [{ id: "tpl-n", name: "Newer", savedAt: 1, ...body() }, { id: "tpl-b", name: "Broken", steps: "three" }];
    const before = JSON.stringify(stored);
    expect(() => save(name, b, stored)).toThrow(re);
    expect(JSON.stringify(stored)).toBe(before);
  });

  it("doesn't take a home folder's longer neighbour for it", () => {
    expect(() => save("X", { ...body(), steps: [{ ...body().steps[0], prompt: `${HOME}ish/x is another user's` }, body().steps[1]] }, [])).not.toThrow();
  });

  it("saves nothing over a list that isn't one", () => {
    expect(() => save("X", body(), { a: 1 })).toThrow(/aren't a list/);
  });
});

describe("removing a template", () => {
  it("takes out the one of that id, one this version can't read too", () => {
    const stored = [{ id: "tpl-a", name: "A", savedAt: 1, ...body() }, { id: "tpl-b", name: "Broken", steps: "three" }];
    expect(removedTemplate("tpl-b", stored)).toEqual({ list: [stored[0]], name: "Broken" });
    expect(removedTemplate("tpl-a", stored)).toEqual({ list: [stored[1]], name: "A" });
    expect(() => removedTemplate("tpl-z", stored)).toThrow(/isn't saved any more/);
  });
});

describe("a draft's names and tickets (review fixes 1)", () => {
  const ticketed = (id: string, over: Partial<SessionInfo>) => session(id, { ticketId: "5115", ticketTitle: "Stream the donor export", taskGroup: "5115", ...over });
  const pair = (all: Record<string, SessionInfo>, extra: Partial<Parameters<typeof draftTemplate>[1]> = {}) =>
    draftTemplate(Object.keys(all), { sessionOf: (id) => all[id], book: () => ({ ...emptyWireBook(), links: { w1: wire(Object.keys(all)[0], Object.keys(all)[1], "handoff", 1) } }), ...extra });

  it("names a step made from its ticket or branch for its agent instead, and the template from those, saying so", () => {
    const d = pair({
      a: ticketed("a", { title: "Stream the donor export", agent: "codex" }),
      b: ticketed("b", { title: "Reviewer" }),
    });
    expect(d.body.steps.map((s) => s.name)).toEqual(["Codex", "Reviewer"]);
    expect(d.name).toBe("Codex → Reviewer");
    expect(d.notes).toContain("“Stream the donor export” was named for its ticket or branch, so it's named for its agent here: name it for what it does.");
  });

  it.each([
    ["the ticket's number", "#5115 — Stream the donor export"],
    ["the ticket's id in words", "Fix 5115"],
    ["its branch", "5115-stream-donor-export"],
  ])("takes %s in a name as the ticket's", (_what, title) => {
    const d = pair({ a: ticketed("a", { title, ticketTitle: null, branch: "5115-stream-donor-export" }), b: ticketed("b", { title: "Reviewer", ticketTitle: null }) });
    expect(d.body.steps[0].name).toBe("Claude");
  });

  it("keeps a name that only shares a word with its ticket", () => {
    const d = pair({ a: ticketed("a", { title: "Builder" }), b: ticketed("b", { title: "Export reviewer" }) });
    expect(d.body.steps.map((s) => s.name)).toEqual(["Builder", "Export reviewer"]);
  });

  it("turns the ticket a laid-out step's prompt was filled in with back into {ticket}, and says when its number is still there", () => {
    const line = "#5115 — Stream the donor export";
    const all = {
      a: session("a", { title: "Builder", ticketId: "5115", planned: { worktree: true, prompt: `Implement ${line}.` } }),
      b: session("b", { title: "Reviewer", ticketId: "5115", planned: { worktree: false, prompt: `Review ${line}, then compare with #5115's notes.` } }),
    };
    // the step records name the ticket by id only: its title comes from this Mac's record of the ticket
    const d = pair(all, { ticketTitleOf: (id) => (id === "5115" ? "Stream the donor export" : null) });
    expect(d.body.steps.map((s) => s.prompt)).toEqual(["Implement {ticket}.", "Review {ticket}, then compare with #5115's notes."]);
    expect(d.notes).toContain("The ticket kickoffs its steps were told are {ticket} here: it's filled in with the ticket it's laid out for.");
    expect(d.notes).toContain("“Reviewer” still names its ticket by number: say {ticket} where it's the ticket a lay-out is for.");
    // with the title unknown, nothing is guessed: the number is said
    const unknown = pair(all);
    expect(unknown.body.steps[0].prompt).toBe(`Implement ${line}.`);
    expect(unknown.notes).toContain("“Builder”, “Reviewer” still name their tickets by number: say {ticket} where it's the ticket a lay-out is for.");
  });

  it("never takes the home folder for the chain's: a step with no repo keeps its home paths, said, and save refuses them", () => {
    const HOME_DIR = "/Users/sam";
    const all = {
      a: session("a", { title: "Planner", repoPath: null, cwd: HOME_DIR, planned: { worktree: false, prompt: `Wait ~5 minutes, then read ~/notes.md and ${HOME_DIR}/.aws/config.` } }),
      b: session("b", { title: "Doer", repoPath: null, cwd: HOME_DIR, planned: { worktree: false, prompt: "Do it" } }),
    };
    const d = pair(all, { home: HOME_DIR });
    expect(d.body.steps[0].prompt).toBe(`Wait ~5 minutes, then read ~/notes.md and ${HOME_DIR}/.aws/config.`);
    expect(d.notes).toContain("“Planner”'s prompt names a folder in your home folder: a template is laid out in other folders, so take it out before saving.");
    expect(() => savedTemplates("Y", d.body, [], { home: HOME_DIR })).toThrow(/“Planner”'s prompt names a folder in your home folder/);
  });

  it("knows the home folder however its name is cased: never the chain's folder, and a prompt naming it is said and refused", (ctx) => {
    const home = tempDir("home");
    const upper = home.toUpperCase();
    // a case-sensitive volume: the two are different folders
    if (upper === home || !fs.existsSync(upper)) ctx.skip();
    const all = {
      a: session("a", { title: "Planner", repoPath: null, cwd: upper, planned: { worktree: false, prompt: `Read ${upper}/notes.md.` } }),
      b: session("b", { title: "Doer", repoPath: null, cwd: upper, planned: { worktree: false, prompt: "Do it" } }),
    };
    const d = pair(all, { home });
    expect(d.body.steps[0].prompt).toBe(`Read ${upper}/notes.md.`);
    expect(d.notes).toContain("“Planner”'s prompt names a folder in your home folder: a template is laid out in other folders, so take it out before saving.");
    expect(() => savedTemplates("Y", d.body, [], { home })).toThrow(/“Planner”'s prompt names a folder in your home folder/);
  });
});

describe("the home folder, however it's written (review fixes 1)", () => {
  it.each(["cat $HOME/.ssh/id_rsa", "cat ${HOME}/.aws/credentials", "cat>~/x", "ls ~sam/Code", "cd ~", "cp a,~/b", "x=[~/c]", "(~/d)", "file:///Users/sam/x"])("refuses %s", (p) => {
    expect(() => save("X", { ...body(), steps: [body().steps[0], { ...body().steps[1], prompt: p }] }, [])).toThrow(/names a folder in your home folder/);
  });
  it.each(["Wait ~5 minutes", "a~b", "HOMEWORK", "$HOMER", "/Volumes/Work/x"])("takes %s for what it is", (p) => {
    expect(() => save("X", { ...body(), steps: [body().steps[0], { ...body().steps[1], prompt: p }] }, [])).not.toThrow();
  });
});

describe("saved templates that aren't a list (review fixes 1)", () => {
  it("says so plainly when there's nothing to remove", () => {
    expect(() => removedTemplate("tpl-x", undefined)).toThrow("That template isn't saved any more: there are no saved templates.");
  });

  it("points save and remove at setting them aside", () => {
    expect(() => save("X", body(), { a: 1 })).toThrow(/Set them aside from Pipeline from a ticket…/);
    expect(() => removedTemplate("tpl-x", { a: 1 })).toThrow(/Set them aside from Pipeline from a ticket…/);
  });

  it("sets them aside as a copy only you can read, never over another, and only when they can't be read as a list", () => {
    const dir = tempDir("tpl-aside");
    const file = setAsideTemplates({ a: 1 }, { dir, now: () => Date.UTC(2026, 10, 12, 15) });
    expect(path.basename(file)).toBe("pipelineTemplates-set-aside-2026-11-12T15-00-00-000Z.json");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ a: 1 });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(() => setAsideTemplates({ b: 2 }, { dir, now: () => Date.UTC(2026, 10, 12, 15) })).toThrow(/EEXIST/);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ a: 1 });
    expect(() => setAsideTemplates([], { dir })).toThrow("The saved templates read as a list: there's nothing to set aside.");
  });
});
