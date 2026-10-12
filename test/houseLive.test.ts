import * as os from "os";
import { describe, expect, it } from "vitest";
import { detailOf, HouseClient, readHouseEnv, sliceOf, ticketOf } from "../src/main/team/house";

/**
 * Mockingbird's House client against the real Radley House — reads only (GET),
 * never a claim, event, ticket or anything else that writes. Run by hand, once
 * a builder token is set up, to check the shapes the board relies on:
 *
 *   MB_HOUSE_LIVE=1 npx vitest run test/houseLive.test.ts
 *
 * It reads the real home's ~/.config/radley-house/<project>.env (the suite's
 * own HOME is a throwaway one), MB_HOUSE_LIVE_PROJECT naming the project
 * (default atticus-backoffice). It prints the answers' field names, never
 * their values or the token. Never in CI.
 */

const live = process.env.MB_HOUSE_LIVE === "1" && !process.env.CI;
const project = process.env.MB_HOUSE_LIVE_PROJECT ?? "atticus-backoffice";

/** An answer's field names, nested one level, for comparing with what the readers look for. */
const shape = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.length ? [shape(v[0])] : [];
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x && typeof x === "object" ? (Array.isArray(x) ? `array(${x.length})` : `{${Object.keys(x).join(", ")}}`) : typeof x]));
  return typeof v;
};

describe.skipIf(!live)("the real Radley House (reads only)", () => {
  it("reads the backlog, a ticket with its history, and the spec, in shapes the board understands", async () => {
    const client = new HouseClient(readHouseEnv(project, { home: os.userInfo().homedir }));
    const raw = await client.call("GET", "work-items");
    const list = Array.isArray(raw) ? raw : [];
    console.log(`[house live] work-items: ${list.length} items; an item's fields:`, JSON.stringify(shape(list[0])));
    const tickets = list.map(ticketOf);
    expect(tickets.every(Boolean)).toBe(true);
    const claimed = tickets.filter((t) => t?.claim);
    console.log(`[house live] read as claimed: ${claimed.length}; with a branch: ${claimed.filter((t) => t?.claim?.branch).length}; with a claimant: ${claimed.filter((t) => t?.claim?.by).length}`);

    if (list.length) {
      const n = tickets[0]!.n;
      const one = await client.call("GET", `work-items/${n}`);
      console.log(`[house live] work-items/${n} fields:`, JSON.stringify(shape(one)));
      const history = (one as { history?: unknown[] })?.history;
      if (Array.isArray(history) && history.length) console.log("[house live] a history entry's fields:", JSON.stringify(shape(history[0])));
      const d = detailOf(one);
      expect(d?.n).toBe(n);
      expect(Array.isArray(d?.history)).toBe(true);
    }

    const spec = await client.spec();
    console.log("[house live] spec fields:", JSON.stringify(shape(spec)));
    const slice = sliceOf(spec);
    console.log(`[house live] slice read as: name ${slice.name ? "found" : "missing"}, ${slice.numbers.length} tickets, listsTickets ${slice.listsTickets}`);
  }, 60_000);
});
