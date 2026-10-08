import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { appE2E, launchApp, untilTrue } from "./e2e/appInstance";

/**
 * Quitting the real app (dist/, under Electron) with panes open. Their ptys
 * end before Node is torn down — one exiting during that teardown aborts the
 * app from node-pty's exit callback — and their saved state stays resumable.
 * Opt-in, like the other app tests:
 *
 *   npm run build && MB_E2E_APP=1 npx vitest run test/quitApp.e2e.test.ts
 */
describe.skipIf(!appE2E)("quitting the app with panes open", () => {
  it("exits cleanly, and the panes are still resumable, not dead", async () => {
    const app = await launchApp("Quitter", "");
    for (const title of ["one", "two", "three"]) {
      const s = await app.evaluate<{ error?: string }>(`window.mb.createSession({ repoPath: null, useWorktree: false, shell: true, title: ${JSON.stringify(title)} })`);
      expect(s.error).toBeUndefined();
    }
    await untilTrue("the terminals running", async () => (await app.evaluate<number>(`window.mb.listSessions().then((l) => l.filter((s) => s.status !== "dead").length)`)) === 3);
    app.close();
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => app.child.once("exit", (code, signal) => resolve({ code, signal })));
    app.child.kill("SIGTERM"); // Electron quits as app.quit() would
    expect(await exit).toEqual({ code: 0, signal: null });
    const saved = JSON.parse(fs.readFileSync(path.join(app.home, ".mockingbird", "state.json"), "utf8")) as { sessions: { title: string; status: string }[] };
    expect(saved.sessions.map((s) => [s.title, s.status === "dead"]).sort()).toEqual([
      ["one", false],
      ["three", false],
      ["two", false],
    ]);
  }, 60_000);
});
