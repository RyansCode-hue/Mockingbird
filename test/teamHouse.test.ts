import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import type { AddressInfo } from "net";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "./helpers";
import { builderHome, fakeHouse, PROJECT_ID, type FakeHouse } from "./fakeHouse";
import { detailOf, HouseClient, HouseSetupError, parseEnvText, readHouseEnv, scrub, sliceOf, ticketOf } from "../src/main/team/house";
import { houseToolOp, isHouseTool } from "../src/main/team/houseTools";
import { branchFor, HOUSE_TOOL_NAMES } from "../src/shared/team/house";

const TOKEN = "hb_live_RYAN_0123456789abcdef";
const PROJECT = "atticus-backoffice";

let houses: FakeHouse[] = [];
afterEach(async () => {
  for (const h of houses) await h.close();
  houses = [];
});
const house = async () => {
  const h = await fakeHouse({ [TOKEN]: "Ryan Ellerbroek" });
  houses.push(h);
  return h;
};

/** A home whose env file says `text` (mode 600 unless given). */
function homeWith(text: string, mode = 0o600): string {
  const home = tempDir("home");
  const dir = path.join(home, ".config", "radley-house");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${PROJECT}.env`), text);
  fs.chmodSync(path.join(dir, `${PROJECT}.env`), mode);
  return home;
}

/** What readHouseEnv throws for this home (never the token). */
function setupError(home: string, o: { allowHttpLoopback?: boolean } = {}): HouseSetupError {
  try {
    readHouseEnv(PROJECT, { home, ...o });
  } catch (err) {
    expect(err).toBeInstanceOf(HouseSetupError);
    expect((err as Error).message).not.toContain(TOKEN);
    return err as HouseSetupError;
  }
  throw new Error("expected the env file to be refused");
}

describe("the House env file", () => {
  it("reads KEY=value lines as the House's setup page writes them, quotes and export included, expanding nothing", () => {
    expect(parseEnvText(`# minted\nexport HOUSE_API_URL="https://house.example"\nHOUSE_PROJECT_ID='p-1'\nHOUSE_BUILD_TOKEN=abc$HOME # note\n\nnot a line\n`)).toEqual({
      HOUSE_API_URL: "https://house.example",
      HOUSE_PROJECT_ID: "p-1",
      HOUSE_BUILD_TOKEN: "abc$HOME",
    });
  });

  it("gives the coordinates and token of a good file, the token also under the House CLI's name", () => {
    const home = homeWith(`HOUSE_API_URL=https://landing.house.example/\nHOUSE_PROJECT_ID=${PROJECT_ID}\nHOUSE_BUILD_TOKEN=${TOKEN}\n`);
    expect(readHouseEnv(PROJECT, { home })).toMatchObject({ apiUrl: "https://landing.house.example", projectId: PROJECT_ID, token: TOKEN });
    const cli = homeWith(`HOUSE_API_URL=https://landing.house.example\nHOUSE_PROJECT_ID=${PROJECT_ID}\nEXTERNAL_BUILD_TOKEN=${TOKEN}\n`);
    expect(readHouseEnv(PROJECT, { home: cli }).token).toBe(TOKEN);
  });

  it("says what to do when the file is missing, and refuses one others can read", () => {
    const missing = setupError(tempDir("home"));
    expect(missing.state).toBe("missing");
    expect(missing.message).toContain(".config/radley-house/atticus-backoffice.env");
    expect(missing.message).toContain("Overview → External build setup → Mint build token");
    const open = setupError(homeWith(`HOUSE_API_URL=https://h.example\nHOUSE_PROJECT_ID=p\nHOUSE_BUILD_TOKEN=${TOKEN}\n`, 0o644));
    expect(open.state).toBe("bad");
    expect(open.message).toMatch(/chmod 600/);
  });

  it("refuses a non-https House, credentials or a query in the URL, and a missing or placeholder token — never echoing the token", () => {
    const http = setupError(homeWith(`HOUSE_API_URL=http://house.example\nHOUSE_PROJECT_ID=p\nHOUSE_BUILD_TOKEN=${TOKEN}\n`), { allowHttpLoopback: true });
    expect(http.message).toMatch(/isn't https .*only over https/);
    // plain http on this Mac only when a test asks for it
    expect(setupError(homeWith(`HOUSE_API_URL=http://127.0.0.1:9\nHOUSE_PROJECT_ID=p\nHOUSE_BUILD_TOKEN=${TOKEN}\n`)).message).toMatch(/isn't https/);
    expect(readHouseEnv(PROJECT, { home: homeWith(`HOUSE_API_URL=http://127.0.0.1:9\nHOUSE_PROJECT_ID=p\nHOUSE_BUILD_TOKEN=${TOKEN}\n`), allowHttpLoopback: true }).apiUrl).toBe("http://127.0.0.1:9");
    expect(setupError(homeWith(`HOUSE_API_URL=https://me:${TOKEN}@house.example\nHOUSE_PROJECT_ID=p\nHOUSE_BUILD_TOKEN=${TOKEN}\n`)).message).toMatch(/user, query or fragment/);
    expect(setupError(homeWith(`HOUSE_API_URL=https://house.example/?t=${TOKEN}\nHOUSE_PROJECT_ID=p\nHOUSE_BUILD_TOKEN=${TOKEN}\n`)).message).toMatch(/user, query or fragment/);
    const none = setupError(homeWith(`HOUSE_API_URL=https://house.example\nHOUSE_PROJECT_ID=p\nHOUSE_BUILD_TOKEN=REPLACE_ME\n`));
    expect(none.message).toMatch(/doesn't set HOUSE_BUILD_TOKEN\. Each builder needs their own token/);
    expect(setupError(homeWith(`HOUSE_API_URL=https://house.example\nHOUSE_PROJECT_ID=../../etc\nHOUSE_BUILD_TOKEN=${TOKEN}\n`)).message).toMatch(/isn't a project id/);
    expect(() => readHouseEnv("../secrets", { home: tempDir("home") })).toThrow(/isn't a House project name/);
  });

  it("scrubs a token from text, as is and URL-encoded", () => {
    expect(scrub(`a ${TOKEN} b ${encodeURIComponent("t/k+n")}`, TOKEN)).toBe("a [build token] b t%2Fk%2Bn");
    expect(scrub("x t/k+n y t%2Fk%2Bn", "t/k+n")).toBe("x [build token] y [build token]");
  });
});

describe("the House client", () => {
  const client = (h: FakeHouse, o: { timeoutMs?: number } = {}) => new HouseClient(readHouseEnv(PROJECT, { home: builderHome(PROJECT, h, TOKEN), allowHttpLoopback: true }), o);

  it("calls each route under the project's external API with the builder's token, and reads the answers", async () => {
    const h = await house();
    h.item(141, { title: "Last-org API", status: "ready", tags: ["needs-agent"] });
    h.state.spec.slice.work_items = [141];
    const c = client(h);
    expect((await c.list()).map((t) => [t.n, t.title, t.claim])).toEqual([[141, "Last-org API", null]]);
    expect(await c.list("needs-agent")).toHaveLength(1);
    expect(sliceOf(await c.spec())).toEqual({ name: "Slice 3 — org memory", numbers: [141], listsTickets: true });
    const created = await c.create({ title: "Export skips archived donors", detail: "Context", acceptance: "A test" });
    expect(created).toMatchObject({ n: 142, title: "Export skips archived donors", status: "parked", detail: "Context", acceptance: "A test" });
    expect((await c.claim(141, "feature/141-last-org"))?.claim).toEqual({ by: "Ryan Ellerbroek", branch: "feature/141-last-org", at: null });
    await c.event(141, { event: "progress", note: "API done", status: "review", reference: "https://example.invalid/pull/1" });
    await c.patch(141, { note: "A comment" });
    const t = await c.ticket(141);
    expect(t.status).toBe("review");
    expect(t.history.map((e) => [e.kind, e.text, e.by])).toEqual([
      ["claim", "Claimed on feature/141-last-org", "Ryan Ellerbroek"],
      ["progress", "API done", "Ryan Ellerbroek"],
      ["comment", "A comment", "Ryan Ellerbroek"],
    ]);
    expect((await c.release(141))?.claim).toBeNull();
    expect(h.requests.every((r) => r.token === TOKEN)).toBe(true);
    expect(h.by(TOKEN)).toEqual([
      "GET work-items",
      "GET work-items?tag=needs-agent",
      "GET spec",
      "POST work-items",
      "POST work-items/141/claim",
      "POST work-items/141/events",
      "PATCH work-items/141",
      "GET work-items/141",
      "POST work-items/141/release",
    ]);
    expect(h.requests.find((r) => r.method === "POST" && r.path.endsWith("work-items"))!.body).toEqual({ kind: "engineering", priority: "medium", title: "Export skips archived donors", detail: "Context", acceptance: "A test" });
    expect(h.requests.find((r) => r.path.endsWith("/claim"))!.body).toEqual({ branch: "feature/141-last-org" });
  });

  it("surfaces the House's own message, with what to do about a refused token — and never the token", async () => {
    const h = await house();
    h.state.echoToken = true;
    const c = client(h);
    await expect(c.ticket(999)).rejects.toThrow("The House answered 404: No work item #999 in this project (token [build token])");
    const stale = new HouseClient({ ...c.env, token: `${TOKEN}-old` });
    const err = await stale.list().catch((e: Error) => e);
    expect(err.message).toMatch(/^The House answered 401: Invalid build token .*your build token is stale or isn't for this project\. Each builder needs their own token/);
    expect(err.message).not.toContain(TOKEN);
    await expect(c.event(1000, { event: "nope", note: "x" })).rejects.toThrow(/404/);
  });

  it("gives up on a House that doesn't answer in time", async () => {
    const h = await house();
    h.state.delayMs = 400;
    await expect(client(h, { timeoutMs: 100 }).list()).rejects.toThrow("didn't answer within 0.1 s");
  });

  it("never follows a redirect, so the token can't be carried to another server", async () => {
    const h = await house();
    const seen: (string | undefined)[] = [];
    const other = http.createServer((req, res) => {
      seen.push(req.headers["x-build-token"] as string | undefined);
      res.end("[]");
    });
    await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
    try {
      const to = `http://127.0.0.1:${(other.address() as AddressInfo).port}/steal`;
      const c = client(h);
      const env = { ...c.env, apiUrl: `${h.url}/redirect?to=${encodeURIComponent(to)}&x=` };
      const err = await new HouseClient(env).list().catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).not.toContain(TOKEN);
      expect(seen).toEqual([]);
    } finally {
      await new Promise<void>((r) => other.close(() => r()));
    }
  });
});

describe("reading what the House answers", () => {
  it("finds a claim however the House names it, and reads a present-but-empty claimant as unclaimed", () => {
    expect(ticketOf({ number: 1, title: "A", status: "in_progress", claim: { by: { name: "Nick Smith" }, branch: "f/1", at: "2026-10-12T10:00:00Z" } })!.claim).toEqual({ by: "Nick Smith", branch: "f/1", at: "2026-10-12T10:00:00Z" });
    expect(ticketOf({ number: 2, title: "B", claimed_by: "Ryan", branch: "f/2" })!.claim).toEqual({ by: "Ryan", branch: "f/2", at: null });
    expect(ticketOf({ number: 3, title: "C", claimed_by: null, branch: "f/3-old" })!.claim).toBeNull();
    expect(ticketOf({ number: 4, title: "D" })!.claim).toBeNull();
    expect(ticketOf({ work_item: { number: "5", title: "E", tags: [{ name: "needs-human" }] } })).toMatchObject({ n: 5, tags: ["needs-human"], status: "unknown" });
    expect(ticketOf({ title: "no number" })).toBeNull();
  });

  it("reads a ticket's history under the names the House may use", () => {
    const d = detailOf({ number: 9, title: "T", description: "why", history: [{ type: "question", text: "which org?", author: { email: "s@example.invalid" }, created_at: "2026-10-12" }], blocked_by: [8, "#7", "x"] });
    expect(d).toMatchObject({ n: 9, detail: "why", blockedBy: [8, 7], history: [{ kind: "question", text: "which org?", by: "s@example.invalid", at: "2026-10-12", status: null, reference: null }] });
  });

  it("finds the slice's name and tickets wherever the spec lists them, and says when it lists none", () => {
    expect(sliceOf({ slice: { title: "Slice 4", tickets: [{ number: 12 }, "#13", 12] } })).toEqual({ name: "Slice 4", numbers: [12, 13], listsTickets: true });
    expect(sliceOf({ name: "Spec v3", sections: [{ title: "Exports", workItems: [21, { n: 22 }] }] })).toEqual({ name: "Spec v3", numbers: [21, 22], listsTickets: true });
    expect(sliceOf({ version: 3, sections: [{ requirements: [{ number: 7, title: "a requirement, not a ticket" }] }] })).toEqual({ name: "3", numbers: [], listsTickets: false });
    expect(sliceOf(null)).toEqual({ name: null, numbers: [], listsTickets: false });
  });
});

describe("the agents' House tools", () => {
  it("are all known to the MCP server's routing", () => {
    expect(HOUSE_TOOL_NAMES.every(isHouseTool)).toBe(true);
    expect(isHouseTool("update_team_plan")).toBe(false);
  });

  it("check their arguments into what the House takes, saying what's wrong", () => {
    expect(houseToolOp("list_house_tickets", {})).toEqual({ tool: "list", filter: "board" });
    expect(houseToolOp("read_house_ticket", { n: "#143" })).toEqual({ tool: "read", n: 143 });
    expect(houseToolOp("post_house_ticket_event", { n: 1, kind: "status", text: "done", status: "review" })).toEqual({ tool: "event", n: 1, kind: "status", text: "done", status: "review" });
    expect(() => houseToolOp("read_house_ticket", { n: 0 })).toThrow(/ticket number/);
    expect(() => houseToolOp("list_house_tickets", { filter: "mine" })).toThrow(/slice, tracked, all/);
    expect(() => houseToolOp("post_house_ticket_event", { n: 1, kind: "status", text: "x" })).toThrow(/needs status/);
    expect(() => houseToolOp("post_house_ticket_event", { n: 1, kind: "status", text: "x", status: "done" })).toThrow(/only staff close/);
    expect(() => houseToolOp("post_house_ticket_event", { n: 1, kind: "shout", text: "x" })).toThrow(/kind is one of/);
    expect(() => houseToolOp("create_house_ticket", { title: "t", description: "d", tags: ["needs-human", "needs-agent"] })).toThrow(/both needs-human and needs-agent/);
    expect(() => houseToolOp("create_house_ticket", { title: " ", description: "d" })).toThrow(/title is empty/);
  });

  it("suggest a branch the House's convention names", () => {
    expect(branchFor(142, "Backfill each user's last org from the audit log")).toBe("feature/142-backfill-each-users-last-org");
    expect(branchFor(7, "!!!")).toBe("feature/7");
  });
});
