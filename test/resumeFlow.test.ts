import { describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "../src/shared/types";
import { resumeExited, type ResumeSteps } from "../src/renderer/resumeFlow";

const relaunched = { id: "s1", title: "Donor entities" } as SessionInfo;

/** The steps, each recording that it ran; `over` picks what each answers (`resume` a function to throw). */
function steps(over: Partial<{ refusal: string | null; cost: boolean; resume: SessionInfo | { refused: string } | { error: string } | (() => never) }> = {}) {
  const ran: string[] = [];
  const said: string[] = [];
  const d: ResumeSteps = {
    refusal: over.refusal ?? null,
    costOk: async () => (ran.push("cost"), over.cost ?? true),
    resume: async () => {
      ran.push("resume");
      const r = over.resume ?? relaunched;
      return typeof r === "function" ? r() : r;
    },
    dispose: () => void ran.push("dispose"),
    say: (t) => void said.push(t),
  };
  return { d, ran, said };
}

describe("resuming an exited session", () => {
  it("asks main only once the cost is agreed, in one call that checks, lets the pty go and relaunches; then lets the terminal go", async () => {
    const { d, ran, said } = steps();
    await expect(resumeExited("Donor entities", d)).resolves.toBe(relaunched);
    expect(ran).toEqual(["cost", "resume", "dispose"]);
    expect(said).toEqual([]);
  });

  it("a copy the window knows a teammate took over, or one taken back since: said with its title, and nothing else happens", async () => {
    for (const refusal of ["Nick continues it on their laptop: take it back rather than resuming this copy", "It was taken back into another session here, which goes on with it: this copy doesn't run again"]) {
      const { d, ran, said } = steps({ refusal });
      await expect(resumeExited("Donor entities", d)).resolves.toBeUndefined();
      expect(ran).toEqual([]);
      expect(said).toEqual([`Couldn't resume Donor entities: ${refusal}`]);
    }
  });

  it("one main refuses (running already, a take-over this window hasn't heard of, its conversation busy elsewhere): said with its title, its terminal kept", async () => {
    const { d, ran, said } = steps({ resume: { refused: "It's running already" } });
    await expect(resumeExited("Donor entities", d)).resolves.toBeUndefined();
    expect(ran).toEqual(["cost", "resume"]);
    expect(said).toEqual(["Couldn't resume Donor entities: It's running already"]);
  });

  it("stops at a declined cost, unsaid; a relaunch that failed after the pty went is said, its terminal let go", async () => {
    const declined = steps({ cost: false });
    await expect(resumeExited("Donor entities", declined.d)).resolves.toBeUndefined();
    expect([declined.ran, declined.said]).toEqual([["cost"], []]);
    const failed = steps({ resume: { error: "the agent CLI is missing" } });
    await expect(resumeExited("Donor entities", failed.d)).resolves.toBeUndefined();
    expect([failed.ran, failed.said]).toEqual([["cost", "resume", "dispose"], ["Couldn't resume Donor entities: the agent CLI is missing"]]);
  });

  it("says a call that never got an answer (no handler in main) rather than leaving it unhandled, its terminal kept", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const { d, ran, said } = steps({
      resume: () => {
        throw new Error("No handler registered for 'sessions:resume'");
      },
    });
    await expect(resumeExited("Donor entities", d)).resolves.toBeUndefined();
    expect(ran).toEqual(["cost", "resume"]);
    expect(said).toEqual(["Couldn't resume Donor entities: No handler registered for 'sessions:resume'"]);
    expect(quiet).toHaveBeenCalled();
    quiet.mockRestore();
  });
});
