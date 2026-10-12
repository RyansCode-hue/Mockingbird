import * as os from "os";
import { describe, it } from "vitest";
import { houseCheck } from "./houseCheck";
import { HouseClient, readHouseEnv } from "../src/main/team/house";

/**
 * Mockingbird's House client against the real Radley House — reads only (GET),
 * never a claim, event, ticket or anything else that writes. Run by hand, once
 * a builder token is set up, to check the shapes the board relies on:
 *
 *   MB_HOUSE_LIVE=1 npx vitest run test/houseLive.test.ts
 *
 * It reads the real home's ~/.config/radley-house/<project>.env (the suite's
 * own HOME is a throwaway one), MB_HOUSE_LIVE_PROJECT naming the project
 * (default atticus-backoffice). It checks the open backlog (non-empty when the
 * House has open tickets), that every status and priority is one the board
 * knows, and that history entries render; it prints field names, counts and
 * the House's enum values — never titles, names, notes, branches or the
 * token (test/houseCheck.ts). Never in CI.
 */

const live = process.env.MB_HOUSE_LIVE === "1" && !process.env.CI;
const project = process.env.MB_HOUSE_LIVE_PROJECT ?? "atticus-backoffice";

describe.skipIf(!live)("the real Radley House (reads only)", () => {
  it("reads the backlog into the open backlog, every status and priority known, and tickets' histories rendered", async () => {
    await houseCheck(new HouseClient(readHouseEnv(project, { home: os.userInfo().homedir })), (line) => console.log(`[house live] ${line}`));
  }, 60_000);
});
