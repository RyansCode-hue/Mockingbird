import * as fs from "fs";
import * as path from "path";
import { describe, expect, it, vi } from "vitest";
import { LandscapeStore } from "../src/main/landscape";
import { PipelineStore } from "../src/main/pipeline";
import { backoffMs, PR_TTL_MS, PrWatch } from "../src/main/prWatch";
import { SessionManager } from "../src/main/sessions";
import { WireDelivery, type FrameWire } from "../src/main/wireDelivery";
import { WireTools } from "../src/main/wireTools";
import { WireService } from "../src/main/wires";
import { prMergeNote } from "../src/renderer/ticketPipelineModel";
import { BY_YOU, prNeedsYou, type PipelinePr, type PrState, type SessionInfo } from "../src/shared/types";
import { gateOf } from "../src/shared/wires";
import { tempDir } from "./helpers";

vi.mock("node-pty", () => ({
  spawn: () => ({ onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), write() {}, resize() {}, kill() {}, pid: 1 }),
}));
vi.mock("../src/main/shell", async (original) => ({
  ...(await original<typeof import("../src/main/shell")>()),
  which: (bin: string) => Promise.resolve(`/found/${bin}`),
  whichSync: (bin: string) => `/found/${bin}`,
}));

const frame: FrameWire = ({ from, to, body }) => `[from ${from.title} to ${to.title}] ${body}`;
const TICKET = "4182";
const BRANCH = "4182-org-dropdowns";
const urlOf = (id: number) => `https://dev.azure.com/acme/Portal/_git/client-portal/pullrequest/${id}`;
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

/** What a fake provider answers for a pull request: its state, or a failure. */
type Answer = Partial<PrState> | Error;

/**
 * The real stores, wire service, delivery and finishing over a mocked pty, a ticket's Coder and Verifier, and the
 * merge watch reading a fake provider: nothing here reaches Azure DevOps, GitHub or a PAT.
 */
async function setup() {
  const dir = tempDir("prwatch");
  const folder = tempDir("worktree");
  const saved: SessionInfo[] = [];
  const sessionStore = {
    settings: { claudeBin: "/bin/echo", codexBin: "/bin/echo", workTrackerPath: tempDir("worktracker") },
    state: { sessions: saved },
    upsertSession(i: SessionInfo) {
      const k = saved.findIndex((x) => x.id === i.id);
      if (k >= 0) saved[k] = i;
      else saved.push(i);
    },
    removeSession() {},
    save() {},
  };
  const m = new SessionManager(sessionStore as any);
  m.scrollbackDir = path.join(dir, "scrollback");
  const logged: string[] = [];
  const log = (context: string, err: unknown) => void logged.push(`${context}: ${err instanceof Error ? err.message : String(err)}`);
  const store = new LandscapeStore({ file: path.join(dir, "landscape.json"), emit: () => {}, log });
  const pipeline = new PipelineStore(path.join(dir, "pipeline.json"));
  let watch: PrWatch;
  const service: WireService = new WireService({
    store,
    sessions: m,
    roomOf: () => null,
    takenOver: () => null,
    log,
    delivery: { withdraw: (id, w) => d.withdraw(id, w), restoring: (w) => d.restoring(w), restored: (id) => d.restored(id) },
    merges: { view: (w, source) => watch.view(w, source), mergedBefore: (from) => watch.mergedBefore(from) },
  });
  const d: WireDelivery = new WireDelivery({
    store,
    context: (book) => service.context(book),
    sessions: m,
    reopen: async () => null,
    submits: () => true,
    frame,
    takenOver: () => null,
    log,
    notify: () => {},
  });
  const tools = new WireTools({
    store,
    rules: service,
    sessions: m,
    conversationFiles: () => ({ agent: "claude", files: [], refused: null }),
    submitOnDelivery: () => true,
    offer: (me, f, how, prompt) => d.offer(me, f, how, prompt),
    promptOf: (id) => d.promptOf(id),
    log,
  });
  const clock = { t: Date.now() };
  const answers = new Map<string, Answer>();
  const reads: { url: string; root: string }[] = [];
  const notices: { session: string | null; title: string; body: string }[] = [];
  let changed = 0;
  const newWatch = () =>
    (watch = new PrWatch({
      pipeline,
      read: async (pr, root) => {
        reads.push({ url: pr.url, root });
        const a = answers.get(pr.url) ?? {};
        if (a instanceof Error) throw a;
        return { id: pr.id, url: pr.url, title: "Org dropdowns remember the last org", base: pr.base, state: "open", conflicts: false, reviews: [], ...a };
      },
      sessions: m,
      wires: () => store.wires(),
      fill: (me, merge, ids) => tools.planMerge(me, merge, ids),
      offer: (me, f, how) => d.offer(me, f, how, null),
      notify: (session, title, body) => void notices.push({ session, title, body }),
      onChanged: () => void changed++,
      log,
      now: () => clock.t,
    }));
  newWatch();

  const coder = await m.create({ repoPath: null, cwd: folder, branchName: BRANCH, useWorktree: false, agent: "claude", title: "Coder", ticketId: TICKET, ticketTitle: "Org dropdowns" });
  const verifier = await m.create({ repoPath: null, useWorktree: false, agent: "claude", title: "Verifier" });
  const add = (settings: Record<string, unknown> = { when: "pr-merged" }, from = coder.id) => {
    const r = service.add(from, verifier.id, "handoff", settings);
    if ("refused" in r) throw new Error(r.refused);
    return r.id!;
  };
  /** A pull request Mockingbird opened from the Coder's folder, as pipeline:pr:create records it. */
  const opened = (target: "dev" | "main", id: number, more: Partial<PipelinePr> = {}) =>
    pipeline.addPr(TICKET, { target, provider: "ado", id, url: urlOf(id), repo: "Portal/client-portal", branch: BRANCH, base: target === "dev" ? "dev" : "main", at: clock.t + id, by: coder.id, root: folder, ...more }, "Org dropdowns", BY_YOU);
  const answer = (id: number, a: Answer) => answers.set(urlOf(id), a);
  const merged = (id: number, at = Date.now()) => answer(id, { state: "merged", mergeCommit: COMMIT, mergedAt: at });
  /** The next check, PR_TTL_MS on. */
  const tick = async (ms = PR_TTL_MS) => {
    clock.t += ms;
    await watch.tick();
  };
  const book = () => store.wires().book!;
  const wireOf = (id: string) => book().links[id];
  const gate = (id: string) => gateOf(id, wireOf(id), service.context(book()));
  const record = () => pipeline.get(TICKET)!;
  const prOf = (id: number) => record().prs.find((x) => x.id === id)!;
  return {
    m, store, pipeline, service, d, tools, folder, clock, answers, reads, notices, logged, coder, verifier,
    add, opened, answer, merged, tick, book, wireOf, gate, record, prOf, newWatch,
    get watch() {
      return watch;
    },
    get changed() {
      return changed;
    },
  };
}

describe("a pull request merging as a wire's When", () => {
  it("readies each pr-merged wire once per pull request, its {pr} naming the merge, and moves the ticket on from PR to dev", async () => {
    const t = await setup();
    t.opened("dev", 11);
    const w = t.add();
    expect(t.record().stage).toBe("pr-dev");
    await t.tick();
    expect(t.reads).toEqual([{ url: urlOf(11), root: t.folder }]);
    expect(t.gate(w)).toMatchObject({ state: "idle", why: "Waits for PR 11 to dev to merge." });
    expect(t.wireOf(w).pending).toBeUndefined();

    t.merged(11);
    await t.tick();
    expect(t.prOf(11)).toMatchObject({ mergedAt: expect.any(Number), mergeCommit: COMMIT });
    expect(t.record().stage).toBe("dev-test");
    expect(t.record().history.at(-1)).toMatchObject({ stage: "dev-test", by: "merge", note: `PR 11 to dev merged (${COMMIT.slice(0, 12)}).` });
    const first = t.wireOf(w).pending!;
    expect(first.body).toContain(`Pull request 11 to dev/UAT (${BRANCH} → dev), ticket #4182, merged `);
    expect(first.body).toContain(`merge commit ${COMMIT}.`);
    expect(first.body).toContain("Title: Org dropdowns remember the last org");
    expect(first.body).toContain(urlOf(11));
    expect(first.body).toContain("“Org dropdowns” hasn't finished a step with a summary yet.");
    expect(first.flags).toEqual([]);
    expect(t.wireOf(w).fired).toEqual([11]);
    expect(t.gate(w)).toMatchObject({ state: "ready", gate: "ask", pendingId: first.id });
    expect(t.notices).toEqual([{ session: t.coder.id, title: "#4182: PR 11 to dev merged", body: "Org dropdowns → Verifier: ready at the gate." }]);
    expect(t.changed).toBeGreaterThan(0);

    // a merged PR isn't read again, and its wire isn't readied again
    await t.tick();
    await t.tick();
    expect(t.reads).toHaveLength(2);
    expect(t.wireOf(w).pending!.id).toBe(first.id);
    expect(t.wireOf(w).fired).toEqual([11]);
  });

  it("readies a wire once for a PR in delivery's own write, whoever offers that merge again", async () => {
    const t = await setup();
    t.opened("dev", 11);
    const w = t.add();
    t.merged(11);
    await t.tick();
    const first = t.wireOf(w).pending!.id;
    const merge = { ticket: TICKET, pr: t.prOf(11) };
    const fill = await t.tools.planMerge(t.coder, merge, [w]);
    if ("refused" in fill) throw new Error(fill.refused);
    expect(t.d.offer(t.coder, fill, { origin: "merge" }, null)).toEqual({ steps: [], redacted: 0 });
    expect(t.wireOf(w).pending!.id).toBe(first);
    expect(t.wireOf(w).fired).toEqual([11]);
  });

  it("keeps a finish's summary for the merge rather than readying the wire, and its {summary} carries it", async () => {
    const t = await setup();
    t.opened("dev", 11);
    const w = t.add();
    const r = await t.tools.finish(t.coder, { summary: "Dropdowns remember the last org." }, "agent");
    expect(r).toMatchObject({ steps: [{ wire: w, does: "keeps", why: "it goes when its pull request merges" }] });
    expect(t.wireOf(w).pending).toBeUndefined();
    t.merged(11);
    await t.tick();
    expect(t.wireOf(w).pending!.body).toMatch(/merge commit [0-9a-f]{40}\.\nTitle: .*\n.*pullrequest\/11\n\nDropdowns remember the last org\.$/);
  });

  it("moves a ticket only from PR to dev or PR to main: at any other stage the merge is saved and the ticket stays", async () => {
    const t = await setup();
    t.opened("dev", 11);
    const w = t.add();
    t.pipeline.setStage(TICKET, "coding", { by: BY_YOU });
    const before = t.record().history.length;
    t.merged(11);
    await t.tick();
    expect(t.prOf(11).mergedAt).toEqual(expect.any(Number));
    expect(t.record().stage).toBe("coding");
    expect(t.record().history).toHaveLength(before);
    // the wire still takes it: it waits on the PR, not on the stage
    expect(t.wireOf(w).pending).toBeDefined();
  });

  it("fires for the PR to dev and then the PR to main from the same branch", async () => {
    const t = await setup();
    t.opened("dev", 11);
    const w = t.add();
    t.merged(11);
    await t.tick();
    const dev = t.wireOf(w).pending!;
    t.pipeline.setStage(TICKET, "approved", { by: BY_YOU });
    t.opened("main", 12);
    expect(t.record().stage).toBe("pr-main");
    t.answer(12, { state: "open" });
    await t.tick();
    t.merged(12);
    await t.tick();
    expect(t.record().stage).toBe("prod-test");
    expect(t.record().drafts.at(-1)).toMatchObject({ stage: "prod-test", text: "Merged to main; testing in staging/production." });
    const main = t.wireOf(w).pending!;
    expect(main.id).not.toBe(dev.id);
    expect(main.body).toContain("Pull request 12 to main");
    expect(t.wireOf(w).fired).toEqual([11, 12]);
  });

  it("puts a failed read on the wire as blocked and on the PR's row, backs off, and needs the user after three", async () => {
    const t = await setup();
    t.opened("dev", 11);
    const w = t.add();
    t.answer(11, new Error("Azure DevOps 401 Unauthorized: TF400813"));
    await t.tick();
    expect(t.prOf(11).watch).toEqual({ failures: 1, why: "Azure DevOps 401 Unauthorized: TF400813", at: t.clock.t });
    expect(t.gate(w)).toMatchObject({ state: "blocked", why: "Can't tell whether PR 11 to dev merged (1 try): Azure DevOps 401 Unauthorized: TF400813" });
    expect(t.logged).toEqual([expect.stringMatching(/^merge watch: #4182's PR 11 to dev \(.*\/pullrequest\/11\) couldn't be read, 1 try in a row; the next in 2 minutes: Azure DevOps 401/)]);
    expect(prNeedsYou(t.record(), t.prOf(11))).toBe(false);
    expect(t.notices).toEqual([]);

    // 2, then 4, then 8, then 10 minutes between tries
    expect([1, 2, 3, 4, 5].map(backoffMs)).toEqual([2, 4, 8, 10, 10].map((n) => n * 60_000));
    await t.tick(); // two minutes on: due
    expect(t.prOf(11).watch!.failures).toBe(2);
    await t.tick(); // two more: not yet, it waits four
    expect(t.reads).toHaveLength(2);
    await t.tick();
    expect(t.prOf(11).watch!.failures).toBe(3);
    expect(t.gate(w)).toMatchObject({ state: "blocked", why: expect.stringMatching(/\(3 tries\)/) });
    expect(prNeedsYou(t.record(), t.prOf(11))).toBe(true);
    expect(t.notices).toEqual([{ session: t.coder.id, title: "#4182: can't tell whether PR 11 to dev merged", body: expect.stringMatching(/^3 tries failed: Azure DevOps 401.*\nCheck now, or Mark merged…/s) }]);
    expect(prMergeNote(t.prOf(11))).toEqual({ text: "can't tell whether it merged (3 failed reads): Azure DevOps 401 Unauthorized: TF400813", problem: true });

    // Check now reads at once, whatever the back-off; a read that works clears it all
    t.answer(11, { state: "open" });
    await t.watch.checkNow(TICKET);
    expect(t.reads).toHaveLength(4);
    expect(t.prOf(11).watch).toBeUndefined();
    expect(t.gate(w)).toMatchObject({ state: "idle", why: "Waits for PR 11 to dev to merge." });
    expect(prNeedsYou(t.record(), t.prOf(11))).toBe(false);
  });

  it("says so, and needs the user, when a pull request was closed without merging, until a newer one from the branch replaces it", async () => {
    const t = await setup();
    t.opened("dev", 11);
    const w = t.add();
    t.answer(11, { state: "closed", closedAt: Date.now() });
    await t.tick();
    expect(t.prOf(11).closedAt).toEqual(expect.any(Number));
    expect(t.record().stage).toBe("pr-dev");
    expect(t.gate(w)).toMatchObject({ state: "blocked", why: "PR 11 to dev was closed without merging." });
    expect(prNeedsYou(t.record(), t.prOf(11))).toBe(true);
    expect(prMergeNote(t.prOf(11))).toEqual({ text: "closed without merging", problem: true });
    expect(t.notices).toEqual([{ session: t.coder.id, title: "#4182: PR 11 to dev was closed without merging", body: expect.stringMatching(/until another pull request from 4182-org-dropdowns merges, or you mark it merged/) }]);
    await t.tick();
    expect(t.reads).toHaveLength(1);
    // reopened and checked by hand: watched again
    t.answer(11, { state: "open" });
    await t.watch.checkNow(TICKET, urlOf(11));
    expect(t.prOf(11).closedAt).toBeUndefined();
    t.answer(11, { state: "closed", closedAt: Date.now() });
    await t.tick();
    t.opened("dev", 13);
    expect(prNeedsYou(t.record(), t.prOf(11))).toBe(false);
    expect(t.gate(w)).toMatchObject({ state: "idle", why: "Waits for PR 13 to dev to merge." });
  });

  it("waits for a pull request from the branch until there is one, and is refused for a source on no ticket or no branch", async () => {
    const t = await setup();
    const w = t.add();
    expect(t.gate(w)).toMatchObject({ state: "idle", why: `Waits for a pull request from ${BRANCH}.` });
    await t.tick();
    expect(t.reads).toEqual([]);
    const loose = await t.m.create({ repoPath: null, cwd: t.folder, branchName: "x", useWorktree: false, agent: "claude", title: "Loose" });
    expect(t.service.add(loose.id, t.verifier.id, "handoff", { when: "pr-merged" })).toEqual({ refused: expect.stringMatching(/“Loose” isn't on a ticket.*needs its source on a ticket and a branch/) });
    const noBranch = await t.m.create({ repoPath: null, cwd: t.folder, useWorktree: false, agent: "claude", title: "No branch", ticketId: TICKET });
    expect(t.service.add(noBranch.id, t.verifier.id, "handoff", { when: "pr-merged" })).toEqual({ refused: expect.stringMatching(/“No branch” isn't on a branch/) });
    expect(t.service.add(t.coder.id, t.verifier.id, "feedback", { when: "pr-merged" })).toEqual({ refused: expect.stringMatching(/^Only a handoff goes when its pull request merges/) });
  });

  it("sends a merge it saw happen by an automatic gate, and asks for one the first check after a start finds", async () => {
    const t = await setup();
    t.opened("dev", 11);
    const w = t.add({ when: "pr-merged", gate: "automatic" });
    t.answer(11, { state: "open" });
    await t.tick();
    t.merged(11);
    await t.tick();
    expect(t.wireOf(w).delivery).toMatchObject({ id: t.wireOf(w).pending!.id, automatic: true, state: expect.stringMatching(/^(queued|pasting|sent)$/) });
  });

  it("asks, automatic gate included, for a merge the first check after a start finds", async () => {
    const t = await setup();
    t.opened("dev", 11);
    const w = t.add({ when: "pr-merged", gate: "automatic" });
    t.answer(11, { state: "open" });
    await t.tick();
    // the app restarts, and the PR merged while it was closed
    t.newWatch();
    t.merged(11);
    await t.tick();
    expect(t.record().stage).toBe("dev-test");
    const p = t.wireOf(w).pending!;
    expect(t.wireOf(w).delivery).toEqual({ id: p.id, state: "held", at: expect.any(Number), why: expect.stringMatching(/^PR 11 to dev merged before Mockingbird saw it happen .* so its gate asks rather than sending by itself\.$/) });
    expect(t.gate(w)).toMatchObject({ state: "ready", pendingId: p.id });
  });

  it("lets the user mark a pull request merged, which moves the ticket and readies its wires saying so, and no tool reaches it", async () => {
    const t = await setup();
    t.opened("dev", 11);
    const w = t.add({ when: "pr-merged", gate: "automatic" });
    t.answer(11, new Error("gh: HTTP 502"));
    for (let i = 0; i < 3; i++) await t.tick(backoffMs(i));
    expect(t.prOf(11).watch!.failures).toBe(3);
    await t.watch.markMerged(TICKET, urlOf(11));
    expect(t.prOf(11)).toMatchObject({ mergedAt: t.clock.t, mergedBy: "you" });
    expect(t.prOf(11).watch).toBeUndefined();
    expect(t.prOf(11).mergeCommit).toBeUndefined();
    expect(t.record().stage).toBe("dev-test");
    expect(t.record().history.at(-1)).toMatchObject({ by: "you", note: "You marked PR 11 to dev merged: Mockingbird couldn't read it (gh: HTTP 502)." });
    const p = t.wireOf(w).pending!;
    expect(p.body).toContain("its merge commit isn't known.");
    expect(p.body).toContain("The user marked it merged, rather than Azure DevOps saying so.");
    expect(p.flags).toEqual(["You marked its pull request merged, rather than its provider saying so: its merge commit isn't known."]);
    expect(t.wireOf(w).delivery).toMatchObject({ id: p.id, state: "held", why: "You marked PR 11 to dev merged, so its gate asks rather than sending by itself." });
    await expect(t.watch.markMerged(TICKET, urlOf(11))).rejects.toThrow(/merged already/);
    await expect(t.watch.markMerged(TICKET, urlOf(99))).rejects.toThrow(/has no pull request/);

    // Mark merged is a window call: no tool, schema or the MCP router names it, and index.ts calls it from its handler alone
    for (const f of ["ticketTools.ts", "ticketToolSchemas.ts", "wireTools.ts", "wireToolSchemas.ts", "messaging.ts", "agents.ts"]) {
      const text = fs.readFileSync(path.join(__dirname, "../src/main", f), "utf8");
      expect(text, f).not.toMatch(/mark_?merged/i);
      expect(text, f).not.toMatch(/prMerged|PrWatch|pipeline:pr:check/);
    }
    const index = fs.readFileSync(path.join(__dirname, "../src/main/index.ts"), "utf8");
    expect(index.match(/prWatch\.markMerged\(/g)).toHaveLength(1);
    expect(index).toMatch(/handle\("pipeline:pr:markMerged", \(id, url\) => pipelineDo\(\(\) => prWatch\.markMerged\(/);
  });

  it("doesn't ready a wire for a merge from before it waited: one made after, or set to wait after", async () => {
    const t = await setup();
    t.opened("dev", 11);
    t.merged(11, Date.now() - 60_000);
    await t.watch.checkNow(TICKET);
    expect(t.prOf(11).mergedAt).toEqual(expect.any(Number));
    const made = t.add();
    await t.tick();
    expect(t.wireOf(made).pending).toBeUndefined();
    expect(t.wireOf(made).fired).toBeUndefined();
    // a merged PR isn't read again, though a wire from its branch still waits
    expect(t.reads).toHaveLength(1);
    expect(t.logged).toEqual([]);
    t.service.remove(made);
    const later = t.add({});
    expect(t.service.set(later, { when: "pr-merged" })).toMatchObject({ state: expect.anything() });
    expect(t.wireOf(later).fired).toEqual([11]);
    await t.tick();
    expect(t.wireOf(later).pending).toBeUndefined();
  });

  it("reads an older PR, with no folder of its own, in a session's on its branch, and says so when there's none", async () => {
    const t = await setup();
    t.opened("dev", 11, { root: undefined });
    t.add();
    await t.tick();
    expect(t.reads).toEqual([{ url: urlOf(11), root: t.folder }]);
    t.opened("dev", 12, { root: path.join(t.folder, "gone"), branch: "4182-elsewhere" });
    await t.tick();
    expect(t.prOf(12).watch?.why).toMatch(/its folder, .*gone, isn't there any more, and no session of #4182's is on 4182-elsewhere/);
  });

  it("leaves the user's untick in place: a merge isn't the user's move", async () => {
    const t = await setup();
    t.opened("dev", 11);
    t.pipeline.setCheck(TICKET, "dev:tests", false, BY_YOU);
    expect(t.record().unticked?.["dev:tests"]).toBeDefined();
    t.merged(11);
    await t.tick();
    expect(t.record().stage).toBe("dev-test");
    expect(t.record().unticked?.["dev:tests"]).toBeDefined();
  });

  it("watches only what something waits on, and clears a failure nothing waits on any more", async () => {
    const t = await setup();
    t.opened("dev", 11);
    t.answer(11, new Error("offline"));
    await t.tick();
    expect(t.prOf(11).watch?.failures).toBe(1);
    // moved on by hand: nothing waits on the PR, so it isn't read and its failure goes
    t.pipeline.setStage(TICKET, "dev-test", { by: BY_YOU });
    await t.tick(backoffMs(1));
    expect(t.reads).toHaveLength(1);
    expect(t.prOf(11).watch).toBeUndefined();
    // a Done ticket's never needs the user
    t.pipeline.setStage(TICKET, "done", { by: BY_YOU });
    expect(prNeedsYou(t.record(), { ...t.prOf(11), watch: { failures: 5, why: "x", at: 0 } })).toBe(false);
  });
});
