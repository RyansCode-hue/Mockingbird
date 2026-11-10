/**
 * Whether a Claude room launch's sandbox settings were taken. Claude Code drops a settings file it rejects whole — the
 * sandbox with it — says so only on its own screen, and runs none of that file's hooks. So the launch's settings carry
 * a SessionStart hook of their own (sandboxMarkerCommand) that reports a marker only this launch was given, and the
 * launch counts as in the room's sandbox once that marker and Mockingbird's own SessionStart event for its pane have
 * both come, before anything a turn leaves.
 *
 * An agent outside the sandbox could write the marker itself (its command line holds it), but only in a turn, and a
 * prompt reaches Mockingbird's UserPromptSubmit hook before the model sees it. Mockingbird's own SessionStart is what
 * shows those hooks run for this launch, so its prompts would be seen. Until both have come the launch is starting,
 * and nothing crosses the room's line for it; once a turn's event comes first, or they haven't come in time, it's
 * outside the sandbox for the rest of its life.
 *
 * That shows the file loaded, not that Claude Code read its sandbox from it: a key it doesn't know is ignored. So the
 * launch also waits for Claude Code's own account of its sandbox (claudeSandboxProbe.ts), asked out of band, which no
 * turn can forge: once the marker and the start have come in order, a turn no longer matters, only that answer.
 */

export type RoomSandboxState = "starting" | "confirmed" | "failed";

/** How long a launch has for both reports. Claude Code runs SessionStart hooks as it starts, before its first prompt. */
export const SANDBOX_REPORT_MS = 60_000;

export interface RoomSandboxTell {
  confirmed(): void;
  /** `why` finishes "it isn't in the room's sandbox: …". */
  failed(why: string): void;
}

export class RoomSandboxWatch {
  state: RoomSandboxState = "starting";
  private marked = false;
  private started = false;
  /** Claude Code's own account of its sandbox showed it on, as the room wrote it (claudeSandboxProbe.ts). */
  private proven = false;
  private timer: ReturnType<typeof setTimeout> | null;
  /** The whole second it was launched in: hook events stamped before it are the pane's earlier launch's. */
  private readonly since: number;

  constructor(
    readonly marker: string,
    private readonly tell: RoomSandboxTell,
    ms = SANDBOX_REPORT_MS,
    now = Date.now()
  ) {
    this.since = Math.floor(now / 1000);
    this.timer = setTimeout(() => this.fail(this.missing(ms)), ms);
    this.timer.unref?.();
  }

  private missing(ms: number): string {
    const s = `${Math.round(ms / 1000)} seconds`;
    if (!this.marked) return `its sandbox settings didn't report in within ${s} of its start — Claude Code may have rejected them (its pane says so as it starts)`;
    if (!this.started) return `Mockingbird's hooks didn't report it starting within ${s}, so Mockingbird can't tell its sandbox started before its first turn — install its status hooks (Settings → Agents)`;
    return `Mockingbird's check of its sandbox didn't finish within ${s}`;
  }

  /** The launch's marker came; `late`: in the same read of the events as something a turn leaves (hooks.ts turnsIn). */
  reported(marker: string, late: boolean): void {
    // another launch's marker (this pane's earlier one), or a made-up one, says nothing of this launch
    if (this.state !== "starting" || marker !== this.marker) return;
    if (late) return this.fail("its sandbox settings reported in alongside its first turn, so Mockingbird can't tell which came first");
    this.marked = true;
    this.settle();
  }

  /** Mockingbird's own SessionStart hook reported the pane starting. */
  sessionStarted(): void {
    if (this.state !== "starting") return;
    this.started = true;
    this.settle();
  }

  /** Claude Code's own account of its sandbox: on, as the room wrote it. */
  proved(): void {
    if (this.state !== "starting") return;
    this.proven = true;
    this.settle();
  }

  /** Claude Code's own account of its sandbox wasn't that, or couldn't be had: `why` as for `failed`. */
  disproved(why: string): void {
    this.fail(why);
  }

  /** Something only a turn leaves came (a prompt, a tool, a stop), stamped `at` (whole seconds) when known. */
  turn(at?: number): void {
    if (this.state !== "starting" || (at !== undefined && at < this.since)) return;
    // both came first: what's still awaited is asked out of band, which a turn can't answer
    if (this.marked && this.started) return;
    this.fail(this.marked ? "its first turn began before Mockingbird's hooks reported it starting" : "its first turn began before its sandbox settings reported in");
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private settle(): void {
    if (!this.marked || !this.started || !this.proven) return;
    this.state = "confirmed";
    this.stop();
    this.tell.confirmed();
  }

  private fail(why: string): void {
    if (this.state !== "starting") return;
    this.state = "failed";
    this.stop();
    this.tell.failed(why);
  }
}
