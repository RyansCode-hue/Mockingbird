import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { adoEnv, adoIdentity, adoRequest, listComments, listWorkItems, moveToBoardColumn, resetAdoCache, teamBoards, writeAdoSnapshot } from "../src/main/ado";

/** A WorkTracker folder with ADO settings, and a fake Azure DevOps that records requests. */
function setup(routes: Record<string, unknown>) {
  const wt = fs.mkdtempSync(path.join(os.homedir(), "wt-"));
  fs.writeFileSync(path.join(wt, "config.json"), JSON.stringify({ azureDevOps: { orgUrl: "https://dev.azure.com/acme/", project: "Epsilon", patFile: "pat.txt" } }));
  fs.writeFileSync(path.join(wt, "pat.txt"), "secret\n");
  const calls: { method: string; url: string; body?: unknown }[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const hit = Object.entries(routes).find(([k]) => url.includes(k));
    return new Response(JSON.stringify(hit ? hit[1] : { message: "not found" }), { status: hit ? 200 : 404 });
  });
  return { store: { settings: { workTrackerPath: wt } } as any, calls };
}
const routes = {
  "/_apis/projects/Epsilon?": { defaultTeam: { name: "Epsilon Team" } },
  "/Epsilon%20Team/_apis/work/boards?": { value: [{ id: "b1", name: "Backlog items" }] },
  "/Epsilon%20Team/_apis/work/boards/b1?": {
    fields: { columnField: { referenceName: "WEF_X_Kanban.Column" } },
    columns: [
      { name: "Idea", columnType: "incoming", stateMappings: { Bug: "New" } },
      { name: "Planning", columnType: "inProgress", stateMappings: { Bug: "New" } },
      { name: "In Progress", columnType: "inProgress", stateMappings: { Bug: "In Progress" } },
    ],
  },
  "/_apis/wit/workitems/42?": { id: 42 },
};

afterEach(() => {
  vi.unstubAllGlobals();
  resetAdoCache();
});

describe("the team's board in Azure DevOps", () => {
  it("reads the default team's boards with their columns and state mappings", async () => {
    const { store } = setup(routes);
    const { team, boards } = await teamBoards(store);
    expect(team).toBe("Epsilon Team");
    expect(boards).toEqual([
      {
        id: "b1",
        name: "Backlog items",
        columnField: "WEF_X_Kanban.Column",
        columns: [
          { name: "Idea", type: "incoming", stateMappings: { Bug: "New" } },
          { name: "Planning", type: "inProgress", stateMappings: { Bug: "New" } },
          { name: "In Progress", type: "inProgress", stateMappings: { Bug: "In Progress" } },
        ],
      },
    ]);
  });

  it("moves a card by setting the column's state and the board column field", async () => {
    const { store, calls } = setup(routes);
    expect(await moveToBoardColumn(store, 42, "Bug", "Backlog items", "Planning")).toEqual({ id: 42, state: "New" });
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.url).toBe("https://dev.azure.com/acme/Epsilon/_apis/wit/workitems/42?api-version=7.0");
    expect(patch.body).toEqual([
      { op: "add", path: "/fields/System.State", value: "New" },
      { op: "add", path: "/fields/WEF_X_Kanban.Column", value: "Planning" },
    ]);
  });

  it("refuses a column the card's type has no place in, without writing anything", async () => {
    const { store, calls } = setup(routes);
    await expect(moveToBoardColumn(store, 42, "Feature", "Backlog items", "Idea")).rejects.toThrow(/A Feature can't go in Idea/);
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });
});

describe("talking to Azure DevOps", () => {
  it("decodes comment HTML once, so escaped markup stays escaped", async () => {
    const { store } = setup({ "/workItems/7/comments?": { comments: [{ id: 1, createdBy: { displayName: "A" }, createdDate: "2026-01-01", text: "<div>&amp;lt;b&amp;gt; &amp;amp; &lt;i&gt; &quot;q&quot;</div>" }] } });
    expect((await listComments(store, 7))[0].text).toBe('&lt;b&gt; &amp; <i> "q"');
  });

  it("gives up on a request after 30s, saying where to look", async () => {
    const { store } = setup({});
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    await expect(adoRequest(store, "https://dev.azure.com/acme/_apis/x")).rejects.toThrow(/didn't answer within 30s/);
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("debriefs run without the PAT when the config can't be read, and say why — never printing the PAT", () => {
    const { store } = setup({});
    expect(adoEnv(store)).toEqual({ AZURE_DEVOPS_EXT_PAT: "secret" });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    fs.writeFileSync(path.join(store.settings.workTrackerPath, "config.json"), "{ not json");
    expect(adoEnv(store)).toEqual({});
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/without Azure DevOps/), expect.stringMatching(/config\.json/));
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
    log.mockRestore();
  });
});

describe("who the PAT belongs to", () => {
  const me = { "/_apis/connectionData": { authenticatedUser: { providerDisplayName: "Ryan E", properties: { Account: { $value: "ryan@acme.test" } } } } };
  const items = {
    "/_apis/wit/wiql?": { workItems: [{ id: 1 }, { id: 2 }] },
    "/_apis/wit/workitems?ids=": {
      value: [
        { id: 1, fields: { "System.Title": "Mine", "System.State": "Active", "System.AssignedTo": { displayName: "Ryan E", uniqueName: "ryan@acme.test" } } },
        { id: 2, fields: { "System.Title": "Nobody's", "System.State": "New" } },
      ],
    },
    "/comments?": { comments: [] },
  };
  const quiet = () => vi.spyOn(console, "error").mockImplementation(() => {});

  it("names the owner for Settings and setup", async () => {
    const { store } = setup(me);
    expect(await adoIdentity(store)).toEqual({ display: "Ryan E", email: "ryan@acme.test", org: "https://dev.azure.com/acme", project: "Epsilon" });
  });

  it("fails when Azure DevOps can't be asked or won't say, so setup never reports a blank connection", async () => {
    const log = quiet();
    await expect(adoIdentity(setup({}).store)).rejects.toThrow(/Azure DevOps 404/);
    await expect(adoIdentity(setup({ "/_apis/connectionData": { authenticatedUser: {} } }).store)).rejects.toThrow(/didn't say who the PAT belongs to/);
    log.mockRestore();
  });

  it("the board still loads without an owner, with nobody as me", async () => {
    const log = quiet();
    const { store } = setup(items);
    expect(await listWorkItems(store)).toMatchObject({ total: 2, me: "" });
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("the debrief snapshot lists the owner's open items, and refuses to guess when the owner is unknown", async () => {
    const { store } = setup({ ...me, ...items });
    const snap = await writeAdoSnapshot(store);
    expect(snap.count).toBe(1);
    expect(fs.readFileSync(snap.file, "utf8")).toMatch(/## #1 · Mine/);
    resetAdoCache();

    const log = quiet();
    const unknown = setup(items);
    await expect(writeAdoSnapshot(unknown.store)).rejects.toThrow(/which work items are yours/);
    expect(fs.existsSync(path.join(unknown.store.settings.workTrackerPath, "session-digests"))).toBe(false);
    log.mockRestore();
  });
});
