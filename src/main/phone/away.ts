import type { PhoneStatus } from "../../shared/phoneAlerts";

/** What Electron's powerMonitor offers that away detection needs (a fake in tests). */
export interface IdleMonitor {
  /** Seconds since the last keyboard or mouse input. */
  getSystemIdleTime(): number;
  /** "locked" while the screen is locked, whatever the threshold. */
  getSystemIdleState(idleThresholdSeconds: number): "active" | "idle" | "locked" | "unknown";
  on(event: "lock-screen" | "unlock-screen" | "suspend" | "resume", cb: () => void): unknown;
}

export type Away = PhoneStatus["away"];

/**
 * Whether the user is away from the Mac: its screen is locked, it has had no
 * input for `idleMinutes`, or they said so themselves (`manual`, an "I'm
 * away" switch elsewhere, when there is one). Lock and unlock come as events;
 * the idle state is asked each time too, so a lock whose event was missed
 * (it came while Mockingbird started) still counts.
 */
export class AwayDetector {
  private locked = false;
  private listeners = new Set<(away: Away) => void>();
  private was = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private d: {
      monitor: IdleMonitor;
      idleMinutes: () => number;
      manual?: () => boolean;
    }
  ) {
    d.monitor.on("lock-screen", () => {
      this.locked = true;
      this.check();
    });
    d.monitor.on("unlock-screen", () => {
      this.locked = false;
      this.check();
    });
    d.monitor.on("resume", () => this.check());
  }

  state(): Away {
    const idleSeconds = Math.max(0, Math.floor(this.d.monitor.getSystemIdleTime() || 0));
    const threshold = Math.max(1, Math.round(this.d.idleMinutes() * 60));
    const asked = this.d.monitor.getSystemIdleState(threshold);
    // input at the lock screen (a password typed) makes the Mac "active": only unlock-screen clears the lock
    if (asked === "locked" || this.locked) return { away: true, why: "locked", idleSeconds };
    if (this.d.manual?.()) return { away: true, why: "manual", idleSeconds };
    if (idleSeconds >= threshold) return { away: true, why: "idle", idleSeconds };
    return { away: false, why: null, idleSeconds };
  }

  isAway(): boolean {
    return this.state().away;
  }

  /** Hear the user become away (and come back). Checked on lock and unlock, and every `everyMs` while anyone listens. */
  onChange(cb: (away: Away) => void, everyMs = 30_000): () => void {
    this.listeners.add(cb);
    if (!this.timer) {
      this.timer = setInterval(() => this.check(), everyMs);
      this.timer.unref?.();
    }
    return () => {
      this.listeners.delete(cb);
      if (!this.listeners.size && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  }

  /** Tell listeners when away changes. */
  check(): void {
    const s = this.state();
    if (s.away === this.was) return;
    this.was = s.away;
    for (const cb of this.listeners) cb(s);
  }
}
