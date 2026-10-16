import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import {
  BLOCKED_FIELD,
  blockedReasons,
  cardFill,
  chipColors,
  contrast,
  fillRuleFor,
  hexColor,
  isBlockedTag,
  parseCardRules,
  parseColor,
  parseTags,
  ruleFields,
  ruleMatches,
  tagColor,
  type CardPalette,
} from "../src/shared/cardRules";
import type { AdoCardRules, AdoFillRule, AdoWorkItem } from "../src/shared/types";

const item = (over: Partial<AdoWorkItem> = {}): AdoWorkItem => ({
  id: 1,
  title: "A ticket",
  state: "Active",
  type: "Bug",
  assignedTo: "",
  changed: "",
  description: "",
  url: "",
  tags: [],
  ...over,
});
const clause = (fieldName: string, operator: string, value: string, logicalOperator = "") => ({ fieldName, operator, value, logicalOperator });
const fill = (name: string, clauses: object[], bg = "#ff0000", isEnabled: unknown = "true") => ({ name, isEnabled, clauses, settings: { "background-color": bg } });

describe("work item tags", () => {
  it("splits System.Tags on semicolons, trimming, dropping blanks and repeats", () => {
    expect(parseTags("Blocked; perf;  ;regression ; PERF")).toEqual(["Blocked", "perf", "regression"]);
    expect(parseTags("")).toEqual([]);
    expect(parseTags(undefined)).toEqual([]);
  });
});

describe("blocked work", () => {
  it("counts a blocked tag in any case, and tags that start with it as a word", () => {
    for (const t of ["blocked", "Blocked", "BLOCKED", "blocked-by-crm", "Blocked: waiting on QA", "blocked_by_api", "blocked (keys)"]) expect(isBlockedTag(t), t).toBe(true);
    for (const t of ["unblocked", "blocker", "blockedness", "not blocked", "perf"]) expect(isBlockedTag(t), t).toBe(false);
  });

  it("says why an item is blocked: its tags, the CMMI Blocked field, a blocked card rule", () => {
    expect(blockedReasons(item({ tags: ["perf", "blocked-by-crm"] }))).toEqual(["tag “blocked-by-crm”"]);
    expect(blockedReasons(item({ fields: { [BLOCKED_FIELD]: "Yes" } }))).toEqual(["Blocked field is Yes"]);
    expect(blockedReasons(item({ fields: { [BLOCKED_FIELD]: "No" } }))).toEqual([]);
    const rules = parseCardRules({ rules: { fill: [fill("Waiting on others", [clause("Custom.WaitingOn", "=", "Vendor")]), fill("Stuck", [clause("System.Tags", "Contains", "on-hold")])] } });
    // "Stuck" tests no blocked tag and isn't named for it: it styles, it doesn't block
    expect(rules.fill.map((r) => r.blocked)).toEqual([false, false]);
    const named = parseCardRules({ rules: { fill: [fill("Blocked by vendor", [clause("Custom.WaitingOn", "=", "Vendor")])] } });
    expect(blockedReasons(item({ fields: { "Custom.WaitingOn": "vendor" } }), named)).toEqual(["card rule “Blocked by vendor”"]);
    expect(blockedReasons(item({ tags: ["perf"] }), named)).toEqual([]);
  });
});

describe("reading a board's card rules", () => {
  it("keeps enabled rules it can check, in the board's order, with their colours", () => {
    const rules = parseCardRules({
      rules: {
        fill: [
          fill("Blocked", [clause("System.Tags", "Contains", "Blocked")], "#F4A3A3"),
          fill("Off", [clause("System.Tags", "Contains", "x")], "#000000", "false"),
          fill("Urgent", [clause("Microsoft.VSTS.Common.Priority", "=", "1"), clause("System.State", "=", "Active", "AND")], "#fe0"),
        ],
        tagStyle: [
          { name: "regression", isEnabled: "true", settings: { "background-color": "#CC293D", color: "#FFFFFF" } },
          { name: "old", isEnabled: false, settings: { "background-color": "#CC293D" } },
        ],
      },
    });
    expect(rules).toEqual({
      fill: [
        { name: "Blocked", clauses: [{ field: "System.Tags", op: "contains", value: "Blocked", logic: "and" }], background: "#f4a3a3", blocked: true },
        {
          name: "Urgent",
          clauses: [
            { field: "Microsoft.VSTS.Common.Priority", op: "=", value: "1", logic: "and" },
            { field: "System.State", op: "=", value: "Active", logic: "and" },
          ],
          background: "#ffee00",
          blocked: false,
        },
      ],
      tags: [{ tag: "regression", background: "#cc293d" }],
      ignored: [],
    });
    expect(ruleFields(rules)).toEqual(["System.Tags", "Microsoft.VSTS.Common.Priority", "System.State"]);
  });

  it("leaves out, whole, a rule with any condition it can't check exactly, and says why", () => {
    const rules = parseCardRules({
      rules: {
        fill: [
          fill("Old", [clause("System.ChangedDate", "<", "2026-01-01")]),
          fill("Mine", [clause("System.AssignedTo", "=", "@Me")]),
          fill("Not tagged", [clause("System.Tags", "Does Not Contain", "x")]),
          fill("Words", [clause("System.Title", "Contains", "login")]),
          fill("Half", [clause("System.Tags", "Contains", "a"), clause("Microsoft.VSTS.Common.Priority", "In", "1,2", "OR")]),
          fill("Odd join", [clause("System.Tags", "Contains", "a"), clause("System.Tags", "Contains", "b", "XOR")]),
          fill("No colour", [clause("System.Tags", "Contains", "a")], "red"),
          { name: "Empty", isEnabled: "true", clauses: [], settings: { "background-color": "#ffffff" } },
        ],
      },
    });
    expect(rules.fill).toEqual([]);
    expect(rules.ignored).toEqual([
      "“Old”: System.ChangedDate < isn't a condition Mockingbird checks (only tags contain, and field =)",
      "“Mine”: System.AssignedTo compares to @Me, a macro",
      "“Not tagged”: System.Tags Does Not Contain isn't a condition Mockingbird checks (only tags contain, and field =)",
      "“Words”: System.Title Contains isn't a condition Mockingbird checks (only tags contain, and field =)",
      "“Half”: Microsoft.VSTS.Common.Priority In isn't a condition Mockingbird checks (only tags contain, and field =)",
      "“Odd join”: joins conditions with “XOR”",
      "“No colour”: no fill colour",
      "“Empty”: no conditions",
    ]);
  });

  it("reads an empty or missing answer as no rules", () => {
    expect(parseCardRules({})).toEqual({ fill: [], tags: [], ignored: [] });
    expect(parseCardRules(null)).toEqual({ fill: [], tags: [], ignored: [] });
  });

  it("reads colours as Azure DevOps writes them", () => {
    expect(hexColor("#ABC")).toBe("#aabbcc");
    expect(hexColor(" #00FF7f ")).toBe("#00ff7f");
    expect(hexColor("red")).toBeNull();
    expect(hexColor("#12345")).toBeNull();
  });
});

describe("applying card rules", () => {
  const rule = (clauses: AdoFillRule["clauses"], name = "r"): AdoFillRule => ({ name, clauses, background: "#ff0000", blocked: false });
  const c = (field: string, op: "=" | "contains", value: string, logic: "and" | "or" = "and") => ({ field, op, value, logic });

  it("matches tags by whole tag, in any case", () => {
    const r = rule([c("System.Tags", "contains", "Regression")]);
    expect(ruleMatches(item({ tags: ["perf", "regression"] }), r)).toBe(true);
    expect(ruleMatches(item({ tags: ["regressions"] }), r)).toBe(false);
  });

  it("compares fields as WIQL does: any case, numbers by value, people by name or email", () => {
    expect(ruleMatches(item({ state: "active" }), rule([c("System.State", "=", "Active")]))).toBe(true);
    expect(ruleMatches(item({ fields: { "Microsoft.VSTS.Common.Priority": "1" } }), rule([c("Microsoft.VSTS.Common.Priority", "=", "1.0")]))).toBe(true);
    const ryan = item({ fields: { "System.AssignedTo": "Ryan E <ryan@acme.test>" } });
    for (const v of ["Ryan E", "ryan@acme.test", "Ryan E <ryan@acme.test>"]) expect(ruleMatches(ryan, rule([c("System.AssignedTo", "=", v)])), v).toBe(true);
    expect(ruleMatches(ryan, rule([c("System.AssignedTo", "=", "Sam")]))).toBe(false);
  });

  it("doesn't style a card by a field that wasn't loaded", () => {
    expect(ruleMatches(item(), rule([c("Microsoft.VSTS.Common.Priority", "=", "")]))).toBe(false);
    expect(ruleMatches(item({ fields: { "Microsoft.VSTS.Common.Priority": "" } }), rule([c("Microsoft.VSTS.Common.Priority", "=", "")]))).toBe(true);
  });

  it("reads AND before OR", () => {
    // tags contain a AND state = New, OR tags contain b
    const r = rule([c("System.Tags", "contains", "a"), c("System.State", "=", "New"), c("System.Tags", "contains", "b", "or")]);
    expect(ruleMatches(item({ tags: ["a"], state: "New" }), r)).toBe(true);
    expect(ruleMatches(item({ tags: ["a"], state: "Active" }), r)).toBe(false);
    expect(ruleMatches(item({ tags: ["b"], state: "Active" }), r)).toBe(true);
  });

  it("fills a card by the first rule that matches, as the board does, and colours tags by name", () => {
    const rules: AdoCardRules = { fill: [rule([c("System.Tags", "contains", "a")], "first"), rule([c("System.State", "=", "Active")], "second")], tags: [{ tag: "Perf", background: "#00ff00" }], ignored: [] };
    expect(fillRuleFor(item({ tags: ["a"] }), rules)?.name).toBe("first");
    expect(fillRuleFor(item(), rules)?.name).toBe("second");
    expect(fillRuleFor(item({ state: "New" }), rules)).toBeNull();
    expect(tagColor("perf", rules)).toBe("#00ff00");
    expect(tagColor("other", rules)).toBeNull();
  });
});

describe("Azure DevOps colours in Mockingbird's themes", () => {
  // the tokens a card is drawn with, read from styles.css as test/contrast.test.ts does
  const css = fs.readFileSync(path.join(__dirname, "../src/renderer/styles.css"), "utf8");
  const block = (selector: string) => {
    const start = css.indexOf(`${selector} {`);
    const body = css.slice(start, css.indexOf("}", start));
    return Object.fromEntries([...body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  };
  const dark = block(":root");
  const themes = { dark, light: { ...dark, ...block(':root[data-theme="light"]') } };
  const palette = (t: Record<string, string>, light: boolean): CardPalette => ({
    light,
    ground: parseColor(t["--bg-pane"])!,
    texts: ["--text-1", "--text-3", "--text-4", "--teal-text"].map((n) => parseColor(t[n])!),
  });
  // Azure DevOps's own swatches, and the extremes
  const colours = ["#ffffff", "#000000", "#f4a3a3", "#fbe74b", "#ec001d", "#cc293d", "#009ccc", "#773b93", "#ff7b00", "#60af49", "#dddddd", "#fff2cc", "#0000ff", "#7f7f7f"];

  for (const [name, tokens] of Object.entries(themes)) {
    const p = palette(tokens, name === "light");
    it(`keeps a filled card's text at 4.5:1 and its edge at 3:1: ${name}`, () => {
      for (const colour of colours) {
        const f = cardFill(colour, p);
        const bg = parseColor(f.background)!;
        for (const t of p.texts) expect(contrast(t, bg), `${colour} → ${f.background}`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(parseColor(f.edge)!, bg), `${colour} edge ${f.edge}`).toBeGreaterThanOrEqual(3);
      }
    });

    it(`keeps a coloured tag's text at 4.5:1 on its tint: ${name}`, () => {
      for (const colour of colours) {
        const chip = chipColors(colour, p.ground, p.light);
        expect(contrast(parseColor(chip.color)!, parseColor(chip.background)!), `${colour} → ${chip.color} on ${chip.background}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  it("still shows the rule's colour, not just the plain card", () => {
    const p = palette(themes.dark, false);
    expect(cardFill("#fbe74b", p).background).not.toBe(themes.dark["--bg-pane"]);
    const chip = chipColors("#009ccc", p.ground, false);
    const [r, g, b] = parseColor(chip.color)!;
    expect(b).toBeGreaterThan(r); // still blue
    expect(g).toBeGreaterThan(r);
  });

  it("reads translucent tokens over what they sit on", () => {
    expect(parseColor("rgba(255, 255, 255, .5)", [0, 0, 0])).toEqual([127.5, 127.5, 127.5]);
    expect(parseColor("color-mix(in srgb, red 10%, blue)")).toBeNull();
  });
});
