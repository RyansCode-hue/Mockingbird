import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";

// Start session on a House card, in the UI preview in real headless Chrome: local only (CI runners have no desktop);
// the script passes a mock keychain. ?houseStartAudit (src/preview/stub.ts) starts one from a card's right-click menu
// or the ticket's own button, against the preview's fixture House (nothing reaches the real one), and reports what
// was on screen and what Start asked of the main process.
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const local = !process.env.CI && fs.existsSync(chrome);

async function audit(query: string): Promise<any> {
  // @ts-expect-error — a plain .mjs build script, no type declarations
  const { pageResult } = await import("../scripts/ui-preview.mjs");
  const json: string | null = await pageResult({ size: "1400x900", query, outDir: path.join(tempDir("start"), "out"), read: `document.getElementById("mb-house-start-audit")?.textContent ?? null` });
  if (!json) throw new Error("the preview didn't finish its Start session audit");
  return JSON.parse(json);
}

const BRANCH = "feature/146-donor-export-skips-archived-donors";

describe.skipIf(!local)("Start session on a House card", () => {
  it("offers Start on tickets that are free or yours, confirms the repo, branch and agent, then starts it in the room's group", async () => {
    const a = await audit("motion=off&houseStartAudit");
    // #146 unclaimed, #151 and #143 yours: Start; #141 is Nick's: none, and its menu says why
    expect(a.buttons).toEqual([true, false, true, true]);
    expect(a.takenMenu[0]).toEqual({ text: "Start session…", disabled: true, title: "Nick Smith has #141" });
    expect(a.menu.map((r: { text: string }) => r.text)).toEqual(["Start session…", "Open the ticket", "Open in the House ↗"]);
    expect(a.menu[0].disabled).toBe(false);
    // the confirmation, from the menu: what happens to the claim, where, and which agent
    expect(a.pop).toMatchObject({ head: "Start a session on #146", agent: "Claude", start: "Start Claude", startDisabled: false, error: null, inWindow: true });
    expect(a.pop.grid).toEqual(["Claim", "Claims #146 as you in the House", "Repo", "backoffice", "Branch", BRANCH, "Agent", "ClaudeCodex"]);
    expect(a.agentPicked).toBe("Codex");
    // Start: one call, the board closes, the session is in the room's group and on screen; the House has the claim
    expect(a.after.starts).toEqual([{ n: 146, agent: "codex", repoPath: "/Users/you/Code/backoffice", branch: BRANCH }]);
    expect(a.after).toMatchObject({ pop: null, board: false, shown: true });
    expect(a.after.session).toEqual([{ title: "#146 — Donor export skips archived donors", group: "5101", agent: "codex" }]);
    expect(a.after.house.claim).toEqual({ by: "You", branch: BRANCH });
  }, 120_000);

  it("starts it on screen on the grid too", async () => {
    const a = await audit("labs=off&motion=off&houseStartAudit");
    expect(a.after).toMatchObject({ pop: null, board: false, shown: true });
  }, 120_000);

  it("starts from the ticket's own Start session button", async () => {
    const a = await audit("motion=off&houseStartAudit=detail");
    expect(a.detailButton).toBe("Start session");
    expect(a.pop.head).toBe("Start a session on #146");
    expect(a.after.starts).toHaveLength(1);
    expect(a.after.board).toBe(false);
  }, 120_000);

  it("keeps the board and says why when the worktree fails, the claim released again", async () => {
    const a = await audit("motion=off&houseStartAudit&houseStartFail=session");
    expect(a.after.board).toBe(true);
    expect(a.after.session).toEqual([]);
    expect(a.after.pop.error).toMatch(/^Couldn't make #146's worktree or start its session: fatal: .* is already checked out .*\. Released #146 again, so it's unclaimed as before\.$/);
    expect(a.after.pop.release).toBe(false);
    expect(a.after.house).toEqual({ claim: null, history: ["created", "question", "answered", "status_changed", "claimed", "released"] });
  }, 120_000);

  it("offers Release when the claim it made couldn't be given back", async () => {
    const a = await audit("motion=off&houseStartAudit&houseStartFail=stuck");
    expect(a.after.pop.error).toMatch(/#146 is still claimed by you on feature\/146-donor-export-skips-archived-donors: releasing it failed/);
    expect(a.after.pop.release).toBe(true);
  }, 120_000);
});
