/** The parts of team rooms that stop with the app, as index.ts holds them. */
export interface TeamRoomsParts {
  livePanes: { stop(): void };
  chat: { stop(): void };
  house: { stop(): void };
  takeover: () => { close(): void } | null;
  team: { stop(): void };
}

/**
 * Stop team rooms when the window closes or the app quits: whatever speaks
 * through the team first, the transport last. The live panes send output
 * gathered for teammates; the chat posts the agent updates still gathering
 * (up to 30 s of them); then the House board, take-over and the team stop.
 * Every part is stopped even when one before it fails (that's logged).
 */
export function stopTeamRooms(p: TeamRoomsParts, log: (context: string, err: unknown) => void): void {
  const steps: [string, () => void][] = [
    ["live panes", () => p.livePanes.stop()],
    ["team chat", () => p.chat.stop()],
    ["House board", () => p.house.stop()],
    ["take-over", () => p.takeover()?.close()],
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
