import { describe, expect, it } from "vitest";
import type { SessionInfo } from "../src/shared/types";
import { resumeExited, type ResumeSteps } from "../src/renderer/resumeFlow";

const relaunched = { id: "s1", title: "Donor entities" } as SessionInfo;

/** The steps, each recording that it ran; `over` picks what each answers. */
function steps(over: Partial<{ refusal: string | null; main: string | null | { error: string }; cost: boolean; kill: unknown; relaunch: SessionInfo | null | { error: string } }> = {}) {
  const ran: string[] = [];
  const said: string[] = [];
  const d: ResumeSteps = {
    refusal: over.refusal ?? null,
    mainRefusal: async () => (ran.push("main"), over.main ?? null),
    costOk: async () => (ran.push("cost"), over.cost ?? true),
    kill: async () => (ran.push("kill"), over.kill ?? null),
    dispose: () => void ran.push("dispose"),
    relaunch: async () => (ran.push("relaunch"), over.relaunch === undefined ? relaunched : over.relaunch),
    say: (t) => void said.push(t),
  };
  return { d, ran, said };
}

describe("resuming an exited session", () => {
  it("asks main before it drops the pty or lets go of the terminal, then relaunches", async () => {
    const { d, ran, said } = steps();
    await expect(resumeExited("Donor entities", d)).resolves.toBe(relaunched);
    expect(ran).toEqual(["main", "cost", "kill", "dispose", "relaunch"]);
    expect(said).toEqual([]);
  });

  it("a copy the window knows a teammate took over, or one taken back since: said, and nothing else happens", async () => {
    for (const refusal of ["Nick continues it on their laptop: take it back rather than resuming this copy", "It was taken back into another session here, which goes on with it: this copy doesn't run again"]) {
      const { d, ran, said } = steps({ refusal });
      await expect(resumeExited("Donor entities", d)).resolves.toBeUndefined();
      expect(ran).toEqual([]);
      expect(said).toEqual([refusal]);
    }
  });

  it("one main refuses (a take-over this window hasn't heard of): said, its pty and terminal kept", async () => {
    const { d, ran, said } = steps({ main: "“Donor entities” continues on Sam's laptop — take it back rather than running this copy again" });
    await expect(resumeExited("Donor entities", d)).resolves.toBeUndefined();
    expect(ran).toEqual(["main"]);
    expect(said).toEqual(["“Donor entities” continues on Sam's laptop — take it back rather than running this copy again"]);
    // main's answer failing stops it too, said
    const failing = steps({ main: { error: "IPC timed out" } });
    await resumeExited("Donor entities", failing.d);
    expect(failing.ran).toEqual(["main"]);
    expect(failing.said).toEqual(["Couldn't resume Donor entities: IPC timed out"]);
  });

  it("stops at a declined cost, a failed kill or a failed relaunch, each said but the declined cost", async () => {
    const declined = steps({ cost: false });
    await expect(resumeExited("Donor entities", declined.d)).resolves.toBeUndefined();
    expect([declined.ran, declined.said]).toEqual([["main", "cost"], []]);
    const kill = steps({ kill: { error: "no such pty" } });
    await expect(resumeExited("Donor entities", kill.d)).resolves.toBeUndefined();
    expect([kill.ran, kill.said]).toEqual([["main", "cost", "kill"], ["Couldn't resume Donor entities: no such pty"]]);
    const relaunch = steps({ relaunch: { error: "the agent CLI is missing" } });
    await expect(resumeExited("Donor entities", relaunch.d)).resolves.toBeUndefined();
    expect(relaunch.said).toEqual(["Couldn't resume: the agent CLI is missing"]);
    // main had nothing to relaunch: null, the pane goes as before
    const none = steps({ relaunch: null });
    await expect(resumeExited("Donor entities", none.d)).resolves.toBeNull();
  });
});
