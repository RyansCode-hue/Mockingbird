import { EventEmitter } from "events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuitSequence, QUIT_TIMING, type QuitEvent, type QuitOptions } from "../src/main/quit";

/**
 * Electron's quit, as far as the sequence sees it: app.quit() does nothing
 * while a quit is under way; before-quit, then the windows close, then
 * will-quit; a listener's preventDefault() ends that quit, and the app exits
 * once will-quit goes by unprevented. A prevented quit is called off only
 * after the microtasks its listeners started have run (Electron runs them
 * before it returns), so a quit() from those is ignored. `windowsHang` keeps
 * the windows from ever closing (a quit stuck under way).
 */
class FakeApp extends EventEmitter {
  quitting = false;
  exited: number | null = null;
  windowsHang = false;
  quits = 0;
  quit(): void {
    this.quits++;
    if (this.quitting || this.exited !== null) return;
    this.quitting = true;
    if (this.fire("before-quit")) return this.callOff();
    if (this.windowsHang) return;
    if (this.fire("will-quit")) return this.callOff();
    this.exited = 0;
  }
  private callOff(): void {
    setTimeout(() => (this.quitting = false), 0);
  }
  exit(code: number): void {
    this.exited = code;
  }
  private fire(event: string): boolean {
    let prevented = false;
    const e: QuitEvent = { preventDefault: () => (prevented = true) };
    try {
      this.emit(event, e);
    } catch {
      // Electron reports a listener's throw as an uncaught exception, and the quit goes on
    }
    return prevented;
  }
}

function setup(o: Partial<QuitOptions> = {}) {
  const app = new FakeApp();
  const order: string[] = [];
  const lines: string[] = [];
  const errors: string[] = [];
  const signals = new EventEmitter();
  const quit = new QuitSequence({
    app,
    log: (line) => lines.push(line),
    logError: (context, err) => errors.push(`${context}: ${err instanceof Error ? err.message : err}`),
    stopServices: () => null,
    steps: [
      { name: "saving scrollback", run: () => order.push("scrollback") },
      {
        name: "stopping team rooms",
        run: () => {
          throw new Error("the team wouldn't stop");
        },
      },
      { name: "starting the update's installer", run: () => order.push("installer") },
    ],
    endPtys: async () => void order.push("ptys"),
    killPtys: () => order.push("killed ptys"),
    ...o,
  });
  quit.listenForSignals(signals as any);
  return { app, quit, order, lines, errors, signals };
}

/** Time for the quit's own next-turn calls (a 0 ms timer set while timers run is due 1 ms later). */
const TURNS = 10;
const STEPS_RUN = expect.stringMatching(/^quit: steps run \(saving scrollback \d+ ms, stopping team rooms \d+ ms, starting the update's installer \d+ ms\)$/);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("quitting", () => {
  it("runs every step even when one fails, then ends the ptys before the app exits", async () => {
    const { app, order, errors } = setup();
    app.quit();
    expect(app.exited).toBeNull(); // the ptys are ending
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["scrollback", "installer", "ptys"]);
    expect(errors).toEqual(["quit: stopping team rooms: the team wouldn't stop"]);
    expect(app.exited).toBe(0);
  });

  it("goes on when what held the quit up is done at once: no services or ptys to wait for", async () => {
    const { app, order, lines } = setup({ stopServices: () => Promise.resolve(), endPtys: () => Promise.resolve() });
    app.quit();
    await vi.advanceTimersByTimeAsync(TURNS);
    expect(order).toEqual(["scrollback", "installer"]);
    expect(app.exited).toBe(0);
    expect(lines).toEqual(["quit: started", STEPS_RUN, "quit: exiting"]);
  });

  it("forces the exit when Electron doesn't finish the quit once the ptys have ended", async () => {
    const { app, order, lines } = setup();
    const quit = app.quit.bind(app);
    app.quit = () => void (app.quits === 0 ? quit() : app.quits++); // the quit after the ptys goes nowhere
    app.quit();
    await vi.advanceTimersByTimeAsync(QUIT_TIMING.exitMs - TURNS);
    expect(app.exited).toBeNull();
    await vi.advanceTimersByTimeAsync(2 * TURNS + QUIT_TIMING.reapMs);
    expect(app.exited).toBe(1);
    expect(order).toEqual(["scrollback", "installer", "ptys", "killed ptys"]);
    expect(lines.slice(-2)).toEqual([STEPS_RUN, `quit: Electron didn't finish the quit within ${QUIT_TIMING.exitMs / 1000} s of the ptys ending; exiting now`]);
  });

  it("goes on when the ptys never say they've ended", async () => {
    const { app, lines } = setup({ endPtys: () => new Promise(() => {}) });
    app.quit();
    await vi.advanceTimersByTimeAsync(QUIT_TIMING.ptysMs + TURNS);
    expect(app.exited).toBe(0);
    expect(lines).toContain(`quit: the ptys didn't stop within ${QUIT_TIMING.ptysMs / 1000} s; going on without them`);
  });

  it("stops services first, and goes on when they never stop", async () => {
    let asked = 0;
    const { app, order } = setup({ stopServices: () => (asked++, new Promise(() => {})) });
    app.quit();
    await vi.advanceTimersByTimeAsync(0);
    expect(app.quitting).toBe(false); // held for the services
    expect(app.exited).toBeNull();
    await vi.advanceTimersByTimeAsync(QUIT_TIMING.servicesMs + TURNS);
    expect(asked).toBe(1);
    expect(order).toEqual(["scrollback", "installer", "ptys"]);
    expect(app.exited).toBe(0);
  });

  it("forces a quit that never finishes: the steps not yet run, every pty killed, and out", async () => {
    const { app, order, lines } = setup();
    app.windowsHang = true;
    app.quit();
    await vi.advanceTimersByTimeAsync(QUIT_TIMING.deadlineMs - 1);
    expect(app.exited).toBeNull();
    await vi.advanceTimersByTimeAsync(1 + QUIT_TIMING.reapMs);
    expect(order).toEqual(["scrollback", "installer", "killed ptys"]);
    expect(app.exited).toBe(1);
    expect(lines.slice(-2)).toEqual([`quit: the quit didn't finish within ${QUIT_TIMING.deadlineMs / 1000} s; exiting now`, STEPS_RUN]);
  });

  it("quits on every signal: a second one while quitting forces it at once", async () => {
    const { app, signals, order, lines } = setup();
    app.windowsHang = true;
    signals.emit("SIGINT");
    expect(app.quits).toBe(1);
    expect(app.exited).toBeNull();
    signals.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(QUIT_TIMING.reapMs);
    expect(order).toEqual(["scrollback", "installer", "killed ptys"]);
    expect(app.exited).toBe(1);
    expect(lines).toEqual(["quit: SIGINT", "quit: SIGTERM while already quitting on SIGINT; exiting now", STEPS_RUN]);
  });

  it("a signal quits normally when nothing holds the quit up", async () => {
    const { app, signals, quit } = setup();
    signals.emit("SIGHUP");
    expect(quit.bySignal).toBe("SIGHUP");
    await vi.advanceTimersByTimeAsync(0);
    expect(app.exited).toBe(0);
    await vi.advanceTimersByTimeAsync(QUIT_TIMING.deadlineMs);
    expect(app.exited).toBe(0); // no forcing afterwards
  });

  it("isn't forced while the user keeps the app open, and starts its time over when they say quit", async () => {
    const { app, quit } = setup();
    app.windowsHang = true;
    app.quit();
    await vi.advanceTimersByTimeAsync(QUIT_TIMING.deadlineMs / 2);
    quit.cancelled(); // unsaved changes: Cancel
    app.quitting = false;
    await vi.advanceTimersByTimeAsync(QUIT_TIMING.deadlineMs * 2);
    expect(app.exited).toBeNull();

    app.quit();
    await vi.advanceTimersByTimeAsync(QUIT_TIMING.deadlineMs - 1000);
    quit.resumed(); // asked again, and this time: quit without saving
    await vi.advanceTimersByTimeAsync(QUIT_TIMING.deadlineMs - 1);
    expect(app.exited).toBeNull();
    await vi.advanceTimersByTimeAsync(1 + QUIT_TIMING.reapMs);
    expect(app.exited).toBe(1);
  });

  it("asking outside a quit (a reload, the window closing) changes nothing", async () => {
    const { app, quit, lines } = setup();
    quit.cancelled();
    quit.resumed();
    await vi.advanceTimersByTimeAsync(QUIT_TIMING.deadlineMs * 2);
    expect(app.exited).toBeNull();
    expect(lines).toEqual([]);
  });
});
