import * as fs from "fs";
import * as http from "http";
import * as https from "https";
import * as path from "path";
import type { AddressInfo } from "net";
import { tempDir } from "./helpers";

/**
 * A stand-in for the Radley House's external API on this Mac, for tests:
 * nothing here reaches the real House. It keeps a project's work items and
 * frozen spec, answers the routes Mockingbird calls the way the House's docs
 * and CLI describe them, and records every request with the token it carried.
 * Builders are known by token; another token is a 401.
 *
 * Its answers have the real House's fields (as the live check read them):
 * work items with id, number, assignee + branch, blocked_by, waiting_on…,
 * listed priority-sorted high to low with closed ones included; history
 * entries of { at, actor, event, note?, to_status? }, a status change being
 * its own entry with a to_status and no note; and a spec that is the frozen
 * requirements document, not a ticket list.
 */

export interface FakeHistoryEntry {
  at: string;
  actor: string;
  event: string;
  note?: string;
  to_status?: string;
  reference?: string;
}

export interface FakeItem {
  id: string;
  number: number;
  project_id: string;
  title: string;
  detail: string;
  acceptance: string;
  kind: string;
  status: string;
  priority: string;
  domain: Record<string, unknown> | null;
  tags: string[];
  blocked_by: number[];
  waiting_on: Record<string, unknown> | null;
  assignee: string | null;
  branch: string | null;
  source_ref: Record<string, unknown> | null;
  history: FakeHistoryEntry[];
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** The order GET work-items lists in: priority, high to low; then by number. */
const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2, investigate: 3 };
const houseOrder = (a: FakeItem, b: FakeItem) => (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9) || a.number - b.number;

export interface FakeRequest {
  method: string;
  path: string;
  token: string | null;
  body: any;
}

export const PROJECT_ID = "c0ffee00-1111-2222-3333-444455556666";

/** `tls`: serve https with this key and certificate (the app itself only talks https). */
export async function fakeHouse(builders: Record<string, string>, o: { tls?: { key: string; cert: string } } = {}) {
  const items = new Map<number, FakeItem>();
  const requests: FakeRequest[] = [];
  const state = {
    next: 100,
    spec: { project_id: PROJECT_ID, spec_version_id: "v3", title: "Org memory", frozen_at: "2026-10-01T09:00:00Z", sections: [{ title: "Org memory", requirements: [{ id: "R1", number: 7, title: "Remember the org" }] }] } as any,
    /** Answer every request this much later (timeouts). */
    delayMs: 0,
    /** Put the caller's token in error messages, as a careless server might. */
    echoToken: false,
    /** Refuse a status change a builder asks for (an event with a status), with this message; null lets it through. */
    refuseStatus: null as ((it: FakeItem, to: string, builder: string) => string | null) | null,
  };
  const at = () => new Date().toISOString();
  const item = (n: number, over: Partial<FakeItem> = {}): FakeItem => {
    const it: FakeItem = {
      id: `wi-${n}-0000-0000`,
      number: n,
      project_id: PROJECT_ID,
      title: `Ticket ${n}`,
      detail: "",
      acceptance: "",
      kind: "engineering",
      status: "parked",
      priority: "medium",
      domain: null,
      tags: [],
      blocked_by: [],
      waiting_on: null,
      assignee: null,
      branch: null,
      source_ref: null,
      history: [],
      created_by: "staff",
      created_at: at(),
      updated_at: at(),
      ...over,
    };
    items.set(n, it);
    state.next = Math.max(state.next, n + 1);
    return it;
  };
  /** A history entry; a status that changes is an entry of its own, with no note. */
  const record = (it: FakeItem, actor: string, event: string, o: { note?: string; reference?: string; status?: string } = {}) => {
    if (event !== "status_changed") it.history.push({ at: at(), actor, event, ...(o.note ? { note: o.note } : {}), ...(o.reference ? { reference: o.reference } : {}) });
    if (o.status && o.status !== it.status) {
      it.status = o.status;
      it.history.push({ at: at(), actor, event: "status_changed", to_status: o.status });
    }
    it.updated_at = at();
  };

  const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const token = (req.headers["x-build-token"] as string | undefined) ?? null;
      const url = new URL(req.url ?? "/", "http://fake");
      let body: any = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      requests.push({ method: req.method ?? "", path: url.pathname + url.search, token, body });
      const send = (status: number, payload: unknown) =>
        setTimeout(() => {
          if (res.destroyed) return;
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(payload));
        }, state.delayMs);
      const fail = (status: number, error: string) => send(status, { error: state.echoToken ? `${error} (token ${token})` : error });
      if (url.pathname === "/redirect") {
        res.writeHead(302, { Location: String(url.searchParams.get("to")) });
        return res.end();
      }
      const builder = token ? builders[token] : undefined;
      if (!builder) return fail(401, "Invalid build token");
      const base = `/api/projects/${PROJECT_ID}/external/`;
      if (!url.pathname.startsWith(base)) return fail(404, "Not found");
      const parts = url.pathname.slice(base.length).split("/");
      const method = req.method;
      if (parts[0] === "spec" && method === "GET") return send(200, state.spec);
      if (parts[0] !== "work-items") return fail(404, "Not found");
      if (parts.length === 1) {
        if (method === "GET") {
          const tag = url.searchParams.get("tag");
          return send(200, [...items.values()].filter((i) => !tag || i.tags.includes(tag)).sort(houseOrder));
        }
        if (method === "POST") {
          if (!body?.title) return fail(422, "title is required");
          const it = item(state.next, { title: body.title, detail: body.detail ?? "", acceptance: body.acceptance ?? "", kind: body.kind ?? "engineering", priority: body.priority ?? "medium", created_by: builder });
          it.history.push({ at: at(), actor: builder, event: "created", to_status: "parked" });
          return send(201, it);
        }
      }
      const n = Number(parts[1]);
      const it = items.get(n);
      if (!it) return fail(404, `No work item #${parts[1]} in this project`);
      if (parts.length === 2) {
        if (method === "GET") return send(200, it);
        if (method === "PATCH") {
          if (Array.isArray(body?.tags)) {
            if (body.tags.includes("needs-human") && body.tags.includes("needs-agent")) return fail(422, "A work item can't carry both needs-human and needs-agent");
            it.tags = body.tags;
          }
          for (const k of ["title", "detail", "acceptance", "priority"] as const) if (typeof body?.[k] === "string") it[k] = body[k];
          if (typeof body?.note === "string") record(it, builder, "comment", { note: body.note });
          return send(200, it);
        }
      }
      if (parts.length === 3 && method === "POST") {
        if (parts[2] === "claim") {
          if (it.assignee && it.assignee !== builder) return fail(409, `Already claimed by ${it.assignee}`);
          it.assignee = builder;
          it.branch = body?.branch ?? null;
          it.status = "in_progress";
          it.history.push({ at: at(), actor: builder, event: "claimed", to_status: "in_progress" });
          return send(200, it);
        }
        if (parts[2] === "release") {
          if (it.assignee !== builder) return fail(403, "Only the claimant releases a claim");
          it.assignee = null;
          it.branch = null;
          record(it, builder, "released", { status: "ready" });
          return send(200, it);
        }
        if (parts[2] === "events") {
          if (!["progress", "question"].includes(body?.event)) return fail(422, `Unknown event ${body?.event}`);
          if (body.status && ["done", "dropped"].includes(body.status)) return fail(403, "Only staff close a work item");
          if (body.status && !["parked", "ready", "in_progress", "review", "validating"].includes(body.status)) return fail(422, `Unknown status ${body.status}`);
          const refused = body.status ? state.refuseStatus?.(it, body.status, builder) : null;
          if (refused) return fail(409, refused);
          record(it, builder, body.event, { note: body.note, reference: body.reference, status: body.status });
          return send(201, it);
        }
      }
      return fail(405, "Method not allowed");
    });
  };
  const server = o.tls ? https.createServer(o.tls, handler) : http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `${o.tls ? "https" : "http"}://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    items,
    requests,
    state,
    item,
    /** Requests made with `token`, as "METHOD path". */
    by: (token: string) => requests.filter((r) => r.token === token).map((r) => `${r.method} ${r.path.replace(`/api/projects/${PROJECT_ID}/external/`, "")}`),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export type FakeHouse = Awaited<ReturnType<typeof fakeHouse>>;

/** A builder's home with their env file for `project` (mode 600), as the House's setup page tells them to keep it. */
export function builderHome(project: string, house: { url: string }, token: string, extra = "", home = tempDir("home")): string {
  const dir = path.join(home, ".config", "radley-house");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${project}.env`);
  fs.writeFileSync(file, `# minted in the House\nHOUSE_API_URL=${house.url}\nHOUSE_PROJECT_ID=${PROJECT_ID}\nHOUSE_BUILD_TOKEN=${token}\n${extra}`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return home;
}
