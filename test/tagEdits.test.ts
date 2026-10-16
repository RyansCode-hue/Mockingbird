import { describe, expect, it, vi } from "vitest";
import { blockAction, editTags, tagSuggestions } from "../src/renderer/tagEdits";
import { blockedReasons, splitTagInput } from "../src/shared/cardRules";
import type { AdoCardRules, AdoWorkItem } from "../src/shared/types";

const item = (over: Partial<AdoWorkItem> = {}): AdoWorkItem => ({ id: 42, title: "t", state: "Active", type: "Bug", assignedTo: "", changed: "", description: "", url: "", tags: [], ...over });
const noRules: AdoCardRules = { fill: [], tags: [], ignored: [] };
const blockedRule: AdoCardRules = { fill: [{ name: "Blocked", clauses: [{ field: "System.Tags", op: "contains", value: "Blocked", logic: "and" }], background: "#f4a3a3", blocked: true }], tags: [], ignored: [] };
const priorityRule: AdoCardRules = { fill: [{ name: "Stuck P1", clauses: [{ field: "Microsoft.VSTS.Common.Priority", op: "=", value: "1", logic: "and" }], background: "#f4a3a3", blocked: true }], tags: [], ignored: [] };

describe("a tag edit on the board", () => {
  it("shows the change at once, then the tags Azure DevOps stored", async () => {
    const shown: string[][] = [];
    const write = vi.fn(async () => ({ id: 42, tags: ["frontend", "Teammate", "perf"] }));
    const r = await editTags(item({ tags: ["frontend"] }), { add: ["perf"] }, write, (_id, t) => shown.push(t));
    expect(write).toHaveBeenCalledWith(42, { add: ["perf"] });
    expect(shown).toEqual([["frontend", "perf"], ["frontend", "Teammate", "perf"]]);
    expect(r).toEqual({ tags: ["frontend", "Teammate", "perf"] });
  });

  it("puts the tags back and returns the error when the write fails", async () => {
    const shown: string[][] = [];
    const r = await editTags(item({ tags: ["Blocked", "perf"] }), { remove: ["blocked"] }, async () => ({ error: "Azure DevOps 403 Forbidden" }), (_id, t) => shown.push(t));
    expect(shown).toEqual([["perf"], ["Blocked", "perf"]]);
    expect(r).toEqual({ error: "Azure DevOps 403 Forbidden" });
  });

  it("treats a write that throws like one that fails", async () => {
    const shown: string[][] = [];
    const r = await editTags(item({ tags: [] }), { add: ["perf"] }, async () => Promise.reject(new Error("IPC gone")), (_id, t) => shown.push(t));
    expect(shown).toEqual([["perf"], []]);
    expect(r).toEqual({ error: "IPC gone" });
  });

  it("splits typed tags on ADO's separator", () => {
    expect(splitTagInput(" needs  QA ; perf;; ")).toEqual(["needs QA", "perf"]);
  });
});

describe("Mark blocked / Unblock", () => {
  it("offers Mark blocked on work that isn't blocked, adding the plain tag", () => {
    expect(blockAction(item({ tags: ["perf"] }), noRules)).toEqual({ key: "block", label: "Mark blocked", change: { add: ["blocked"] }, note: null });
  });

  it("Unblock removes the blocked tag, whatever its case, and the card is no longer blocked", () => {
    const it = item({ tags: ["Blocked", "perf"] });
    const a = blockAction(it, blockedRule);
    expect(a).toEqual({ key: "unblock", label: "Unblock", change: { remove: ["Blocked"] }, note: null });
    // the board's "Tags contains Blocked" rule stops matching too
    expect(blockedReasons({ ...it, tags: ["perf"] }, blockedRule)).toEqual([]);
  });

  it("blocked by the Blocked field only, Unblock writes nothing and says so", () => {
    const a = blockAction(item({ fields: { "Microsoft.VSTS.CMMI.Blocked": "Yes" } }), noRules);
    expect(a.key).toBe("unblock");
    expect(a.change).toBeNull();
    expect(a.note).toMatch(/#42 has no “blocked” tag to remove; it's blocked by: Blocked field is Yes\. Change that in Azure DevOps\./);
  });

  it("blocked by a card rule only, Unblock writes nothing and names the rule", () => {
    const a = blockAction(item({ fields: { "Microsoft.VSTS.Common.Priority": "1" } }), priorityRule);
    expect(a.change).toBeNull();
    expect(a.note).toMatch(/card rule “Stuck P1”/);
  });

  it("with a blocked tag and the Blocked field, Unblock removes the tag and says the field still blocks it", () => {
    const a = blockAction(item({ tags: ["blocked"], fields: { "Microsoft.VSTS.CMMI.Blocked": "Yes" } }), noRules);
    expect(a.change).toEqual({ remove: ["blocked"] });
    expect(a.note).toMatch(/Removed the “blocked” tag, but #42 is still blocked: Blocked field is Yes/);
  });

  it("a tag like blocked-by-crm isn't the plain tag: Unblock points at the chip to remove", () => {
    const a = blockAction(item({ tags: ["blocked-by-crm"] }), noRules);
    expect(a.change).toBeNull();
    expect(a.note).toMatch(/blocked by: tag “blocked-by-crm”\. Remove that tag here\./);
  });
});

describe("Add tag's suggestions", () => {
  it("are the board's tags, most used first, then the project's, never one the item has", () => {
    const items = [item({ tags: ["perf", "frontend"] }), item({ id: 2, tags: ["Perf"] }), item({ id: 3, tags: ["backend"] })];
    expect(tagSuggestions(items, ["security", "PERF", "a11y"], ["Frontend"])).toEqual(["perf", "backend", "a11y", "security"]);
  });
});
