import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import type { AddressInfo } from "net";
import { tempDir } from "./helpers";

/**
 * A stand-in for the Radley House's external API on this Mac, for tests:
 * nothing here reaches the real House. It keeps a project's work items and
 * frozen spec, answers the routes Mockingbird calls the way the House's docs
 * and CLI describe them, and records every request with the token it carried.
 * Builders are known by token; another token is a 401.
 */

export interface FakeItem {
  number: number;
  title: string;
  status: string;
  priority: string;
  kind: string;
  tags: string[];
  detail: string;
  acceptance: string;
  claimed_by: string | null;
  branch: string | null;
  history: { event: string; note: string; by: string; at: string; status?: string; reference?: string }[];
}

export interface FakeRequest {
  method: string;
  path: string;
  token: string | null;
  body: any;
}

export const PROJECT_ID = "c0ffee00-1111-2222-3333-444455556666";

export async function fakeHouse(builders: Record<string, string>) {
  const items = new Map<number, FakeItem>();
  const requests: FakeRequest[] = [];
  const state = {
    next: 100,
    spec: { slice: { name: "Slice 3 — org memory", work_items: [] as number[] }, sections: [{ title: "Org memory", requirements: [{ id: "R1", number: 7, title: "Remember the org" }] }] } as any,
    /** Answer every request this much later (timeouts). */
    delayMs: 0,
    /** Put the caller's token in error messages, as a careless server might. */
    echoToken: false,
  };
  const at = () => new Date().toISOString();
  const item = (n: number, over: Partial<FakeItem> = {}): FakeItem => {
    const it: FakeItem = { number: n, title: `Ticket ${n}`, status: "parked", priority: "medium", kind: "engineering", tags: [], detail: "", acceptance: "", claimed_by: null, branch: null, history: [], ...over };
    items.set(n, it);
    state.next = Math.max(state.next, n + 1);
    return it;
  };

  const server = http.createServer((req, res) => {
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
          return send(200, [...items.values()].filter((i) => !tag || i.tags.includes(tag)).map(({ history: _h, ...rest }) => rest));
        }
        if (method === "POST") {
          if (!body?.title) return fail(422, "title is required");
          const it = item(state.next, { title: body.title, detail: body.detail ?? "", acceptance: body.acceptance ?? "", kind: body.kind ?? "engineering", priority: body.priority ?? "medium" });
          it.history.push({ event: "created", note: "", by: builder, at: at() });
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
          if (typeof body?.note === "string") it.history.push({ event: "comment", note: body.note, by: builder, at: at() });
          return send(200, it);
        }
      }
      if (parts.length === 3 && method === "POST") {
        if (parts[2] === "claim") {
          if (it.claimed_by && it.claimed_by !== builder) return fail(409, `Already claimed by ${it.claimed_by}`);
          it.claimed_by = builder;
          it.branch = body?.branch ?? null;
          it.status = "in_progress";
          it.history.push({ event: "claim", note: `Claimed${it.branch ? ` on ${it.branch}` : ""}`, by: builder, at: at(), status: "in_progress" });
          return send(200, it);
        }
        if (parts[2] === "release") {
          if (it.claimed_by !== builder) return fail(403, "Only the claimant releases a claim");
          it.claimed_by = null;
          it.branch = null;
          it.status = "ready";
          it.history.push({ event: "release", note: "", by: builder, at: at() });
          return send(200, it);
        }
        if (parts[2] === "events") {
          if (!["progress", "question"].includes(body?.event)) return fail(422, `Unknown event ${body?.event}`);
          if (body.status && ["done", "dropped"].includes(body.status)) return fail(403, "Only staff close a work item");
          if (body.status) it.status = body.status;
          it.history.push({ event: body.event, note: body.note, by: builder, at: at(), ...(body.status ? { status: body.status } : {}), ...(body.reference ? { reference: body.reference } : {}) });
          return send(201, it);
        }
      }
      return fail(405, "Method not allowed");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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
export function builderHome(project: string, house: { url: string }, token: string, extra = ""): string {
  const home = tempDir("home");
  const dir = path.join(home, ".config", "radley-house");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${project}.env`);
  fs.writeFileSync(file, `# minted in the House\nHOUSE_API_URL=${house.url}\nHOUSE_PROJECT_ID=${PROJECT_ID}\nHOUSE_BUILD_TOKEN=${token}\n${extra}`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return home;
}
