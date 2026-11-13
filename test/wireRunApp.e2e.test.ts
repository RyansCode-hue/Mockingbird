import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it, onTestFailed } from "vitest";
import { appE2E, launchApp, mainLog, quitApp, untilTrue, type AppInstance } from "./e2e/appInstance";
import { alive, descendants, killOrphans } from "./e2e/processes";
import { fakeClis, fakeLog, killOnPaste, type FakeEntry } from "./e2e/fakeCli";
import { git, makeRepo, tempDir } from "./helpers";
import type { SessionInfo } from "../src/shared/types";
import type { Wire, WireBook } from "../src/shared/wires";

/**
 * A whole wire run in the real app (dist/, under Electron), with stand-ins for Claude Code and Codex set as Settings'
 * binaries (test/e2e/fakeCli.cjs): they read their prompts raw, run the hooks Mockingbird installed, keep their
 * conversations where the CLIs do, and call finish_step through Mockingbird's MCP server started inside their panes.
 * Nothing calls a model. Builder (Claude) hands off to Reviewer (Codex), a step not started yet, through a wire that
 * asks: Builder commits and finishes; its gate holds what it said across a quit; the person's Send in the window's
 * popover starts Reviewer at Builder's commit and its queue delivers the handoff once; a run that ends while the next
 * handoff is being pasted leaves it marked as may-have-arrived, never pasted again by itself, and the person's Send
 * again delivers it once. Windows open on screen while it runs, so it's opt-in:
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
  const dot = () =>
    a.evaluate<Pt | null>(
      `(() => { const c = document.querySelector('g.ls-wire[data-wire=${JSON.stringify(wireId)}] > circle.dot'); if (!c || c.parentElement.style.display === "none") return null; const r = c.getBoundingClientRect(); return r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`
    );
  const zoom = () => a.evaluate<number>(`Number(/scale\\(([\\d.]+)\\)/.exec(document.querySelector(".ls-world")?.style.transform ?? "")?.[1] ?? 0)`);
  await untilTrue(`wire ${wireId}'s gate dot drawn`, async () => !!(await dot()), 30_000);
  const vp = await a.evaluate<{ left: number; top: number; width: number; height: number }>(
    `(() => { const r = document.querySelector(".ls-viewport").getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })()`
  );
  const mid = { x: Math.round(vp.left + vp.width / 2), y: Math.round(vp.top + vp.height / 2) };
  // workspaces take the mouse and draw their wires' dots from 75%
  for (let i = 0; i < 10 && (await zoom()) < 0.8; i++) {
    const was = await zoom();
    const at = (await dot()) ?? mid;
    await cdp(a, "Input.dispatchMouseEvent", { type: "mouseWheel", x: at.x, y: at.y, deltaX: 0, deltaY: -100, modifiers: 4 });
    await untilTrue("the landscape to zoom in", async () => (await zoom()) !== was, 5000);
  }
  await untilTrue("the dot drawn at 80% or more", async () => (await zoom()) >= 0.8 && !!(await dot()), 10_000);
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
});
