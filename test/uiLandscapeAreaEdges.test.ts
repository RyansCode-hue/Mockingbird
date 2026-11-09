import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";

// The landscape's areas at their edges, in the UI preview in real headless Chrome: local only (CI runners have no
// desktop); the script passes a mock keychain. ?landscapeAreaEdgesAudit (src/preview/stub.ts) opens a room's dialogs
// from Members ▾ and takes their header away under them, presses where the landscape takes the press for itself, goes
// to an area from another tab, comes back to a focused workspace, and drags a workspace whose group can't be set;
// it reports what each step left once it settled, with the main-process calls it made (window.__mbCalls).
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const local = !process.env.CI && fs.existsSync(chrome);

const NICK = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const SAM = "5a5a5a5a6b6b6b6b7c7c7c7c8d8d8d8d";
const ROOM_5101 = "R5101aaaaaaaaaaaaaaaaa";
const ROOM_5110 = "R5110bbbbbbbbbbbbbbbbb";

type Call = { fn: string; args: unknown[] } | null;
interface Dialog {
  open: boolean;
  title: string | null;
  inWorld: boolean;
  covers: boolean;
  keys: boolean;
}
interface Audit {
  heading: string | null;
  liveViewProblem: string | null;
  cardInset: { band: string | null; x: number; y: number };
  remove: { open: Dialog; drag: { moved: boolean; saved: number }; afterZoom: Dialog & { header: boolean }; call: Call };
  handOver: { open: Dialog; afterCollapse: Dialog & { collapsed: boolean }; call: Call };
  leave: { open: Dialog; afterZoom: Dialog; call: Call };
  claim: { open: Dialog; afterZoom: Dialog; call: Call };
  closing: { membersWasOpen: boolean; membersClosed: boolean; menuDrag: { moved: boolean; saved: number; stillOpen: boolean }; menuClosed: boolean };
  goToFromTab: { row: boolean; landscape: boolean; centred: boolean };
  revealOnce: { focused: boolean; refocused: boolean; collapsed: boolean };
  failedMove: { note: string | null; changes: string[]; placeBack: boolean; areasBack: boolean; group: string | null };
  error?: string;
}

async function audit(): Promise<Audit> {
  // @ts-expect-error — a plain .mjs build script, no type declarations
  const { pageResult } = await import("../scripts/ui-preview.mjs");
  const json: string | null = await pageResult({
    size: "1400x900",
    query: "motion=off&claim&liveViewFail&setGroupFail=s4&landscapeAreaEdgesAudit",
    outDir: path.join(tempDir("ls-area-edges"), "out"),
    read: `document.getElementById("mb-landscape-area-edges-audit")?.textContent ?? null`,
  });
  if (!json) throw new Error("the preview didn't finish its area edges audit");
  return JSON.parse(json);
}

/** A dialog drawn over the whole window, outside the landscape's scaled world, with the keyboard. */
const overAll = { open: true, inWorld: false, covers: true, keys: true };

describe.skipIf(!local)("the landscape's areas at their edges", () => {
  it("keeps room dialogs over everything, closes on the landscape's presses, goes to areas from other tabs once, and puts back a move that fails", async () => {
    const a = await audit();
    expect(a.error).toBeUndefined();

    // the side bar is headed Landscape while it holds the area tree
    expect(a.heading).toBe("Landscape");
    // the main process not taking what's on screen here is said where the rooms are
    expect(a.liveViewProblem).toBe("Couldn't say what's on screen here: team rooms aren't running");
    // zoomed out, cards stand inset in their places by a few px on screen
    expect(a.cardInset.band).toBe("ls-band-cards");
    expect(a.cardInset.x).toBeCloseTo(5, 0);
    expect(a.cardInset.y).toBeCloseTo(5, 0);

    // each room dialog from Members ▾ is over the whole window, outside the landscape, and outlives its header
    expect(a.remove.open).toMatchObject(overAll);
    expect(a.remove.drag).toEqual({ moved: false, saved: 0 });
    expect(a.remove.afterZoom).toMatchObject({ ...overAll, header: false });
    expect(a.remove.call).toEqual({ fn: "teamRemoveMember", args: [ROOM_5101, NICK] });
    expect(a.handOver.open).toMatchObject(overAll);
    expect(a.handOver.afterCollapse).toMatchObject({ ...overAll, collapsed: true });
    expect(a.handOver.call).toEqual({ fn: "teamHandOver", args: [ROOM_5101, SAM] });
    expect(a.leave.open).toMatchObject(overAll);
    expect(a.leave.afterZoom).toMatchObject(overAll);
    expect(a.leave.call).toEqual({ fn: "teamLeaveRoom", args: [ROOM_5101] });
    expect(a.claim.open).toMatchObject(overAll);
    expect(a.claim.afterZoom).toMatchObject(overAll);
    expect(a.claim.call).toEqual({ fn: "teamClaimOwnership", args: [ROOM_5110] });

    // Members ▾ and ⋯ close on a press the landscape takes; a drag in ⋯'s padding moves nothing and leaves it open
    expect(a.closing).toEqual({ membersWasOpen: true, membersClosed: true, menuDrag: { moved: false, saved: 0, stillOpen: true }, menuClosed: true });

    // ⌘K's Go to from another tab lands there
    expect(a.goToFromTab).toEqual({ row: true, landscape: true, centred: true });
    // a tree row's double-click focuses once: back from another tab it isn't focused again, nor its area opened
    expect(a.revealOnce).toEqual({ focused: true, refocused: false, collapsed: true });

    // a drag whose group can't be set: said, and its place and the areas put back
    expect(a.failedMove.note).toMatch(/couldn't be moved \(s4's group can't be set here\)$/);
    expect(a.failedMove.changes).toEqual(["landscapeUpdate", "setGroup", "landscapeUpdate"]);
    expect(a.failedMove).toMatchObject({ placeBack: true, areasBack: true, group: "5101" });
  }, 180_000);
});
