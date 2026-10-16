import type { AdoCardRuleClause, AdoCardRules, AdoFillRule, AdoWorkItem } from "./types";

/**
 * Work item tags, blocked work, and a board's card styles (team settings → Cards
 * → Styles and Tag colors) as the Dashboard applies them: rules are read from
 * Azure DevOps, never written, and only the conditions that can be checked
 * exactly here are applied — a tag the card has, or a field equal to a value.
 */

/** The CMMI process's Blocked field ("Yes" / "No"); other processes don't have it. */
export const BLOCKED_FIELD = "Microsoft.VSTS.CMMI.Blocked";

/** System.Tags as Azure DevOps stores it, "a; b; c", as a list. */
export function parseTags(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const t of raw.split(";").map((s) => s.trim())) {
    if (t && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      tags.push(t);
    }
  }
  return tags;
}

/** "blocked", and tags that start with it as a word: "Blocked: waiting on QA", "blocked-by-api". Not "unblocked" or "blocker". */
export function isBlockedTag(tag: string): boolean {
  return /^blocked(?:$|[\s:\-_/(])/i.test(tag.trim());
}

/** A plain "blocked" tag, which the Blocked chip already says. */
export const isBareBlockedTag = (tag: string) => tag.trim().toLowerCase() === "blocked";

/** Why a work item counts as blocked; empty when it isn't. */
export function blockedReasons(it: AdoWorkItem, rules?: AdoCardRules | null): string[] {
  const reasons = it.tags.filter(isBlockedTag).map((t) => `tag “${t}”`);
  if ((it.fields?.[BLOCKED_FIELD] ?? "").trim().toLowerCase() === "yes") reasons.push("Blocked field is Yes");
  for (const r of rules?.fill ?? []) if (r.blocked && ruleMatches(it, r)) reasons.push(`card rule “${r.name}”`);
  return reasons;
}

// ---- reading the board's card rules ----

/** "#rgb" or "#rrggbb" as lowercase "#rrggbb"; null for anything else. */
export function hexColor(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return `#${h.toLowerCase()}`;
}

const enabled = (r: any) => r?.isEnabled === true || String(r?.isEnabled).toLowerCase() === "true";

/** One stored clause as a condition this module can check, or why it can't be. */
function parseClause(c: any, first: boolean): AdoCardRuleClause | string {
  const field = String(c?.fieldName ?? "").trim();
  const operator = String(c?.operator ?? "").trim();
  const value = String(c?.value ?? "").trim();
  const join = String(c?.logicalOperator ?? "").trim().toLowerCase();
  if (!field) return "a condition has no field";
  const logic = first || join === "" || join === "and" ? "and" : join === "or" ? "or" : null;
  if (!logic) return `joins conditions with “${c.logicalOperator}”`;
  if (value.startsWith("@")) return `${field} compares to ${value}, a macro`;
  const op = operator.toLowerCase();
  if (field === "System.Tags") {
    if (op === "contains") return { field, op: "contains", value, logic };
  } else if (op === "=") return { field, op: "=", value, logic };
  return `${field} ${operator || "(no operator)"} isn't a condition Mockingbird checks (only tags contain, and field =)`;
}

/** A rule that marks blocked work: named for it, or testing a blocked tag or the Blocked field. */
function marksBlocked(name: string, clauses: AdoCardRuleClause[]): boolean {
  return (
    /\bblock(ed)?\b/i.test(name) ||
    clauses.some((c) => (c.field === "System.Tags" && isBlockedTag(c.value)) || (c.field === BLOCKED_FIELD && c.value.toLowerCase() === "yes"))
  );
}

/**
 * The cardrulesettings answer (`rules.fill`, `rules.tagStyle`) as the rules the
 * Dashboard applies, in the board's order. Disabled rules are dropped; a rule
 * with any condition that can't be checked exactly is left out whole, and
 * `ignored` says which and why.
 */
export function parseCardRules(raw: any): AdoCardRules {
  const out: AdoCardRules = { fill: [], tags: [], ignored: [] };
  for (const r of raw?.rules?.fill ?? []) {
    if (!enabled(r)) continue;
    const name = String(r.name ?? "").trim() || "unnamed rule";
    const background = hexColor(r.settings?.["background-color"]);
    const stored: any[] = [...(r.clauses ?? [])].sort((a, b) => (Number(a?.index) || 0) - (Number(b?.index) || 0));
    const clauses: AdoCardRuleClause[] = [];
    let why = !background ? "no fill colour" : !stored.length ? "no conditions" : "";
    for (const [i, c] of stored.entries()) {
      if (why) break;
      const p = parseClause(c, i === 0);
      if (typeof p === "string") why = p;
      else clauses.push(p);
    }
    if (why) out.ignored.push(`“${name}”: ${why}`);
    else out.fill.push({ name, clauses, background: background!, blocked: marksBlocked(name, clauses) });
  }
  for (const t of raw?.rules?.tagStyle ?? []) {
    if (!enabled(t)) continue;
    const background = hexColor(t.settings?.["background-color"]);
    const tag = String(t.name ?? "").trim();
    if (tag && background) out.tags.push({ tag, background });
    else out.ignored.push(`tag colour “${tag || "unnamed"}”: no tag or colour`);
  }
  return out;
}

/** The fields a board's rules read, so they're fetched with the work items. */
export function ruleFields(rules: AdoCardRules): string[] {
  return [...new Set(rules.fill.flatMap((r) => r.clauses.map((c) => c.field)))];
}

// ---- applying them ----

/** Fields a work item carries as its own properties, so `fields` needn't repeat them. */
export const ITEM_PROP_FIELDS = new Set(["System.Tags", "System.State", "System.WorkItemType", "System.Title", "System.BoardColumn"]);

/** A field's value on the card, by reference name; undefined when it wasn't loaded. */
function fieldValue(it: AdoWorkItem, ref: string): string | string[] | undefined {
  switch (ref) {
    case "System.Tags":
      return it.tags;
    case "System.State":
      return it.state;
    case "System.WorkItemType":
      return it.type;
    case "System.Title":
      return it.title;
    case "System.BoardColumn":
      return it.boardColumn ?? "";
    default:
      return it.fields?.[ref];
  }
}

/** WIQL's "=": case-insensitive; numbers by value; a person by name, email, or "Name <email>". */
function equalsValue(actual: string, expected: string): boolean {
  const a = actual.trim().toLowerCase();
  const e = expected.trim().toLowerCase();
  if (a === e) return true;
  if (a && e && Number.isFinite(Number(a)) && Number.isFinite(Number(e))) return Number(a) === Number(e);
  const person = a.match(/^(.*) <(.*)>$/);
  return !!person && (person[1] === e || person[2] === e);
}

function clauseHolds(it: AdoWorkItem, c: AdoCardRuleClause): boolean {
  const v = fieldValue(it, c.field);
  if (v === undefined) return false;
  if (c.op === "contains") return Array.isArray(v) && v.some((t) => t.toLowerCase() === c.value.toLowerCase());
  return equalsValue(Array.isArray(v) ? v.join("; ") : v, c.value);
}

/** Whether a rule styles this card: its conditions, AND before OR as in WIQL. */
export function ruleMatches(it: AdoWorkItem, rule: AdoFillRule): boolean {
  const groups: AdoCardRuleClause[][] = [];
  for (const [i, c] of rule.clauses.entries()) {
    if (i === 0 || c.logic === "or") groups.push([]);
    groups[groups.length - 1].push(c);
  }
  return groups.some((g) => g.every((c) => clauseHolds(it, c)));
}

/** The rule that fills this card: the first that matches, as on the board itself. */
export function fillRuleFor(it: AdoWorkItem, rules: AdoCardRules): AdoFillRule | null {
  return rules.fill.find((r) => ruleMatches(it, r)) ?? null;
}

/** The colour the board gives a tag, if any. */
export function tagColor(tag: string, rules: AdoCardRules): string | null {
  return rules.tags.find((t) => t.tag.toLowerCase() === tag.toLowerCase())?.background ?? null;
}

// ---- Azure DevOps colours, made legible in Mockingbird's themes ----

type RGB = [number, number, number];

/** "#rrggbb", or "rgb(a)(…)" laid over `under` when translucent; null when it can't be read. */
export function parseColor(v: string, under?: RGB): RGB | null {
  const hex = hexColor(v);
  if (hex) return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as RGB;
  const m = v.trim().match(/^rgba?\(([^)]+)\)$/);
  if (!m) return null;
  const [r, g, b, a = 1] = m[1].split(",").map(Number);
  if (![r, g, b, a].every(Number.isFinite)) return null;
  return a >= 1 || !under ? [r, g, b] : mix([r, g, b], under, a);
}

const toHex = (c: RGB) => "#" + c.map((x) => Math.round(Math.min(255, Math.max(0, x))).toString(16).padStart(2, "0")).join("");
/** `t` of `top` over `under`. */
const mix = (top: RGB, under: RGB, t: number): RGB => [0, 1, 2].map((i) => top[i] * t + under[i] * (1 - t)) as RGB;
/** As it will be drawn: whole channels, so contrast is checked on the colour the page gets. */
const whole = (c: RGB): RGB => c.map((x) => Math.round(Math.min(255, Math.max(0, x)))) as RGB;

function luminance([r, g, b]: RGB): number {
  const lin = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
/** WCAG contrast ratio. */
export function contrast(a: RGB, b: RGB): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The theme's colours a card is drawn with. */
export interface CardPalette {
  light: boolean;
  ground: RGB; // a card's own background
  texts: RGB[]; // every text colour drawn on a card
}

/** `hue`, lightened (dark theme) or darkened (light theme) until it reaches `min` on `bg`. */
function inkOn(hue: RGB, bg: RGB, light: boolean, min: number): RGB {
  let c = whole(hue);
  for (let i = 0; i < 40 && contrast(c, bg) < min; i++) c = whole(mix(light ? [0, 0, 0] : [255, 255, 255], c, 0.08));
  return contrast(c, bg) >= min ? c : light ? [0, 0, 0] : [255, 255, 255];
}

/**
 * A fill rule's card: its colour washed into the card's background as strongly
 * as every text colour on the card allows at 4.5:1, and an edge in its hue at
 * 3:1 so the colour still shows when the wash has to stay faint.
 */
export function cardFill(color: string, p: CardPalette): { background: string; edge: string } {
  const c = parseColor(color) ?? p.ground;
  let bg = p.ground;
  for (let t = 0.2; t > 0; t -= 0.02) {
    const tried = whole(mix(c, p.ground, t));
    if (p.texts.every((x) => contrast(x, tried) >= 4.5)) {
      bg = tried;
      break;
    }
  }
  return { background: toHex(bg), edge: toHex(inkOn(c, bg, p.light, 3)) };
}

/** A tag chip in its board colour: a tint of it on the card, with text in the same hue at 4.5:1. */
export function chipColors(color: string, ground: RGB, light: boolean): { background: string; color: string } {
  const c = parseColor(color) ?? ground;
  const bg = whole(mix(c, ground, light ? 0.2 : 0.22));
  return { background: toHex(bg), color: toHex(inkOn(c, bg, light, 4.5)) };
}
