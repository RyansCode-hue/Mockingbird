import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it, onTestFailed } from "vitest";
import { appE2E, launchApp, mainLog, quitApp, untilTrue, type AppInstance } from "./e2e/appInstance";
import { alive, descendants, killOrphans } from "./e2e/processes";
import { fakeClis, fakeLog, killOnPaste, type FakeEntry } from "./e2e/fakeCli";
import { fakeGithub, ghCalls, ghPrs, ghResolved, mergePr, sshCalls } from "./e2e/fakeGithub";
import { git, makeRepo, tempDir } from "./helpers";
import { BUILT_IN_TEMPLATE, ticketLine, withTicket, type LayOutReply } from "../src/shared/pipelineTemplates";
import type { PlanView } from "../src/shared/plans";
import type { SessionInfo, TicketPipeline } from "../src/shared/types";
import type { Wire, WireBook } from "../src/shared/wires";

/**
 * A whole wire run in the real app (dist/, under Electron), with stand-ins for Claude Code and Codex set as Settings'
 * binaries (test/e2e/fakeCli.cjs): they read their prompts raw, run the hooks Mockingbird installed, keep their
 * conversations where the CLIs do, and call finish_step through Mockingbird's MCP server started inside their panes.
 * Nothing calls a model. Builder (Claude) hands off to Reviewer (Codex), a step not started yet, through a wire that
 * asks: Builder commits and finishes; its gate holds what it said across a quit; the person's Send in the window's
 * popover starts Reviewer at Builder's commit and its queue delivers the handoff once; a run that ends while the next
 * handoff is being pasted leaves it marked as may-have-arrived, never pasted again by itself, and the person's Send
 * again delivers it once. A ticket run starts an Orchestrator from the built-in template: its plan, opened from Needs
 * you, is laid out as its dialog shows it; the Coder's pull request is opened only at the PR form's click, on a stand-in
 * GitHub (test/e2e/fakeGithub.ts: its ssh and gh, never the real ones); and the merge the watch reads readies the
 * Verifier's wire, whose gate asks. Windows open on screen while it runs, so it's opt-in:
 *
 *   npm run build && MB_E2E_APP=1 npx vitest run test/wireRunApp.e2e.test.ts
 */

const bookOf = (home: string): WireBook => JSON.parse(fs.readFileSync(path.join(home, ".mockingbird", "landscape.json"), "utf8")).wires;
const live = (a: AppInstance) => a.evaluate<SessionInfo[]>("window.mb.listSessions()");
const planned = (a: AppInstance) => a.evaluate<SessionInfo[]>("window.mb.plannedSessions()");
const liveOne = async (a: AppInstance, id: string) => (await live(a)).find((s) => s.id === id) ?? null;
const ofKind = (log: FakeEntry[], kind: FakeEntry["kind"]) => log.filter((e) => e.kind === kind);
/** What was submitted to a stand-in as a prompt holding `text`, every launch's. */
const promptsWith = (log: FakeEntry[], text: string) => ofKind(log, "prompt").filter((e) => e.text!.includes(text));
const pastesWith = (log: FakeEntry[], text: string) => ofKind(log, "paste").filter((e) => e.text!.includes(text));
/** The names the window's Closed sessions list shows. */
const closedRows = (a: AppInstance) => a.evaluate<string[]>(`[...document.querySelectorAll("[data-closed-list] .lt-closed-row .lt-t")].map((e) => e.textContent)`);
/** Type into a pane's terminal as a person does, then Enter. */
const typeInto = (a: AppInstance, id: string, text: string) => a.evaluate(`window.mb.sessionWrite(${JSON.stringify(id)}, ${JSON.stringify(`${text}\r`)})`);

const exits = new WeakMap<AppInstance, Promise<NodeJS.Signals | null>>();
/** The app's exit, with the signal that ended it. */
function exitOf(a: AppInstance): Promise<NodeJS.Signals | null> {
  let p = exits.get(a);
  if (!p) {
    p = new Promise((r) => (a.child.exitCode !== null || a.child.signalCode !== null ? r(a.child.signalCode) : a.child.once("exit", (_code, signal) => r(signal))));
    exits.set(a, p);
  }
  return p;
}

/** A DevTools call that settles undefined once the app has exited, rather than never: its window goes with it. */
const cdp = (a: AppInstance, method: string, params: Record<string, unknown>): Promise<unknown> => Promise.race([a.send(method, params), exitOf(a).then(() => undefined)]);

/** A person's click at a point of the window: the pointer moves there, presses and lets go. */
async function clickAt(a: AppInstance, x: number, y: number) {
  await cdp(a, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await cdp(a, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await cdp(a, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
}

type Pt = { x: number; y: number };

/**
 * Open wire `wireId`'s send popover as a person does: bring its gate dot to the middle of the landscape at a zoom that
 * draws it (⌘ and the wheel zoom about the pointer, the wheel alone pans), then click the dot. The popover's face class.
 */
async function openGate(a: AppInstance, wireId: string): Promise<string> {
  // where its centre is on screen, from its place in the drawing: below the live band it's drawn with no radius, so it
  // has no box of its own; `r` is its radius on screen, 0 until it takes clicks. Gate dots are drawn in their own layer
  // above the wires (svg.ls-wire-dots), hidden while their wire is, or while it runs wholly beneath what takes clicks
  const dot = () =>
    a.evaluate<(Pt & { r: number }) | null>(
      `(() => { const c = document.querySelector('svg.ls-wire-dots > circle.dot[data-wire=${JSON.stringify(wireId)}]'); if (!c || c.style.display === "none") return null; const m = c.getScreenCTM(); if (!m) return null; const p = new DOMPoint(c.cx.baseVal.value, c.cy.baseVal.value).matrixTransform(m); return { x: p.x, y: p.y, r: c.getBoundingClientRect().width / 2 }; })()`
    );
  const zoom = () => a.evaluate<number>(`Number(/scale\\(([\\d.]+)\\)/.exec(document.querySelector(".ls-world")?.style.transform ?? "")?.[1] ?? 0)`);
  await untilTrue(`wire ${wireId}'s gate dot drawn`, async () => !!(await dot()), 30_000).catch(async (err: Error) => {
    const drawn = await a.evaluate<string>(
      `JSON.stringify({ wires: [...document.querySelectorAll("g.ls-wire")].map((g) => { const c = document.querySelector('svg.ls-wire-dots > circle.dot[data-wire="' + CSS.escape(g.dataset.wire) + '"]'); return { id: g.dataset.wire, shown: g.style.display !== "none", dot: c ? (c.style.display === "none" ? "hidden:" + (c.dataset.fit ?? "") : "shown") : false }; }), modal: !!document.querySelector(".modal") })`
    );
    throw new Error(`${err.message}; drawn: ${drawn}`);
  });
  const vp = await a.evaluate<{ left: number; top: number; width: number; height: number }>(
    `(() => { const r = document.querySelector(".ls-viewport").getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })()`
  );
  const mid = { x: Math.round(vp.left + vp.width / 2), y: Math.round(vp.top + vp.height / 2) };
  // workspaces take the mouse and draw their wires' dots from 75%
  for (let i = 0; i < 10 && (await zoom()) < 0.8; i++) {
    const was = await zoom();
    // about the dot while it's on screen (a gate dot sits at the nearest clear point along its wire, which zoomed out
    // can be past the view's edge); otherwise about the middle, where the pans below bring it
    const d = await dot();
    const onScreen = !!d && d.x > vp.left && d.x < vp.left + vp.width && d.y > vp.top && d.y < vp.top + vp.height;
    const at = onScreen ? d! : mid;
    await cdp(a, "Input.dispatchMouseEvent", { type: "mouseWheel", x: at.x, y: at.y, deltaX: 0, deltaY: -100, modifiers: 4 });
    await untilTrue("the landscape to zoom in", async () => (await zoom()) !== was, 5000).catch(async (err: Error) => {
      const under = await a.evaluate<string>(
        `(() => { const e = document.elementFromPoint(${at.x}, ${at.y}); return JSON.stringify({ at: ${JSON.stringify(at)}, zoom: ${was}, viewport: ${JSON.stringify(vp)}, under: e ? e.outerHTML.slice(0, 160) : null, inViewport: !!e?.closest(".ls-viewport") }); })()`
      );
      throw new Error(`${err.message}: ${under}`);
    });
  }
  await untilTrue("the dot drawn at 80% or more", async () => (await zoom()) >= 0.8 && !!(await dot())?.r, 10_000);
  const open = () => a.evaluate<boolean>(`!!document.querySelector(".wg-pop")`);
  for (let tries = 1; ; tries++) {
    // the layout can still move it (a list read in, a workspace drawn anew), so it's measured after each pan
    await untilTrue("the dot in the landscape's middle", async () => {
      const p = await dot();
      if (!p) return false;
      if (Math.hypot(p.x - mid.x, p.y - mid.y) < 2) return true;
      await cdp(a, "Input.dispatchMouseEvent", { type: "mouseWheel", x: vp.left + 20, y: vp.top + 20, deltaX: p.x - mid.x, deltaY: p.y - mid.y });
      return false;
    }, 20_000);
    const covered = await a.evaluate<string>(
      `(() => { const e = document.elementFromPoint(${mid.x}, ${mid.y}); return !e ? "nothing" : e.closest(".ls-viewport") && !e.closest(".ls-node, button, input, textarea, .wg-pop") ? "" : e.outerHTML.slice(0, 200); })()`
    );
    if (covered) throw new Error(`wire ${wireId}'s gate dot is under ${covered}`);
    await clickAt(a, mid.x, mid.y);
    const opened = await untilTrue("the send popover", open, 5000).then(
      () => true,
      () => false
    );
    if (opened) break;
    // the dot moved between its last measure and the click: it's brought back and clicked again
    if (tries === 3) throw new Error(`wire ${wireId}'s gate dot was clicked ${tries} times and no popover opened`);
  }
  return a.evaluate<string>(`[...document.querySelector(".wg-pop").classList].find((c) => c.startsWith("f-"))`);
}

/** What the open popover shows: the ends, the lines under them, and what it sends. */
const popover = (a: AppInstance) =>
  a.evaluate<{ ends: string; why: string[]; body: string }>(
    `(() => { const p = document.querySelector(".wg-pop"); return { ends: p.querySelector(".wr-ends")?.textContent ?? "", why: [...p.querySelectorAll(".wg-why")].map((e) => e.textContent), body: p.querySelector("textarea.wg-body")?.value ?? "" }; })()`
  );

/** The open popover's button `act` (Send, Send again…), where it is and whether it takes a click. */
const button = (a: AppInstance, act: string) =>
  a.evaluate<(Pt & { off: boolean; label: string }) | null>(
    `(() => { const b = document.querySelector('.wg-pop button[data-act=${JSON.stringify(act)}]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, off: b.disabled, label: b.textContent }; })()`
  );

/**
 * Click the open popover's button `act` as a person does, once it has been up longer than its settle (answerGuard's
 * ANSWER_SETTLE_MS holds a click made as it opens). A click the popover didn't take (held, as it does one made while its
 * content settles: the button back as it was, never shown under way) is made again. With `closes`, waits for it to close
 * with its act done, saying why when it didn't.
 */
async function press(a: AppInstance, act: string, closes = true): Promise<void> {
  const settle = Date.now() + 800;
  await untilTrue(`the popover's ${act} to take a click`, async () => {
    const b = await button(a, act);
    return !!b && !b.off && Date.now() > settle;
  }, 10_000);
  for (let tries = 1; ; tries++) {
    const b = (await button(a, act))!;
    await clickAt(a, b.x, b.y);
    if (!closes) return;
    const clicked = Date.now();
    let underWay = false;
    let held = false;
    await untilTrue(`the popover to close after ${act}`, async () => {
      if (!(await a.evaluate<boolean>(`!!document.querySelector(".wg-pop")`))) return true;
      const err = await a.evaluate<string | null>(`document.querySelector(".wg-pop .wr-err")?.textContent ?? null`);
      if (err) throw new Error(`${act} was refused: ${err}`);
      const now = await button(a, act);
      if (now && now.label !== b.label) underWay = true;
      held = !underWay && !!now && !now.off && Date.now() - clicked > 3000;
      return held;
    }, 90_000);
    if (!held) return;
    if (tries === 4) throw new Error(`the popover's ${act} took none of ${tries} clicks`);
  }
}

/** The run as it stands, for a failure: the wire book, the last lines each stand-in logged, and the end of main.log. */
function runState(home: string): string {
  const parts: string[] = [];
  try {
    parts.push(`wires: ${JSON.stringify(bookOf(home).links)}`);
  } catch (err) {
    parts.push(`wires: unreadable (${(err as Error).message})`);
  }
  const dir = path.join(home, "fake-cli");
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl")) : []) {
    const lines = fakeLog(home, f.slice(0, -".jsonl".length)).slice(-12);
    parts.push(`${f}:\n${lines.map((e) => `  ${e.at} ${e.pid} ${e.kind}${e.how ? ` (${e.how})` : ""}${e.text ? ` ${JSON.stringify(e.text.slice(0, 80))}` : ""}${e.reply ? ` ${JSON.stringify(e.reply.slice(0, 80))}` : ""}${e.message ? ` ${e.message.slice(0, 300)}` : ""}`).join("\n")}`);
  }
  parts.push(`main.log:\n${mainLog({ home }).slice(-4000)}`);
  return `[e2e] the run as it failed:\n${parts.join("\n")}`;
}

/** What's still running of `pids`, each with its parent and command line, for a failure to name. */
const stillRunning = (pids: number[]): string => {
  const left = pids.filter(alive);
  if (!left.length) return "";
  try {
    return execFileSync("/bin/ps", ["-o", "pid=,ppid=,command=", "-p", left.join(",")], { encoding: "utf8" }).trim();
  } catch (err) {
    return `${left.join(", ")} (ps: ${(err as Error).message.split("\n")[0]})`;
  }
};

/** Paste into a pane's terminal as a person does (a bracketed paste, as the terminal sends one), then Enter. */
const pasteInto = (a: AppInstance, id: string, text: string) => a.evaluate(`window.mb.sessionWrite(${JSON.stringify(id)}, ${JSON.stringify(`\x1b[200~${text}\x1b[201~\r`)})`);

/** The wire book's wires, none before the first is made. */
const linksOf = (home: string): Record<string, Wire> => {
  const f = path.join(home, ".mockingbird", "landscape.json");
  return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")).wires?.links ?? {}) : {};
};

/** Ticket `id`'s record in the ticket pipeline, as the window reads it. */
async function pipelineOf(a: AppInstance, id: string): Promise<TicketPipeline> {
  const all = await a.evaluate<Record<string, TicketPipeline> | { error: string }>("window.mb.pipelineAll()");
  if ("error" in all && typeof all.error === "string") throw new Error(`the ticket pipeline can't be read: ${all.error}`);
  const p = (all as Record<string, TicketPipeline>)[id];
  if (!p) throw new Error(`#${id} isn't in the ticket pipeline`);
  return p;
}

/**
 * Click element `sel` as a person does: once it takes clicks and has for a moment (the window's settles hold a click
 * made as a row, a dialog or a form's facts arrive), scrolled into view, and only when nothing covers it.
 */
async function clickEl(a: AppInstance, sel: string, what: string): Promise<void> {
  const S = JSON.stringify(sel);
  let since = 0;
  await untilTrue(`${what} to take a click`, async () => {
    const on = await a.evaluate<boolean>(`(() => { const b = document.querySelector(${S}); return !!b && !b.disabled && b.getClientRects().length > 0; })()`);
    if (!on) since = 0;
    else since ||= Date.now();
    return on && Date.now() - since > 800;
  }, 30_000);
  const at = await a.evaluate<(Pt & { covered: string }) | null>(
    `(() => { const b = document.querySelector(${S}); if (!b) return null; b.scrollIntoView({ block: "center" }); const r = b.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2; const e = document.elementFromPoint(x, y); return { x, y, covered: e && (e === b || b.contains(e)) ? "" : (e?.outerHTML.slice(0, 200) ?? "nothing") }; })()`
  );
  if (!at) throw new Error(`${what} went before its click`);
  if (at.covered) throw new Error(`${what} is under ${at.covered}`);
  await clickAt(a, at.x, at.y);
}

const textOf = (a: AppInstance, sel: string) => a.evaluate<string | null>(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`);
const isThere = (a: AppInstance, sel: string) => a.evaluate<boolean>(`!!document.querySelector(${JSON.stringify(sel)})`);

/** Needs you's tray, opened from its button when it isn't open. */
async function openNeeds(a: AppInstance): Promise<void> {
  if (!(await isThere(a, ".ny-tray"))) await clickEl(a, ".ny-btn", "the Needs you button");
  await untilTrue("the Needs you tray", () => isThere(a, ".ny-tray"), 10_000);
}

describe.skipIf(!appE2E)("a whole wire run in the real app", () => {
  it("a finish waits at its gate across a quit, Send starts the step at the finisher's commit and delivers once, and a paste the run's end cut off may have arrived and is never pasted again by itself", async () => {
    const seed = makeRepo({ "README.md": "parser\n" }, "parser");
    const bare = path.join(tempDir("origin"), "parser.git");
    execFileSync("git", ["clone", "--bare", "-q", seed, bare]);
    const code = tempDir("code");
    const clone = path.join(code, "parser");
    execFileSync("git", ["clone", "-q", bare, clone]);
    const originMain = git(bare, "rev-parse", "main");
    const bins = fakeClis(tempDir("bins"));
    let app = await launchApp("Runner", "", { settings: { claudeBin: bins.claude, codexBin: bins.codex, repoRoots: [code] } });
    const { home } = app;
    // a failure says where the run was: the wire book, what each stand-in saw last, and main's log
    onTestFailed(() => console.error(runState(home)));
    try {
      // the hooks the stand-ins run, installed as Settings' button installs them
      expect(await app.evaluate<{ installed: boolean }>("window.mb.installHooks()")).toMatchObject({ installed: true });
      const builder = await app.evaluate<SessionInfo & { error?: string }>(
        `window.mb.createSession({ repoPath: ${JSON.stringify(clone)}, useWorktree: true, branchName: "feat-parser", baseBranch: "main", agent: "claude", title: "Builder" })`
      );
      expect(builder.error).toBeUndefined();
      const A = builder.id;
      // idle once its SessionStart hook is read: its status comes from the hooks it ran
      await untilTrue("Builder at its prompt", async () => (await liveOne(app, A))?.status === "idle", 60_000);
      const reviewer = await app.evaluate<SessionInfo & { error?: string }>(
        `window.mb.planSession({ after: ${JSON.stringify(A)}, title: "Reviewer", agent: "codex", repoPath: ${JSON.stringify(clone)}, worktree: true, taskGroup: null, prompt: "Review what Builder hands you." })`
      );
      expect(reviewer).toMatchObject({ title: "Reviewer", planned: { worktree: true } });
      const B = reviewer.id;
      const [wireId, wire] = Object.entries(bookOf(home).links)[0] as [string, Wire];
      expect(wire).toMatchObject({ from: A, to: B, type: "handoff", when: "finished", gate: "ask" });

      // 1. Builder commits and finishes its step: the handoff waits at its gate, which asks
      await typeInto(app, A, "@commit parser.txt; @finish Built the parser: see parser.txt.");
      await untilTrue("Builder's finish_step answered", async () => ofKind(fakeLog(home, A), "tool").length === 1);
      await untilTrue("Builder's turn over", async () => ofKind(fakeLog(home, A), "turn-ended").length === 1 && (await liveOne(app, A))?.status === "idle");
      const finished = ofKind(fakeLog(home, A), "tool")[0];
      expect(finished).toMatchObject({ name: "finish_step", isError: false });
      expect(finished.reply).toMatch(/^Step finished.*\n- the handoff wire to "Reviewer": readied\. It waits at the wire's gate for the user to send\./);
      const builderSha = ofKind(fakeLog(home, A), "commit")[0].sha!;
      expect(git(builder.cwd, "rev-parse", "HEAD")).toBe(builderSha);
      expect(builderSha).not.toBe(originMain);
      const first = bookOf(home).links[wireId];
      expect(first.pending).toMatchObject({ body: "Built the parser: see parser.txt.", flags: [] });
      expect(first.delivery).toBeUndefined();
      const p1 = first.pending!.id;

      // 2. quit with it waiting, and start again: it waits as it was, and nothing was sent or started
      app.close();
      expect(await quitApp(app.child)).toEqual({ killed: false, leftovers: [] });
      app = await launchApp("Runner", "", { home, keepState: true });
      expect(bookOf(home).links[wireId]).toMatchObject({ pending: { id: p1, body: "Built the parser: see parser.txt." } });
      expect(bookOf(home).links[wireId].delivery).toBeUndefined();
      expect((await planned(app)).map((s) => s.id)).toEqual([B]);
      expect(await liveOne(app, B)).toBeNull();
      expect(fakeLog(home, B)).toEqual([]);

      // the person's Send, in the window's popover: what it shows is what waited, and sending starts Reviewer
      expect(await openGate(app, wireId)).toBe("f-ready");
      const shown = await popover(app);
      expect(shown).toMatchObject({ ends: "Builder → Reviewer", body: "Built the parser: see parser.txt." });
      expect(shown.why).toContain("“Reviewer” hasn't started: sending starts it.");
      await press(app, "send");
      await untilTrue("the handoff sent", async () => bookOf(home).links[wireId].delivery?.state === "sent", 90_000);
      expect(bookOf(home).links[wireId]).toMatchObject({ delivery: { id: p1, state: "sent" } });
      expect(bookOf(home).links[wireId].pending).toBeUndefined();

      // Reviewer started at Builder's commit, not origin's main, on a branch of its own after Builder's
      const started = (await liveOne(app, B))!;
      expect(started).toMatchObject({ agent: "codex", branch: "feat-parser-reviewer" });
      expect(started.planned).toBeUndefined();
      expect(git(started.cwd, "rev-parse", "HEAD")).toBe(builderSha);
      expect(await app.evaluate<string>(`window.mb.sessionBuffer(${JSON.stringify(B)})`)).toContain(`Started at “Builder”'s commit ${builderSha.slice(0, 7)}`);
      // its own prompt first (Codex's, in its arguments), then its queue's: the handoff, labelled, once
      await untilTrue("Reviewer's turn on the handoff over", async () => ofKind(fakeLog(home, B), "turn-ended").length === 2 && (await liveOne(app, B))?.status === "idle", 30_000);
      const reviewerLog = fakeLog(home, B);
      expect(ofKind(reviewerLog, "prompt").map((e) => e.how)).toEqual(["argv", "pasted"]);
      expect(ofKind(reviewerLog, "prompt")[0].text).toBe("Review what Builder hands you.");
      const handoff = ofKind(reviewerLog, "prompt")[1].text!;
      expect(handoff).toMatch(/^\[Handoff from .*Builder.*, through a handoff wire\.\n.*The user read this and sent it\./);
      expect(handoff).toContain("Built the parser: see parser.txt.");
      expect(promptsWith(reviewerLog, "Built the parser").length).toBe(1);

      // 3. Builder, reopened, finishes again; the run ends as that handoff reaches Reviewer's prompt, before its Enter.
      // The stand-in has the 120 ms before the Enter to end it. When the Enter wins (a loaded machine), that handoff was
      // simply sent: the app is started again and Builder finishes once more, a new handoff, as many as three times.
      let cutOff: { id: string; body: string } | null = null;
      let killedLaunch: FakeEntry | null = null;
      for (let attempt = 1; !cutOff; attempt++) {
        const finishes = ofKind(fakeLog(home, A), "tool").length;
        expect(await app.evaluate<SessionInfo | { error: string }>(`window.mb.relaunchSession(${JSON.stringify(A)})`)).toMatchObject({ id: A });
        await untilTrue("Builder at its prompt again", async () => (await liveOne(app, A))?.status === "idle", 60_000);
        // started by main, not by one of the window's own acts: the window's Closed sessions list no longer holds it
        await untilTrue("Builder off the Closed sessions list", async () => !(await closedRows(app)).includes("Builder"), 10_000);
        const body = `Fixed the edge cases the review will look for (take ${attempt}).`;
        await typeInto(app, A, `@finish ${body}`);
        await untilTrue("Builder's finish", async () => ofKind(fakeLog(home, A), "tool").length === finishes + 1);
        const waiting = bookOf(home).links[wireId].pending!;
        expect(waiting).toMatchObject({ body });
        expect(waiting.id).not.toBe(p1);
        expect(await openGate(app, wireId)).toBe("f-ready");
        expect((await popover(app)).body).toBe(body);
        killOnPaste(home, app.child.pid!, body);
        const ranThen = descendants(app.child.pid!);
        await press(app, "send", false);
        expect(await Promise.race([exitOf(app), new Promise((r) => setTimeout(() => r("still running 60 s after Send"), 60_000))])).toBe("SIGKILL");
        app.close();
        // the panes' stand-ins end with their terminals, and their tool servers with them
        await untilTrue("what the run had started to end with it", async () => ranThen.every((p) => !alive(p)), 30_000).catch((err: Error) => {
          throw new Error(`${err.message}; still running:\n${stillRunning(ranThen)}`);
        });
        expect(killOrphans(ranThen)).toEqual([]);
        const cut = bookOf(home).links[wireId];
        if (cut.delivery?.state === "sent") {
          // the Enter was written before the app was killed: sent is what main saw happen
          expect(cut.delivery.id).toBe(waiting.id);
          if (attempt === 3) throw new Error("the paste's Enter beat the stand-in's kill 3 times: it never had a paste to cut off");
          console.warn(`[e2e] take ${attempt}: the paste's Enter beat the stand-in's kill, so that handoff was sent; trying again`);
          app = await launchApp("Runner", "", { home, keepState: true });
          continue;
        }
        expect(cut).toMatchObject({ pending: { id: waiting.id }, delivery: { id: waiting.id, state: "pasting" } });
        const pasted = pastesWith(fakeLog(home, B), body);
        expect(pasted.length).toBe(1);
        expect(promptsWith(fakeLog(home, B), body)).toEqual([]);
        cutOff = { id: waiting.id, body };
        killedLaunch = pasted[0];
      }
      const second = cutOff;

      // started again: it may have arrived, so it's for the person, and nothing pastes it again by itself
      app = await launchApp("Runner", "", { home, keepState: true });
      await untilTrue("what was being pasted settled", async () => bookOf(home).links[wireId].delivery?.state === "unconfirmed", 15_000);
      expect(bookOf(home).links[wireId]).toMatchObject({
        pending: { id: second.id },
        delivery: { id: second.id, state: "unconfirmed", why: "Mockingbird stopped while this was being pasted into “Reviewer”: it may have reached it. Send it again, or mark it sent." },
      });
      expect(mainLog(app)).toMatch(new RegExp(`wires: ${wireId}'s delivery ${second.id} is unconfirmed`));
      expect(await liveOne(app, B)).toBeNull();
      const before = fakeLog(home, B).length;

      // the person's Send again, in the popover's may-have-arrived face: it reopens Reviewer and delivers it once
      expect(await openGate(app, wireId)).toBe("f-unconfirmed");
      expect((await popover(app)).body).toBe(second.body);
      expect(fakeLog(home, B).length).toBe(before);
      await press(app, "again");
      await untilTrue("sent again", async () => bookOf(home).links[wireId].delivery?.state === "sent", 90_000);
      const again = bookOf(home).links[wireId];
      expect(again.delivery!.id).not.toBe(second.id);
      expect(again.pending).toBeUndefined();
      const turnOver = () => {
        const log = fakeLog(home, B);
        const last = ofKind(log, "started").at(-1)!;
        return promptsWith(log, second.body).length === 1 && log.filter((e) => e.pid === last.pid).at(-1)?.kind === "turn-ended";
      };
      await untilTrue("Reviewer's turn on it over", async () => turnOver(), 30_000);
      const all = fakeLog(home, B);
      const reopened = ofKind(all, "started").at(-1)!;
      expect(reopened).toMatchObject({ resumed: true, conv: ofKind(all, "started")[0].conv });
      // pasted twice in all, into the launch the run's end took and into the one Send again reopened; submitted once
      expect(pastesWith(all, second.body).map((e) => e.pid)).toEqual([killedLaunch!.pid, reopened.pid]);
      expect(promptsWith(all, second.body)).toEqual([expect.objectContaining({ pid: reopened.pid, how: "pasted" })]);
      expect(promptsWith(all, "Built the parser").length).toBe(1);
      // reopened by the Send, it's running, not listed as closed with a Reopen of its own
      await untilTrue("Reviewer off the Closed sessions list", async () => !(await closedRows(app)).includes("Reviewer"), 10_000);

      app.close();
      expect(await quitApp(app.child)).toEqual({ killed: false, leftovers: [] });
    } finally {
      app.close();
      await quitApp(app.child);
    }
  }, 300_000);

  it("a ticket run: the Orchestrator's plan, opened from Needs you, is laid out as its dialog shows it, the Coder's pull request is opened only at the form's click, and the merge the watch reads readies the Verifier's wire, whose gate asks", async () => {
    const TICKET = "4182";
    const TITLE = "Stream the parser's input";
    const seed = makeRepo({ "README.md": "parser\n" }, "parser");
    git(seed, "branch", "dev");
    const bare = path.join(tempDir("origin"), "parser.git");
    execFileSync("git", ["clone", "--bare", "-q", seed, bare]);
    const code = tempDir("code");
    const clone = path.join(code, "parser");
    execFileSync("git", ["clone", "-q", bare, clone]);
    const home = tempDir("ticketer");
    // origin is on "GitHub": its ssh and gh are stand-ins, and the gh Mockingbird's login shell finds is the stand-in
    const github = fakeGithub(tempDir("github"), home, "acme/parser", bare);
    git(clone, "remote", "set-url", "origin", github.origin);
    expect(ghResolved(home)).toBe(path.join(github.bin, "gh"));
    const onOrigin = (branch: string): string | null => {
      try {
        return execFileSync("git", ["--git-dir", bare, "rev-parse", "--verify", "-q", `refs/heads/${branch}`], { encoding: "utf8" }).trim();
      } catch {
        return null;
      }
    };
    const created = () => ghCalls(home).filter((c) => c.args[0] === "pr" && c.args[1] === "create");
    const bins = fakeClis(tempDir("bins"));
    const app = await launchApp("Ticketer", "", { home, settings: { claudeBin: bins.claude, codexBin: bins.codex, repoRoots: [code] }, env: github.env });
    onTestFailed(() => console.error(runState(home)));
    const turnsOf = (id: string) => ofKind(fakeLog(home, id), "turn-ended").length;
    /**
     * Wait for `id` to have had `n` turns or more and be done for now: at its prompt with nothing queued, its stand-in's
     * last turn over, and still so a moment later (a queued notice is pasted at idle, and read as working only once its
     * hook is), so what Mockingbird had for it has all arrived.
     */
    const settled = (id: string, n: number, what: string) => {
      let since = 0;
      return untilTrue(what, async () => {
        const s = await liveOne(app, id);
        const quiet = turnsOf(id) >= n && fakeLog(home, id).at(-1)?.kind === "turn-ended" && s?.status === "idle" && !s.queuedCount;
        if (!quiet) since = 0;
        else since ||= Date.now();
        return quiet && Date.now() - since > 1500;
      }, 60_000);
    };
    /** Paste `text` into `id` once it's settled, and the tool calls of that turn, `calls` of them. */
    const toolsAfter = async (id: string, text: string, calls: number) => {
      await settled(id, 1, `${id} settled`);
      const had = ofKind(fakeLog(home, id), "tool").length;
      const turns = turnsOf(id);
      await pasteInto(app, id, text);
      await settled(id, turns + 1, `${id}'s turn on ${text.slice(0, 40)}`);
      const made = ofKind(fakeLog(home, id), "tool").slice(had);
      expect(made.length).toBe(calls);
      return made;
    };
    try {
      expect(await app.evaluate<{ installed: boolean }>("window.mb.installHooks()")).toMatchObject({ installed: true });

      // 1. Pipeline from a ticket… with the built-in template: only its Orchestrator is made, on the ticket's branch
      const { startFirst, steps, wires } = BUILT_IN_TEMPLATE;
      const req = { name: BUILT_IN_TEMPLATE.name, template: { startFirst, steps, wires }, ticketId: TICKET, ticketTitle: TITLE, ticketDescription: "Read the input as a stream, not whole.", repoPath: clone, base: "dev", area: "Parser" };
      let started = null as LayOutReply | null;
      await untilTrue("the Orchestrator started", async () => {
        const r = await app.evaluate<LayOutReply | { error: string }>(`window.mb.templatesLayOut(${JSON.stringify(req)})`);
        if ("error" in r) {
          if (r.error.includes("still starting its team rooms")) return false;
          throw new Error(r.error);
        }
        started = r;
        return true;
      }, 30_000);
      const O = started!.started!;
      await settled(O, 1, "the Orchestrator's kickoff read");
      const orch = (await liveOne(app, O))!;
      expect(orch).toMatchObject({ role: "orchestrator", ticketId: TICKET, agent: "claude", taskGroup: "Parser" });
      const branch = orch.branch!;
      expect(git(orch.cwd, "rev-parse", "HEAD")).toBe(onOrigin("dev"));
      const kickoff = ofKind(fakeLog(home, O), "prompt")[0];
      expect(kickoff).toMatchObject({ how: "pasted" });
      expect(kickoff.text).toContain(`You're the Orchestrator for Azure DevOps ticket #${TICKET}`);
      const shape = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(kickoff.text!)![1]);
      expect(shape.steps.map((s: { key: string }) => s.key)).toEqual(["coder", "verifier"]);
      expect((await pipelineOf(app, TICKET)).stage).toBe("ba");

      // 2. the Orchestrator moves no stage: the Coder does
      const [stage] = await toolsAfter(O, `@call set_stage ${JSON.stringify({ stage: "coding" })}`, 1);
      expect(stage).toMatchObject({ name: "set_stage", isError: true });
      expect(stage.reply).toContain("Orchestrator");
      expect((await pipelineOf(app, TICKET)).stage).toBe("ba");

      // 3. it proposes the starting shape it was told: held for the person, nothing made
      const summary = "Coder streams the parser's input in this folder; Verifier checks the build once its pull request to dev merges.";
      const [proposed] = await toolsAfter(O, `@call propose_plan ${JSON.stringify({ summary, ...shape })}`, 1);
      expect(proposed).toMatchObject({ name: "propose_plan", isError: false });
      expect(proposed.reply).toMatch(new RegExp(`^Held for the user: 2 steps and 3 wires for #${TICKET}\\. Nothing exists until they lay it out`));
      expect((await live(app)).map((s) => s.id)).toEqual([O]);
      expect(await planned(app)).toEqual([]);
      expect(linksOf(home)).toEqual({});
      const views = await app.evaluate<PlanView[]>("window.mb.plansList()");
      expect(views).toEqual([expect.objectContaining({ held: expect.objectContaining({ ticket: TICKET }), area: "Parser", problem: null })]);
      const view = views[0];

      // 4. Needs you's Plan item opens the picker on it; the person changes the Coder's prompt and lays out what's shown
      await openNeeds(app);
      await untilTrue("the plan in Needs you", async () => (await textOf(app, ".ny-item.k-plan .ny-text")) === `Orchestrator proposes 2 workspaces · #${TICKET}`, 30_000);
      await clickEl(app, ".ny-item.k-plan [data-action=open]", "the plan's Open");
      await untilTrue("the plan's dialog", () => isThere(app, ".modal.tp-plan"), 10_000);
      expect(await textOf(app, ".tp-plan [data-provenance]")).toBe(`Proposed by Orchestrator's agent, which read #${TICKET}, written by others`);
      expect(await textOf(app, ".tp-plan [data-summary]")).toBe(summary);
      const shownPrompt = (key: string) => app.evaluate<string | null>(`document.querySelector('.tp-plan .tp-step[data-step=${JSON.stringify(key)}] textarea.tp-prompt')?.value ?? null`);
      expect(await shownPrompt("coder")).toBe(shape.steps[0].prompt);
      expect(await shownPrompt("verifier")).toBe(shape.steps[1].prompt);
      const edit = " Keep the parser's public API as it is.";
      await clickEl(app, '.tp-plan .tp-step[data-step="coder"] textarea.tp-prompt', "the Coder's prompt");
      await app.evaluate(`(() => { const t = document.activeElement; t.setSelectionRange(t.value.length, t.value.length); })()`);
      await app.send("Input.insertText", { text: edit });
      expect(await shownPrompt("coder")).toBe(shape.steps[0].prompt + edit);
      await clickEl(app, ".tp-plan button[data-act=layout]", "Lay out");
      await untilTrue("the plan laid out and its dialog closed", async () => {
        const err = await textOf(app, ".tp-plan [role=alert], .tp-plan [data-flag=blocked]");
        if (err) throw new Error(`Lay out was refused: ${err}`);
        return !(await isThere(app, ".modal.tp-plan"));
      }, 60_000);

      // what was laid out: the Coder started in the Orchestrator's folder with the prompt as shown, the Verifier waits,
      // and the three wires, the Orchestrator's handoff counted sent
      const coder = (await live(app)).find((s) => s.title === "Coder")!;
      expect(coder).toMatchObject({ agent: "codex", cwd: orch.cwd, ticketId: TICKET, taskGroup: "Parser" });
      const verifier = (await planned(app)).find((s) => s.title === "Verifier")!;
      expect(verifier).toMatchObject({ agent: "claude", ticketId: TICKET });
      const links = Object.entries(linksOf(home));
      expect(links.length).toBe(3);
      const wireOf = (from: string, to: string, type: Wire["type"]) => links.find(([, w]) => w.from === from && w.to === to && w.type === type)!;
      expect(wireOf(O, coder.id, "handoff")[1]).toMatchObject({ delivery: { state: "sent" } });
      expect(wireOf(O, coder.id, "handoff")[1].pending).toBeUndefined();
      const [toVerifierId, toVerifier] = wireOf(coder.id, verifier.id, "handoff");
      expect(toVerifier).toMatchObject({ when: "pr-merged", gate: "ask" });
      expect(toVerifier.pending).toBeUndefined();
      expect(wireOf(verifier.id, coder.id, "feedback")[1]).toMatchObject({ gate: "ask", rounds: { limit: 3, used: 0 } });
      await settled(coder.id, 1, "the Coder's first turn over");
      // its prompt, then any word of the pr-merged wire made once it had started (it launched before that wire was made)
      const [first, ...told] = ofKind(fakeLog(home, coder.id), "prompt");
      expect(first).toMatchObject({ how: "argv", text: withTicket(shape.steps[0].prompt + edit, ticketLine(TICKET, TITLE)) });
      for (const t of told) expect(t.text).toMatch(/^\[Mockingbird: the user wired this workspace to "Verifier"/);
      expect((await pipelineOf(app, TICKET)).stage).toBe("coding");

      // a second Lay out of the plan is refused, and makes nothing
      const again = await app.evaluate<{ error?: string }>(`window.mb.plansLayOut(${JSON.stringify(view.id)}, ${JSON.stringify(view.held.plan)}, ${JSON.stringify({ area: view.area, room: view.room })})`);
      expect(again).toEqual({ error: "That plan was laid out already." });
      expect((await live(app)).length).toBe(2);
      expect((await planned(app)).length).toBe(1);
      expect(Object.keys(linksOf(home)).length).toBe(3);

      // 5. the Coder commits, moves the ticket to local testing and asks for the pull request: held, nothing pushed
      const pr = { target: "dev", title: `#${TICKET} ${TITLE}`, description: "## Summary\nThe parser reads its input as a stream.\n\n## Testing\nRan the parser's tests." };
      const [local, asked] = await toolsAfter(coder.id, `@commit stream.txt; @call set_stage ${JSON.stringify({ stage: "local-test" })}; @call request_pr ${JSON.stringify(pr)}`, 2);
      expect(local).toMatchObject({ name: "set_stage", isError: false });
      expect(asked).toMatchObject({ name: "request_pr", isError: false });
      const coderSha = ofKind(fakeLog(home, coder.id), "commit")[0].sha!;
      const held = await pipelineOf(app, TICKET);
      expect(held.stage).toBe("local-test");
      expect(held.requests).toEqual([expect.objectContaining({ target: "dev", from: coder.id, fromTitle: "Coder", title: pr.title, description: pr.description })]);
      expect(onOrigin(branch)).toBeNull();
      expect(created()).toEqual([]);

      // 6. Needs you's request opens the PR form, filled from it; nothing is pushed or opened until its button
      await openNeeds(app);
      await untilTrue("the request in Needs you", async () => (await textOf(app, ".ny-item.k-pr .ny-text")) === `Coder asks to open the PR to dev · #${TICKET}`, 30_000);
      await clickEl(app, ".ny-item.k-pr [data-action=open]", "the request's Open");
      await untilTrue("the PR form, its branch checked", () => isThere(app, ".modal.pl-modal .pl-prform .row button.primary"), 30_000);
      const form = await app.evaluate<{ title: string; description: string; marks: string[]; asked: string }>(
        `(() => { const f = document.querySelector(".pl-prform"); return { title: f.querySelector("input[type=text]").value, description: f.querySelector("textarea").value, marks: [...f.querySelectorAll(".pl-by")].map((e) => e.textContent), asked: f.querySelector(".pl-asked")?.textContent ?? "" }; })()`
      );
      expect(form).toMatchObject({ title: pr.title, description: pr.description, marks: ["written by Coder's agent", "written by Coder's agent"] });
      expect(form.asked).toContain("Nothing is pushed or opened until you press Push and open PR.");
      expect(onOrigin(branch)).toBeNull();
      expect(created()).toEqual([]);
      await clickEl(app, ".pl-prform .row button.primary", "Push and open PR");
      await untilTrue("the pull request opened", async () => {
        const err = await textOf(app, ".pl-prform .fp-note.err");
        if (err) throw new Error(`Push and open PR failed: ${err}`);
        return ghPrs(home).length === 1 && !(await isThere(app, ".pl-prform"));
      }, 60_000);
      const opened = ghPrs(home)[0];
      expect(opened).toMatchObject({ number: 1, head: branch, base: "dev", title: pr.title, body: pr.description, state: "OPEN", headSha: coderSha });
      expect(created().length).toBe(1);
      expect(onOrigin(branch)).toBe(coderSha);
      expect(sshCalls(home).some((l) => l.endsWith("git-receive-pack 'acme/parser.git'"))).toBe(true);
      const tracked = await pipelineOf(app, TICKET);
      expect(tracked.stage).toBe("pr-dev");
      expect(tracked.prs).toEqual([expect.objectContaining({ target: "dev", provider: "github", id: 1, url: opened.url, repo: "acme/parser", branch, base: "dev", by: coder.id })]);
      expect(tracked.requests ?? []).toEqual([]);
      // the pipeline dialog put away, as Escape does
      await app.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await app.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await untilTrue("the pipeline dialog closed", async () => !(await isThere(app, ".modal.pl-modal")), 10_000);

      // 7. the merge watch reads it: open, so nothing's readied; merged on "GitHub", the watch's next read moves the
      // ticket on and readies the Verifier's wire, which asks
      expect(await app.evaluate(`window.mb.pipelinePrCheck(${JSON.stringify(TICKET)}, ${JSON.stringify(opened.url)})`)).toMatchObject({ stage: "pr-dev" });
      expect(linksOf(home)[toVerifierId].pending).toBeUndefined();
      const mergeSha = mergePr(home, opened.number);
      await untilTrue("the watch's read of the merge", async () => {
        const r = await app.evaluate<TicketPipeline | { error: string }>(`window.mb.pipelinePrCheck(${JSON.stringify(TICKET)}, ${JSON.stringify(opened.url)})`);
        // the watch's own check, every 2 minutes, may have read it first
        if ("error" in r && !r.error.includes("merged already")) throw new Error(r.error);
        return !!linksOf(home)[toVerifierId].pending;
      }, 30_000);
      const moved = await pipelineOf(app, TICKET);
      expect(moved.stage).toBe("dev-test");
      expect(moved.prs[0]).toMatchObject({ mergeCommit: mergeSha });
      const waits = linksOf(home)[toVerifierId];
      expect(waits.delivery).toBeUndefined();
      expect(waits.pending!.body).toContain(opened.url);
      expect(waits.pending!.body).toContain(mergeSha);
      await openNeeds(app);
      await untilTrue("the Verifier's gate in Needs you", async () => (await textOf(app, `.ny-item.k-wire[data-item="wire:${toVerifierId}"] .ny-text`)) !== null, 30_000);
      expect(await isThere(app, `.ny-item.k-wire[data-item="wire:${toVerifierId}"] [data-action=send]`)).toBe(true);
      await clickEl(app, ".ny-btn", "the Needs you button");
      await untilTrue("the tray put away", async () => !(await isThere(app, ".ny-tray")), 10_000);
      expect(await openGate(app, toVerifierId)).toBe("f-ready");
      const shown = await popover(app);
      expect(shown).toMatchObject({ ends: "Coder → Verifier", body: waits.pending!.body });
      expect(shown.why).toContain("“Verifier” hasn't started: sending starts it.");

      // the person's Send starts the Verifier in the Coder's folder, and it's handed the merge once
      await press(app, "send");
      await untilTrue("the Verifier's handoff sent", async () => linksOf(home)[toVerifierId].delivery?.state === "sent", 90_000);
      const v = (await liveOne(app, verifier.id))!;
      expect(v).toMatchObject({ agent: "claude", cwd: orch.cwd });
      await untilTrue("the Verifier handed the merge", async () => promptsWith(fakeLog(home, verifier.id), mergeSha).length === 1 && (await liveOne(app, verifier.id))?.status === "idle", 60_000);
      expect(promptsWith(fakeLog(home, verifier.id), opened.url).length).toBe(1);
      // every gh call was one the stand-in answers: the form's lookup, its create and the watch's reads
      expect(ghCalls(home).map((c) => `${c.args[0]} ${c.args[1]}`).filter((c) => !["pr list", "pr create", "pr view"].includes(c))).toEqual([]);

      app.close();
      expect(await quitApp(app.child)).toEqual({ killed: false, leftovers: [] });
    } finally {
      app.close();
      await quitApp(app.child);
    }
  }, 300_000);
});
