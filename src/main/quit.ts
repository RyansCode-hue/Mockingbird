/**
 * How the app quits, whatever starts it (⌘Q, Update's restart, the last
 * window closing, a signal), in the order nothing outlives it:
 *
 * 1. before-quit: services and debug sessions Mockingbird started stop
 *    first (bounded), so nothing keeps holding ports or containers.
 * 2. The windows close. The editor's unsaved changes ask first and can keep
 *    the app open (`cancelled`), except on a signal, which quits regardless.
 * 3. will-quit, when nothing can cancel the quit anymore: the quit steps run
 *    (scrollback, team rooms, debug sessions still left, language servers,
 *    the update's installer), each
 *    on its own so one failing never skips the rest, and their times are
 *    logged; then every pty ends (bounded) before Node is torn down.
 *
 * A quit held up in 1 or 3 goes on with a new app.quit() on the next turn of
 * the event loop. Electron doesn't take one sooner: while it is still sending
 * before-quit or will-quit (the microtasks its listeners start included, as
 * Electron runs those before it goes on), app.quit() is ignored or re-entered,
 * and the preventDefault() then calls that quit off, so it would never come.
 *
 * A quit always finishes: one still running `deadlineMs` after it began is
 * forced (the steps not yet run, every pty killed, exit), so is one Electron
 * hasn't finished `exitMs` after the ptys ended, and so is one that gets a
 * second signal. Each problem is logged.
 */

export interface QuitEvent {
  preventDefault(): void;
}

export interface QuitApp {
  on(event: "before-quit" | "will-quit", listener: (e: QuitEvent) => void): unknown;
  quit(): void;
  exit(code: number): void;
}

export interface QuitStep {
  name: string;
  run: () => void;
}

export const QUIT_TIMING = {
  /** How long services get to stop before the quit goes on without them. */
  servicesMs: 15_000,
  /** How long the ptys get to exit (SessionManager.shutdown bounds itself at 4 s). */
  ptysMs: 6_000,
  /** How long a quit may take in all before it's forced. */
  deadlineMs: 30_000,
  /** Once the ptys have ended (the windows closed and the steps run): how long Electron gets to finish the quit before it's forced. */
  exitMs: 2_000,
  /** After a forced quit kills the ptys: time for their exits to be reaped before Node goes. */
  reapMs: 500,
};

/** The signals that quit the app. */
export const QUIT_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;

export interface QuitOptions {
  app: QuitApp;
  /** A line in main.log. */
  log: (line: string) => void;
  logError: (context: string, err: unknown) => void;
  /** Stops the services and debug sessions still running; null when there are none. */
  stopServices: () => Promise<unknown> | null;
  /** Run once, in order, when the quit can no longer be cancelled. */
  steps: QuitStep[];
  /** Ends every pty and waits for the exits. */
  endPtys: () => Promise<void>;
  /** Kills every pty at once (a forced quit). */
  killPtys: () => void;
  timing?: Partial<typeof QUIT_TIMING>;
}

export class QuitSequence {
  private readonly t: typeof QUIT_TIMING;
  private servicesStopped = false;
  private stepsRun = false;
  private ptysEnded = false;
  private forced = false;
  private deadline: ReturnType<typeof setTimeout> | null = null;
  private signalled: string | null = null;

  constructor(private readonly o: QuitOptions) {
    this.t = { ...QUIT_TIMING, ...o.timing };
    o.app.on("before-quit", (e) => this.beforeQuit(e));
    o.app.on("will-quit", (e) => this.willQuit(e));
  }

  /**
   * Quit on every SIGTERM, SIGINT and SIGHUP. Electron's own handling takes
   * only the first of them, whichever it is: a later one is dropped and the
   * app keeps running. Electron installs that handling before the app is
   * ready, so this is called once it is; listening replaces it.
   */
  listenForSignals(proc: { on(signal: NodeJS.Signals, listener: () => void): unknown }): void {
    for (const sig of QUIT_SIGNALS) proc.on(sig, () => this.signal(sig));
  }

  /** The signal this quit is for, if a signal started it. */
  get bySignal(): string | null {
    return this.signalled;
  }

  signal(sig: string): void {
    if (this.signalled) return this.force(`${sig} while already quitting on ${this.signalled}`);
    this.signalled = sig;
    this.o.log(`quit: ${sig}`);
    this.arm();
    this.o.app.quit();
  }

  /** The user kept the app open when asked (unsaved changes): this quit, if one was under way, is off. */
  cancelled(): void {
    if (!this.deadline) return; // asked on a reload or the window closing, not a quit
    this.disarm();
    this.servicesStopped = false;
    this.o.log("quit: cancelled, the app stays open");
  }

  /** The user said to quit when asked: the deadline starts over, as the question took its own time. */
  resumed(): void {
    if (!this.deadline) return;
    this.disarm();
    this.arm();
  }

  private beforeQuit(e: QuitEvent): void {
    if (!this.deadline && !this.signalled) this.o.log("quit: started");
    this.arm();
    if (this.servicesStopped) return;
    let stopping: Promise<unknown> | null = null;
    try {
      stopping = this.o.stopServices();
    } catch (err) {
      this.o.logError("quit: stopping services", err);
    }
    if (!stopping) return;
    e.preventDefault();
    void this.within(stopping, this.t.servicesMs, "services").then(() => {
      this.servicesStopped = true;
      this.quitAgain();
    });
  }

  private willQuit(e: QuitEvent): void {
    if (this.forced) return;
    this.runSteps();
    if (this.ptysEnded) {
      this.disarm(); // Electron exits from here
      this.o.log("quit: exiting");
      return;
    }
    e.preventDefault();
    void this.within(this.o.endPtys(), this.t.ptysMs, "the ptys").then(() => {
      if (this.forced) return;
      this.ptysEnded = true;
      // nothing is left to wait for: the rest is Electron's, and short
      this.disarm();
      this.deadline = setTimeout(() => this.force(`Electron didn't finish the quit within ${this.t.exitMs / 1000} s of the ptys ending`), this.t.exitMs);
      this.quitAgain();
    });
  }

  /** Go on with a quit held up for the services or the ptys: on the next turn, as Electron ignores a quit while it sends the event that held it. */
  private quitAgain(): void {
    setTimeout(() => {
      if (!this.forced) this.o.app.quit();
    }, 0);
  }

  private runSteps(): void {
    if (this.stepsRun) return;
    this.stepsRun = true;
    const took: string[] = [];
    for (const step of this.o.steps) {
      const started = Date.now();
      try {
        step.run();
      } catch (err) {
        this.o.logError(`quit: ${step.name}`, err);
      }
      took.push(`${step.name} ${Date.now() - started} ms`);
    }
    this.o.log(`quit: steps run (${took.join(", ")})`);
  }

  /** Settles once `p` does or `ms` pass, whichever is first; a failure or the time running out is logged. */
  private within(p: Promise<unknown>, ms: number, what: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        this.o.log(`quit: ${what} didn't stop within ${ms / 1000} s; going on without them`);
        resolve();
      }, ms);
    });
    const done = Promise.resolve(p).then(
      () => undefined,
      (err) => void this.o.logError(`quit: stopping ${what}`, err)
    );
    return Promise.race([done, late]).finally(() => clearTimeout(timer));
  }

  private arm(): void {
    if (this.deadline || this.forced) return;
    this.deadline = setTimeout(() => this.force(`the quit didn't finish within ${this.t.deadlineMs / 1000} s`), this.t.deadlineMs);
  }

  private disarm(): void {
    if (this.deadline) clearTimeout(this.deadline);
    this.deadline = null;
  }

  private force(why: string): void {
    if (this.forced) return;
    this.forced = true;
    this.disarm();
    this.o.log(`quit: ${why}; exiting now`);
    this.runSteps();
    try {
      this.o.killPtys();
    } catch (err) {
      this.o.logError("quit: killing the ptys", err);
    }
    setTimeout(() => this.o.app.exit(1), this.t.reapMs);
  }
}
