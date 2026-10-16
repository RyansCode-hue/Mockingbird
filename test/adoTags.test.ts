import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectTags, resetAdoCache, setWorkItemTags, tagsPatch } from "../src/main/ado";

/**
 * A WorkTracker folder with ADO settings, and a fake Azure DevOps holding one
 * work item (#42) whose System.Tags a test can change behind the app's back.
 * PATCHes apply their ops as ADO does; `failPatch` answers them with an error.
 */
function fakeAdo(tags: string, opts: { failPatch?: boolean } = {}) {
  const wt = fs.mkdtempSync(path.join(os.homedir(), "wt-"));
  fs.writeFileSync(path.join(wt, "config.json"), JSON.stringify({ azureDevOps: { orgUrl: "https://dev.azure.com/acme", project: "Epsilon", patFile: "pat.txt" } }));
  fs.writeFileSync(path.join(wt, "pat.txt"), "secret\n");
  const server = { tags, rev: 1 };
  const calls: { method: string; url: string; body?: any }[] = [];
  const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    const item = () => ({ id: 42, rev: server.rev, fields: server.tags ? { "System.Tags": server.tags } : {} });
    if (url.includes("/_apis/wit/workitems/42?") && method === "GET") return answer(200, item());
    if (url.includes("/_apis/wit/workitems/42?") && method === "PATCH") {
      if (opts.failPatch) return answer(403, { message: "TF401289: no permission to edit work item 42" });
      for (const op of body) if (op.path === "/fields/System.Tags") server.tags = op.value;
      server.rev++;
      return answer(200, item());
    }
    if (url.includes("/_apis/wit/tags?")) return answer(200, { count: 2, value: [{ id: "a", name: "perf" }, { id: "b", name: "regression" }] });
    return answer(404, { message: "not found" });
  });
  return { store: { settings: { workTrackerPath: wt } } as any, calls, server };
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetAdoCache();
});

describe("the JSON-Patch for a tag change", () => {
  const op = (value: string) => [{ op: "add", path: "/fields/System.Tags", value }];

  it("adds a tag after the ones there, as ADO's \"; \"-separated string", () => {
    expect(tagsPatch("frontend; perf", { add: ["a11y"] })).toEqual({ tags: ["frontend", "perf", "a11y"], ops: op("frontend; perf; a11y") });
  });

  it("removes a tag in any case, and clears the field when it was the last", () => {
    expect(tagsPatch("frontend; Perf", { remove: ["perf"] }).ops).toEqual(op("frontend"));
    expect(tagsPatch("Blocked", { remove: ["blocked"] })).toEqual({ tags: [], ops: op("") });
  });

  it("dedupes case-insensitively, keeping the spelling already there and the case typed for new ones", () => {
    expect(tagsPatch("Perf", { add: ["PERF", "Tech Debt", "TECH DEBT"] }).ops).toEqual(op("Perf; Tech Debt"));
  });

  it("collapses whitespace in a typed tag but keeps its case", () => {
    expect(tagsPatch("", { add: ["  Needs   QA \t"] }).ops).toEqual(op("Needs QA"));
  });

  it("writes nothing when the change changes nothing", () => {
    expect(tagsPatch("frontend; perf", { add: ["PERF"], remove: ["gone"] })).toEqual({ tags: ["frontend", "perf"], ops: [] });
  });
});

describe("changing a work item's tags in Azure DevOps", () => {
  it("re-reads the tags just before writing, so a tag a teammate added since the board loaded survives", async () => {
    const { store, calls, server } = fakeAdo("frontend");
    // the board loaded "frontend"; a teammate then adds a tag in ADO
    server.tags = "frontend; Teammate";
    expect(await setWorkItemTags(store, 42, { add: ["perf"] })).toEqual({ id: 42, tags: ["frontend", "Teammate", "perf"] });
    expect(server.tags).toBe("frontend; Teammate; perf");
    expect(calls.map((c) => c.method)).toEqual(["GET", "PATCH"]);
    expect(calls[0].url).toBe("https://dev.azure.com/acme/Epsilon/_apis/wit/workitems/42?fields=System.Tags&api-version=7.0");
    expect(calls[1].body).toEqual([{ op: "add", path: "/fields/System.Tags", value: "frontend; Teammate; perf" }]);
  });

  it("removes only the tag asked for, from the tags ADO has now", async () => {
    const { store, server } = fakeAdo("Blocked; perf");
    server.tags = "Blocked; perf; Teammate";
    expect((await setWorkItemTags(store, 42, { remove: ["blocked"] })).tags).toEqual(["perf", "Teammate"]);
    expect(server.tags).toBe("perf; Teammate");
  });

  it("doesn't write when ADO already has the change — a teammate removed the tag first", async () => {
    const { store, calls } = fakeAdo("frontend");
    expect(await setWorkItemTags(store, 42, { remove: ["perf"] })).toEqual({ id: 42, tags: ["frontend"] });
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("fails with ADO's reason when the write is refused, so the board can put the tags back", async () => {
    const { store } = fakeAdo("frontend", { failPatch: true });
    await expect(setWorkItemTags(store, 42, { add: ["perf"] })).rejects.toThrow(/Azure DevOps 403.*TF401289/);
  });

  it("refuses a malformed request without asking ADO anything", async () => {
    const { store, calls } = fakeAdo("frontend");
    await expect(setWorkItemTags(store, 42, { add: ["  "] })).rejects.toThrow(/No tags to add or remove/);
    await expect(setWorkItemTags(store, 42, {} as any)).rejects.toThrow(/No tags to add or remove/);
    await expect(setWorkItemTags(store, -1, { add: ["perf"] })).rejects.toThrow(/Not a work item id/);
    expect(calls).toEqual([]);
  });

  it("reads the project's tag list for suggestions with a GET", async () => {
    const { store, calls } = fakeAdo("");
    expect(await projectTags(store)).toEqual(["perf", "regression"]);
    expect(calls).toEqual([{ method: "GET", url: "https://dev.azure.com/acme/Epsilon/_apis/wit/tags?api-version=7.1-preview.1", body: undefined }]);
  });
});
