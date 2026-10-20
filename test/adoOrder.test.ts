import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listWorkItems, rankOrder, reorderBody, reorderWorkItem, resetAdoCache } from "../src/main/ado";
import type { AdoWorkItem } from "../src/shared/types";

const STACK_RANK = "Microsoft.VSTS.Common.StackRank";

/**
 * A WorkTracker folder with ADO settings, and a fake Azure DevOps holding a
 * team's work items with their Stack Rank. The Work Items Order API ranks an
 * item between its neighbours as ADO does; work item reads come back in id
 * order, as ADO's batch read gives them, whatever order the board is in.
 */
function fakeAdo(opts: { orderField?: string | null; processConfig?: boolean; fields?: string[]; failOrder?: boolean; team?: string } = {}) {
  const wt = fs.mkdtempSync(path.join(os.homedir(), "wt-"));
  fs.writeFileSync(
    path.join(wt, "config.json"),
    JSON.stringify({ azureDevOps: { orgUrl: "https://dev.azure.com/acme", project: "Epsilon", patFile: "pat.txt", ...(opts.team ? { team: opts.team } : {}) } })
  );
  fs.writeFileSync(path.join(wt, "pat.txt"), "secret\n");
  const orderField = opts.orderField === undefined ? STACK_RANK : opts.orderField;
  const rank = new Map<number, number | undefined>([
    [1, 3000],
    [2, 1000],
    [3, undefined],
    [4, 2000],
  ]);
  const calls: { method: string; url: string; body?: any }[] = [];
  const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    if (url.includes("/_apis/connectionData")) return answer(200, { authenticatedUser: { providerDisplayName: "Ryan E" } });
    if (url.includes("/_apis/projects/Epsilon?")) return answer(200, { defaultTeam: { name: "Epsilon Team" } });
    if (url.includes("/_apis/work/boards?")) return answer(200, { value: [] });
    if (url.includes("/_apis/work/processconfiguration?")) {
      if (opts.processConfig === false) return answer(401, { message: "TF400813: not authorized" });
      return answer(200, { typeFields: orderField ? { Order: { referenceName: orderField, name: "Stack Rank", type: "real" } } : {} });
    }
    if (url.includes("/_apis/wit/fields?")) return answer(200, { value: (opts.fields ?? ["System.Title", "System.Tags", STACK_RANK]).map((referenceName) => ({ referenceName })) });
    if (url.includes("/_apis/wit/wiql?")) return answer(200, { workItems: [{ id: 3 }, { id: 1 }, { id: 4 }, { id: 2 }] });
    if (url.includes("/_apis/wit/workitems?ids=")) {
      const asked = new URL(url).searchParams.get("fields")!.split(",");
      const ids = new URL(url).searchParams.get("ids")!.split(",").map(Number).sort((a, b) => a - b);
      return answer(200, {
        value: ids.map((id) => ({
          id,
          fields: { "System.Title": `#${id}`, "System.State": "Active", "System.WorkItemType": "Bug", ...(asked.includes(STACK_RANK) && rank.get(id) !== undefined ? { [STACK_RANK]: rank.get(id) } : {}) },
        })),
      });
    }
    if (url.includes("/_apis/work/workitemsorder?") && method === "PATCH") {
      if (opts.failOrder) return answer(400, { message: "VS402906: the work items aren't in the same backlog" });
      const prev = body.previousId ? rank.get(body.previousId) ?? 0 : 0;
      const next = body.nextId ? rank.get(body.nextId) ?? prev + 2000 : prev + 2000;
      const placed = (prev + next) / 2;
      for (const id of body.ids) rank.set(id, placed);
      return answer(200, { count: body.ids.length, value: body.ids.map((id: number) => ({ id, order: placed })) });
    }
    return answer(404, { message: "not found" });
  });
  return { store: { settings: { workTrackerPath: wt } } as any, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetAdoCache();
});

describe("the board's order", () => {
  it("is the team's backlog order: by the rank the process configuration names, lowest first, unranked last", async () => {
    const { store, calls } = fakeAdo();
    const { items } = await listWorkItems(store);
    expect(items.map((i) => [i.id, i.rank])).toEqual([
      [2, 1000],
      [4, 2000],
      [1, 3000],
      [3, undefined],
    ]);
    expect(calls.map((c) => c.url)).toContain("https://dev.azure.com/acme/Epsilon/_apis/work/processconfiguration?api-version=7.0");
    expect(new URL(calls.find((c) => c.url.includes("/workitems?ids="))!.url).searchParams.get("fields")!.split(",")).toContain(STACK_RANK);
  });

  it("follows a reorder after a refresh", async () => {
    const { store } = fakeAdo();
    await listWorkItems(store);
    await reorderWorkItem(store, 1, 0, 2);
    expect((await listWorkItems(store)).items.map((i) => i.id)).toEqual([1, 2, 4, 3]);
    await reorderWorkItem(store, 3, 2, 4);
    expect((await listWorkItems(store)).items.map((i) => i.id)).toEqual([1, 2, 3, 4]);
  });

  it("falls back to Stack Rank or Backlog Priority, as the project defines them, when the process configuration can't be read, and logs it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { store } = fakeAdo({ processConfig: false });
    expect((await listWorkItems(store)).items.map((i) => i.id)).toEqual([2, 4, 1, 3]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/couldn't read the project's process configuration/), expect.stringMatching(/401/));
    resetAdoCache();
    warn.mockClear();
    // a Scrum project: Backlog Priority, and no Stack Rank to ask for
    const scrum = fakeAdo({ processConfig: false, fields: ["System.Title", "Microsoft.VSTS.Common.BacklogPriority"] });
    await listWorkItems(scrum.store);
    const asked = new URL(scrum.calls.find((c) => c.url.includes("/workitems?ids="))!.url).searchParams.get("fields")!.split(",");
    expect(asked).toContain("Microsoft.VSTS.Common.BacklogPriority");
    expect(asked).not.toContain(STACK_RANK);
    warn.mockRestore();
  });

  it("stays in last-changed order, saying so, when the project has no order field to ask for", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { store, calls } = fakeAdo({ fields: ["System.Title"] });
    const { items } = await listWorkItems(store);
    expect(items.map((i) => i.id)).toEqual([1, 2, 3, 4]); // as the batch read answered
    expect(items.every((i) => i.rank === undefined)).toBe(true);
    expect(new URL(calls.find((c) => c.url.includes("/workitems?ids="))!.url).searchParams.get("fields")).not.toContain(STACK_RANK);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/no backlog order field, so the board is in last-changed order/));
    warn.mockRestore();
  });

  it("keeps equal and missing ranks in the order they came", () => {
    const it = (id: number, rank?: number) => ({ id, ...(rank === undefined ? {} : { rank }) }) as AdoWorkItem;
    expect(rankOrder([it(1), it(2, 5), it(3), it(4, 5), it(5, 1)]).map((i) => i.id)).toEqual([5, 2, 4, 1, 3]);
  });
});

describe("placing a work item with the Work Items Order API", () => {
  it("builds the request ADO's team backlog takes: the item, the ones either side, no parent", () => {
    expect(reorderBody(42, 7, 9)).toEqual({ parentId: 0, previousId: 7, nextId: 9, ids: [42] });
    expect(reorderBody(42, 0, 9)).toEqual({ parentId: 0, previousId: 0, nextId: 9, ids: [42] });
  });

  it("PATCHes the team's workitemsorder, the default team's when none is set, and answers with the new rank", async () => {
    const { store, calls } = fakeAdo();
    expect(await reorderWorkItem(store, 1, 2, 4)).toEqual({ id: 1, rank: 1500 });
    const write = calls.filter((c) => c.method !== "GET");
    expect(write).toEqual([
      { method: "PATCH", url: "https://dev.azure.com/acme/Epsilon/Epsilon%20Team/_apis/work/workitemsorder?api-version=7.1", body: { parentId: 0, previousId: 2, nextId: 4, ids: [1] } },
    ]);
  });

  it("uses azureDevOps.team when it's set", async () => {
    const { store, calls } = fakeAdo({ team: "Platform & Data" });
    await reorderWorkItem(store, 1, 0, 2);
    expect(calls.find((c) => c.method === "PATCH")!.url).toBe("https://dev.azure.com/acme/Epsilon/Platform%20%26%20Data/_apis/work/workitemsorder?api-version=7.1");
  });

  it("passes on ADO's refusal", async () => {
    const { store } = fakeAdo({ failOrder: true });
    await expect(reorderWorkItem(store, 1, 0, 2)).rejects.toThrow(/Azure DevOps 400.*VS402906/);
  });

  it("refuses a place that names nothing, itself, or the same card twice, without writing", async () => {
    const { store, calls } = fakeAdo();
    await expect(reorderWorkItem(store, 0, 1, 2)).rejects.toThrow(/Not a work item id/);
    await expect(reorderWorkItem(store, 1, -3, 2)).rejects.toThrow(/Not a place for #1/);
    await expect(reorderWorkItem(store, 1, 1.5, 2)).rejects.toThrow(/Not a place for #1/);
    await expect(reorderWorkItem(store, 1, 1, 2)).rejects.toThrow(/beside itself/);
    await expect(reorderWorkItem(store, 1, 0, 0)).rejects.toThrow(/Nothing to place #1 beside/);
    await expect(reorderWorkItem(store, 1, 2, 2)).rejects.toThrow(/both after and before #2/);
    expect(calls).toEqual([]);
  });
});
