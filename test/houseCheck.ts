import { expect } from "vitest";
import { detailOf, ticketOf, type HouseClient } from "../src/main/team/house";
import { historyWhat, HOUSE_PRIORITIES, HOUSE_STATUSES, isOpenStatus, NEEDS_AGENT, NEEDS_HUMAN, openBacklog, type HouseHistoryEntry, type HouseTicket } from "../src/shared/team/house";

/**
 * The live check's reads and assertions (test/houseLive.test.ts runs it
 * against the real House; teamHouse.test.ts against the fake one). GETs only.
 * What it logs is field names, counts and the House's enum values (statuses,
 * priorities, history events) — never titles, names, notes, branches or ids.
 */

/** How many tickets' histories are read (claimed ones first: they have the most). */
const HISTORIES = 5;

/** An answer's field names and types, nested one level (null says null). */
const shape = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.length ? [shape(v[0])] : [];
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x === null ? "null" : typeof x === "object" ? (Array.isArray(x) ? `array(${x.length})` : `{${Object.keys(x).join(", ")}}`) : typeof x]));
  return v === null ? "null" : typeof v;
};
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** The field names found under `field` on any of `items` (an object field that's null on the first item may be set on others). */
const keysUnder = (items: unknown[], field: string): string[] => [...new Set(items.flatMap((i) => (isRecord(i) && isRecord(i[field]) ? Object.keys(i[field] as object) : [])))].sort();
/** How many of each enum value. */
const counts = (values: string[]): Record<string, number> => Object.fromEntries([...values.reduce((m, v) => m.set(v, (m.get(v) ?? 0) + 1), new Map<string, number>())].sort(([a], [b]) => (a < b ? -1 : 1)));
/** A sequence's runs, e.g. "high×4, medium×10": the order the House lists in. */
const runs = (values: string[]): string =>
  values
    .reduce<[string, number][]>((out, v) => {
      if (out.length && out[out.length - 1][0] === v) out[out.length - 1][1]++;
      else out.push([v, 1]);
      return out;
    }, [])
    .map(([v, k]) => `${v}×${k}`)
    .join(", ");

export async function houseCheck(client: HouseClient, log: (line: string) => void): Promise<void> {
  const raw = await client.call("GET", "work-items");
  const list: unknown[] = Array.isArray(raw) ? raw : [];
  log(`work-items: ${list.length} items; an item's fields: ${JSON.stringify(shape(list[0]))}`);
  for (const field of ["waiting_on", "domain", "source_ref"]) log(`${field}: set on ${list.filter((i) => isRecord(i) && i[field]).length}; its fields: ${keysUnder(list, field).join(", ") || "(none set)"}`);
  const blocked = list.flatMap((i) => (isRecord(i) && Array.isArray(i.blocked_by) ? i.blocked_by : []));
  log(`blocked_by: non-empty on ${list.filter((i) => isRecord(i) && Array.isArray(i.blocked_by) && i.blocked_by.length).length}; entries are ${[...new Set(blocked.map((b) => (isRecord(b) ? `{${Object.keys(b).join(", ")}}` : typeof b)))].join(", ") || "(none)"}`);

  const tickets = list.map(ticketOf);
  expect(tickets.every(Boolean)).toBe(true);
  const ts = tickets as HouseTicket[];
  const byN = new Map(ts.map((t) => [t.n, t]));
  expect(byN.size).toBe(ts.length);

  const statuses = counts(ts.map((t) => t.status));
  const priorities = counts(ts.map((t) => t.priority ?? "(none)"));
  log(`statuses: ${JSON.stringify(statuses)}; priorities: ${JSON.stringify(priorities)}`);
  expect(Object.keys(statuses).filter((s) => !(HOUSE_STATUSES as readonly string[]).includes(s))).toEqual([]);
  expect(Object.keys(priorities).filter((p) => !(HOUSE_PRIORITIES as readonly string[]).includes(p))).toEqual([]);

  const open = openBacklog(ts.map((t) => t.n), (n) => byN.get(n));
  const openTickets = open.map((n) => byN.get(n)!);
  const tagged = (tag: string) => openTickets.filter((t) => t.tags.includes(tag)).length;
  log(`open backlog: ${open.length} of ${ts.length}; ${NEEDS_AGENT} ${tagged(NEEDS_AGENT)}, ${NEEDS_HUMAN} ${tagged(NEEDS_HUMAN)}, blocked ${openTickets.filter((t) => t.blockedBy.length).length}, waiting ${openTickets.filter((t) => t.waiting).length}`);
  log(`the open backlog's priorities in the House's order: ${runs(openTickets.map((t) => t.priority ?? "(none)"))}`);
  if (ts.some((t) => isOpenStatus(t.status))) expect(open.length).toBeGreaterThan(0);
  expect(openTickets.every((t) => isOpenStatus(t.status))).toBe(true);
  expect(ts.filter((t) => !isOpenStatus(t.status)).every((t) => !open.includes(t.n))).toBe(true);
  const claimed = ts.filter((t) => t.claim);
  log(`read as claimed: ${claimed.length}; with a branch: ${claimed.filter((t) => t.claim?.branch).length}; with a claimant: ${claimed.filter((t) => t.claim?.by).length}`);

  const sample = [...claimed, ...ts.filter((t) => !t.claim)].slice(0, HISTORIES);
  const entries: HouseHistoryEntry[] = [];
  const entryFields = new Set<string>();
  for (const [i, t] of sample.entries()) {
    const one = await client.call("GET", `work-items/${t.n}`);
    if (i === 0) log(`work-items/<n> fields: ${JSON.stringify(shape(one))}`);
    const history = isRecord(one) ? one.history : undefined;
    if (Array.isArray(history)) for (const e of history) if (isRecord(e)) Object.keys(e).forEach((k) => entryFields.add(k));
    const d = detailOf(one);
    expect(d?.n).toBe(t.n);
    expect(Array.isArray(d?.history)).toBe(true);
    entries.push(...d!.history);
  }
  log(`${entries.length} history entries over ${sample.length} tickets; an entry's fields: ${[...entryFields].sort().join(", ")}`);
  log(`events: ${JSON.stringify(counts(entries.map((e) => e.kind)))}`);
  const changes = entries.filter((e) => e.status && !e.text.trim());
  log(`with a to_status: ${entries.filter((e) => e.status).length}, of which without a note: ${changes.length}; with an actor: ${entries.filter((e) => e.by).length}; with a time: ${entries.filter((e) => e.at).length}`);
  log(`rendered: ${JSON.stringify(counts(entries.map(historyWhat)))}`);
  expect(entries.every((e) => historyWhat(e).trim().length > 0)).toBe(true);
  expect(entries.filter((e) => e.status).every((e) => (HOUSE_STATUSES as readonly string[]).includes(e.status!))).toBe(true);
  for (const e of changes) expect(historyWhat(e)).toMatch(/→ /);

  // the spec is the frozen requirements document; the board doesn't read tickets from it
  log(`spec fields: ${JSON.stringify(shape(await client.spec()))}`);
}
