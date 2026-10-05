import { afterEach, describe, expect, it } from "vitest";
import { suggestTicketName, ticketsByColumn, workflowStates } from "../src/renderer/tickets";
import type { AdoWorkItem } from "../src/shared/types";

const item = (id: number, state: string): AdoWorkItem => ({ id, state, title: `t${id}`, type: "Task" }) as AdoWorkItem;

describe("the ticket picker's columns", () => {
  const items = [item(3, "Active"), item(1, "New"), item(2, "Active"), item(4, "Done"), item(5, "QA Review"), item(6, "Closed")];
  const names = (cols: { state: string; items: AdoWorkItem[] }[]) => cols.map((c) => [c.state, c.items.map((i) => i.id)]);

  it("follow the workflow order, leave out terminal states, and list tickets by id", () => {
    expect(names(ticketsByColumn(items, ["New", "Active", "QA Review", "Done"]))).toEqual([
      ["New", [1]],
      ["Active", [2, 3]],
      ["QA Review", [5]],
    ]);
  });
  it("fall back to a generic order for states the workflow doesn't list", () => {
    expect(names(ticketsByColumn(items, [])).map(([s]) => s)).toEqual(["New", "Active", "QA Review"]);
  });
  it("put the Dashboard's dragged column order first, the rest in workflow order", () => {
    const cols = ticketsByColumn(items, ["New", "Active", "QA Review"], ["QA Review", "Gone"]);
    expect(cols.map((c) => c.state)).toEqual(["QA Review", "New", "Active"]);
  });
});

describe("a ticket's branch name", () => {
  it("camel-cases the first five words of the title", () => {
    expect(suggestTicketName("Filter orgs by foundation")).toBe("filterOrgsByFoundation");
    expect(suggestTicketName("Fix: the org dropdown's last-org memory, again!")).toBe("fixTheOrgDropdownS");
  });
});

const g = globalThis as unknown as { window?: { mb: unknown } };
afterEach(() => delete g.window);

describe("a board's workflow states", () => {
  it("joins every type's states in their workflow order", async () => {
    const states: Record<string, string[]> = { Bug: ["New", "Active", "Resolved"], Task: ["New", "Doing", "Done"] };
    g.window = { mb: { adoStates: async (t: string) => states[t] } };
    expect(await workflowStates(["Bug", "Task"])).toEqual({ states: ["New", "Active", "Resolved", "Doing", "Done"], error: "" });
  });
  it("keeps the states it could read and says which type failed", async () => {
    g.window = { mb: { adoStates: async (t: string) => (t === "Bug" ? { error: "401 Unauthorized" } : ["New", "Done"]) } };
    const r = await workflowStates(["Bug", "Task"]);
    expect(r.states).toEqual(["New", "Done"]);
    expect(r.error).toBe("Couldn't read the states a Bug can be in: 401 Unauthorized");
  });
});
