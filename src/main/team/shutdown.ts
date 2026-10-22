/** The parts of team rooms that stop with the app, as index.ts holds them. */
export interface TeamRoomsParts {
  livePanes: { stop(): void };
  chat: { stop(): void };
  house: { stop(): void };
  /** Teammates' changes and migration numbers (teamChanges.ts). */
  changes?: { stop(): void };
  artifacts: { stop(): void };
  takeover: () => { close(): void } | null;
  /** The audit log of remote actions: what it gathered is written. */
  audit?: { stop(): void };
  team: { stop(): void };
}

/**
 * Stop team rooms when the window closes or the app quits: whatever speaks
 * through the team first, the transport last. The live panes send output
 * gathered for teammates; the chat posts the agent updates still gathering
 * (up to 30 s of them); then the House board, room artifacts (downloads stop
 * where they are, resumed on the next start), take-over, the audit log
 * (writing what it gathered) and the team stop.
 * Every part is stopped even when one before it fails (that's logged).
 */
export function stopTeamRooms(p: TeamRoomsParts, log: (context: string, err: unknown) => void): void {
  const steps: [string, () => void][] = [
    ["live panes", () => p.livePanes.stop()],
    ["team chat", () => p.chat.stop()],
    ["House board", () => p.house.stop()],
    ["teammates' changes", () => p.changes?.stop()],
    ["room artifacts", () => p.artifacts.stop()],
    ["take-over", () => p.takeover()?.close()],
    ["audit log", () => p.audit?.stop()],
    ["team transport", () => p.team.stop()],
  ];
  for (const [what, stop] of steps) {
    try {
      stop();
    } catch (err) {
      log(`team: stopping the ${what}`, err);
    }
  }
}
