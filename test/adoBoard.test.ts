import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { moveToBoardColumn, resetAdoCache, teamBoards } from "../src/main/ado";

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
