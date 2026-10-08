import { defineEventType } from "./rooms";
import type { Team } from "./transport";
import { hasCredentials, publicUrl } from "../git";
import { MEMBER_ID_RE } from "../../shared/team/protocol";
import {
  emptyPlan,
  LIMITS,
  MAX_CHANGES,
  newPackageId,
  normalizeOwnedPath,
  PACKAGE_ID_RE,
  PACKAGE_STATUSES,
  type MemberBranches,
  type PackageFields,
  type PackageStatus,
  type PlanChange,
  type PlanOp,
  type PlanState,
  type WorkPackage,
} from "../../shared/team/plan";
import type { MemberId, RoomEvent, RoomId, RoomState } from "../../shared/team/types";

/**
 * The plan board's room events: their checks (an event that fails one is
 * refused, from anyone) and their reducers into `room.ext.plan`. Importing
 * this module registers them, so it must load before any room log does
 * (index.ts imports it ahead of starting the team service).
 *
 * Concurrent changes settle by the room log's total order: the later event's
 * fields win, field by field. A change to a removed package is ignored.
 */

function fail(why: string): never {
  throw new Error(why);
}
const isObj = (b: unknown): b is Record<string, unknown> => !!b && typeof b === "object" && !Array.isArray(b);
const text = (v: unknown, what: string, max: number, min = 0) => {
  if (typeof v !== "string" || v.length > max || v.trim().length < min) fail(`${what} must be text of ${min}–${max} characters`);
};
/** An origin URL as every member keeps it in the log: never with a user name or token in it. */
const originText = (v: unknown) => {
  text(v, "origin", LIMITS.origin, 1);
  if (hasCredentials(v as string)) fail("origin must not carry credentials");
};
const optText = (b: Record<string, unknown>, key: string, max: number, min = 0) => {
  if (b[key] !== undefined) text(b[key], key, max, min);
};
const pkgId = (v: unknown) => {
  if (typeof v !== "string" || !PACKAGE_ID_RE.test(v)) fail("bad package id");
};

/** An owned path a package may name: repo-relative, inside the repo. */
export function ownedPathProblem(p: unknown): string | null {
  if (typeof p !== "string") return "an owned path must be text";
  if (p.length > LIMITS.path) return `an owned path is longer than ${LIMITS.path} characters`;
  const n = normalizeOwnedPath(p);
  if (!n) return "an owned path is empty";
  if (n.split("/").includes("..")) return `${p} leaves the repository`;
  if (/[\0\n\r]/.test(p)) return `${JSON.stringify(p)} has a control character`;
  return null;
}

const paths = (v: unknown) => {
  if (!Array.isArray(v) || v.length > LIMITS.paths) fail(`paths must be a list of at most ${LIMITS.paths}`);
  for (const p of v as unknown[]) {
    const problem = ownedPathProblem(p);
    if (problem) fail(problem);
  }
};

const BRANCH_RE = /^(?!-)(?!.*\.\.)(?!.*\/\/)[^\s~^:?*[\\\0]+$/;

function fieldsCheck(b: Record<string, unknown>): void {
  optText(b, "title", LIMITS.title, 1);
  optText(b, "description", LIMITS.description);
  optText(b, "provides", LIMITS.contract);
  optText(b, "uses", LIMITS.contract);
  optText(b, "tests", LIMITS.contract);
  if (b.paths !== undefined) paths(b.paths);
  optText(b, "via", LIMITS.via);
}

const FIELDS = ["title", "description", "paths", "provides", "uses", "tests"] as const;

const planOf = (state: RoomState): PlanState => (state.ext.plan ??= emptyPlan());

function note(plan: PlanState, e: RoomEvent, change: Omit<PlanChange, "at" | "by">): void {
  const via = (e.body as { via?: string }).via;
  plan.changes.push({ at: e.at, by: e.author, ...(via ? { via } : {}), ...change });
  if (plan.changes.length > MAX_CHANGES) plan.changes.splice(0, plan.changes.length - MAX_CHANGES);
  plan.updatedAt = Math.max(plan.updatedAt, e.at);
}

const findPkg = (plan: PlanState, id: string) => plan.packages.find((p) => p.id === id);
const isMember = (state: RoomState, id: MemberId) => state.members.some((m) => m.id === id);
const cleanPaths = (list: string[]) => [...new Set(list.map(normalizeOwnedPath).filter(Boolean))];
const touch = (p: WorkPackage, e: RoomEvent) => {
  p.updatedBy = e.author;
  p.updatedAt = e.at;
};

defineEventType("plan.package", {
  validate(b) {
    if (!isObj(b)) fail("no body");
    pkgId(b.id);
    fieldsCheck(b);
  },
  reduce(state, e) {
    const plan = planOf(state);
    const b = e.body;
    if (plan.removed.includes(b.id)) return;
    const existing = findPkg(plan, b.id);
    if (!existing) {
      if (!b.title?.trim()) return; // an edit of a package this log never saw created
      const p: WorkPackage = {
        id: b.id,
        title: b.title.trim(),
        description: b.description ?? "",
        owner: null,
        status: "open",
        statusNote: "",
        paths: cleanPaths(b.paths ?? []),
        provides: b.provides ?? "",
        uses: b.uses ?? "",
        tests: b.tests ?? "",
        createdBy: e.author,
        createdAt: e.at,
        updatedBy: e.author,
        updatedAt: e.at,
      };
      plan.packages.push(p);
      note(plan, e, { kind: "created", pkg: p.id, title: p.title });
      return;
    }
    const changed: string[] = [];
    for (const f of FIELDS) {
      const v = b[f];
      if (v === undefined) continue;
      if (f === "paths") {
        const next = cleanPaths(v as string[]);
        if (JSON.stringify(next) !== JSON.stringify(existing.paths)) {
          existing.paths = next;
          changed.push(f);
        }
      } else if (f === "title") {
        if ((v as string).trim() && (v as string).trim() !== existing.title) {
          existing.title = (v as string).trim();
          changed.push(f);
        }
      } else if (v !== existing[f]) {
        existing[f] = v as string;
        changed.push(f);
      }
    }
    if (!changed.length) return;
    touch(existing, e);
    note(plan, e, { kind: "edited", pkg: existing.id, title: existing.title, fields: changed });
  },
});

defineEventType("plan.claim", {
  validate(b) {
    if (!isObj(b)) fail("no body");
    pkgId(b.id);
    if (b.owner !== null && (typeof b.owner !== "string" || !MEMBER_ID_RE.test(b.owner))) fail("bad owner");
    optText(b, "via", LIMITS.via);
  },
  reduce(state, e) {
    const plan = planOf(state);
    const p = findPkg(plan, e.body.id);
    if (!p) return;
    const owner = e.body.owner;
    if (owner && !isMember(state, owner)) return;
    if (owner === p.owner) return;
    p.owner = owner;
    if (owner && p.status === "open") p.status = "claimed";
    if (!owner && (p.status === "claimed" || p.status === "in-progress" || p.status === "blocked")) {
      p.status = "open";
      p.statusNote = "";
    }
    touch(p, e);
    note(plan, e, owner ? { kind: "claimed", pkg: p.id, title: p.title, ...(owner !== e.author ? { owner } : {}) } : { kind: "released", pkg: p.id, title: p.title });
  },
});

defineEventType("plan.status", {
  validate(b) {
    if (!isObj(b)) fail("no body");
    pkgId(b.id);
    if (!PACKAGE_STATUSES.includes(b.status as never)) fail("bad status");
    optText(b, "note", LIMITS.note);
    optText(b, "via", LIMITS.via);
  },
  reduce(state, e) {
    const plan = planOf(state);
    const p = findPkg(plan, e.body.id);
    if (!p) return;
    const { status } = e.body;
    const statusNote = e.body.note?.trim() ?? "";
    if (status === p.status && statusNote === p.statusNote) return;
    p.status = status;
    p.statusNote = statusNote;
    if (status === "open") p.owner = null;
    else if (!p.owner) p.owner = e.author; // in progress, blocked or done: somebody has it
    touch(p, e);
    note(plan, e, { kind: "status", pkg: p.id, title: p.title, status, ...(statusNote ? { note: statusNote } : {}) });
  },
});

defineEventType("plan.remove", {
  validate(b) {
    if (!isObj(b)) fail("no body");
    pkgId(b.id);
    optText(b, "via", LIMITS.via);
  },
  reduce(state, e) {
    const plan = planOf(state);
    const i = plan.packages.findIndex((p) => p.id === e.body.id);
    if (!plan.removed.includes(e.body.id)) plan.removed.push(e.body.id);
    if (i < 0) return;
    const [p] = plan.packages.splice(i, 1);
    note(plan, e, { kind: "removed", pkg: p.id, title: p.title });
  },
});

defineEventType("plan.repo", {
  validate(b) {
    if (!isObj(b)) fail("no body");
    originText(b.origin);
    text(b.name, "name", LIMITS.title, 1);
  },
  reduce(state, e) {
    const plan = planOf(state);
    if (plan.repo?.origin === e.body.origin && plan.repo.name === e.body.name) return;
    plan.repo = { origin: e.body.origin, name: e.body.name };
    note(plan, e, { kind: "repo", repo: e.body.name });
  },
});

defineEventType("plan.branches", {
  validate(b) {
    if (!isObj(b)) fail("no body");
    originText(b.origin);
    if (!Array.isArray(b.branches) || b.branches.length > LIMITS.branches) fail(`branches must be a list of at most ${LIMITS.branches}`);
    for (const n of b.branches as unknown[]) if (typeof n !== "string" || n.length > LIMITS.branch || !BRANCH_RE.test(n)) fail(`bad branch name ${JSON.stringify(n)}`);
  },
  reduce(state, e) {
    const all = (state.ext.memberBranches ??= {});
    all[e.author] = { origin: e.body.origin, branches: [...new Set(e.body.branches)].sort(), at: e.at } satisfies MemberBranches;
  },
});

// ---- operations --------------------------------------------------------------------------------

/** The board of a room this install is in (empty before its first change). */
export function planOfRoom(room: RoomState): PlanState {
  return room.ext.plan ?? emptyPlan();
}

function fieldsOf(op: PackageFields): PackageFields {
  const out: PackageFields = {};
  if (op.title !== undefined) out.title = String(op.title).trim();
  if (op.description !== undefined) out.description = String(op.description);
  if (op.provides !== undefined) out.provides = String(op.provides);
  if (op.uses !== undefined) out.uses = String(op.uses);
  if (op.tests !== undefined) out.tests = String(op.tests);
  if (op.paths !== undefined) {
    if (!Array.isArray(op.paths)) throw new Error("paths must be a list of folders, files or globs");
    for (const p of op.paths) {
      const problem = ownedPathProblem(p);
      if (problem) throw new Error(problem);
    }
    out.paths = [...new Set(op.paths.map(normalizeOwnedPath))];
  }
  return out;
}

/**
 * Make one board change in a room, as this install's member: checked against
 * the board as it is here, then published (and so replicated). `via` names the
 * agent session that asked, when one did. Throws a message fit for the user or
 * the agent when the change can't be made.
 */
export function applyPlanOp(team: Team, roomId: RoomId, op: PlanOp, via?: string): { event: RoomEvent; pkg: string | null } {
  const room = team.room(roomId);
  if (!room) throw new Error(`Not a member of room ${roomId}`);
  const plan = planOfRoom(room);
  const v = via ? { via: via.slice(0, LIMITS.via) } : {};
  const need = (id: unknown): WorkPackage => {
    const p = typeof id === "string" ? findPkg(plan, id) : undefined;
    if (!p) throw new Error(`There's no package ${String(id)} on the board — read .mockingbird/plan.md for the ids`);
    return p;
  };
  switch (op.kind) {
    case "create": {
      const fields = fieldsOf(op);
      if (!fields.title) throw new Error("A package needs a title");
      const id = newPackageId();
      return { event: team.publish(roomId, "plan.package", { id, description: "", paths: [], provides: "", uses: "", tests: "", ...fields, title: fields.title, ...v }), pkg: id };
    }
    case "edit": {
      const p = need(op.id);
      const fields = fieldsOf(op);
      if (fields.title !== undefined && !fields.title) throw new Error("A package's title can't be empty");
      if (!Object.keys(fields).length) throw new Error("Nothing to change: give the fields to edit");
      return { event: team.publish(roomId, "plan.package", { id: p.id, ...fields, ...v }), pkg: p.id };
    }
    case "claim": {
      const p = need(op.id);
      const owner = op.owner ?? team.self.id;
      if (!room.members.some((m) => m.id === owner)) throw new Error(`${owner} isn't a member of ${room.name}`);
      return { event: team.publish(roomId, "plan.claim", { id: p.id, owner, ...v }), pkg: p.id };
    }
    case "release":
      return { event: team.publish(roomId, "plan.claim", { id: need(op.id).id, owner: null, ...v }), pkg: op.id };
    case "status": {
      const p = need(op.id);
      if (!PACKAGE_STATUSES.includes(op.status)) throw new Error(`A status is one of ${PACKAGE_STATUSES.join(", ")}`);
      const noteText = op.note?.trim();
      return { event: team.publish(roomId, "plan.status", { id: p.id, status: op.status, ...(noteText ? { note: noteText.slice(0, LIMITS.note) } : {}), ...v }), pkg: p.id };
    }
    case "remove":
      return { event: team.publish(roomId, "plan.remove", { id: need(op.id).id, ...v }), pkg: op.id };
    case "repo": {
      const origin = publicUrl(String(op.origin ?? ""));
      const name = String(op.name ?? "").trim();
      if (!origin || !name) throw new Error("Choose a repository with an origin remote");
      return { event: team.publish(roomId, "plan.repo", { origin, name }), pkg: null };
    }
    default:
      throw new Error(`Unknown plan change ${(op as { kind?: unknown }).kind}`);
  }
}

const str = (v: unknown, what: string): string | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new Error(`${what} must be text`);
  return v;
};

/** The agents' tool arguments as a board change. */
export function opFromTool(args: Record<string, unknown>): PlanOp {
  const action = String(args?.action ?? "");
  const id = str(args.id, "id");
  const fields = {
    ...(args.title !== undefined ? { title: str(args.title, "title") } : {}),
    ...(args.description !== undefined ? { description: str(args.description, "description") } : {}),
    ...(args.provides !== undefined ? { provides: str(args.provides, "provides") } : {}),
    ...(args.uses !== undefined ? { uses: str(args.uses, "uses") } : {}),
    ...(args.tests !== undefined ? { tests: str(args.tests, "tests") } : {}),
    ...(args.paths !== undefined ? { paths: Array.isArray(args.paths) ? args.paths.map((p) => String(p)) : (() => { throw new Error("paths must be a list of folders, files or globs"); })() } : {}),
  };
  const needId = () => {
    if (!id) throw new Error(`${action} needs the package id (p-…) from .mockingbird/plan.md`);
    return id;
  };
  switch (action) {
    case "claim":
      return { kind: "claim", id: needId() };
    case "release":
      return { kind: "release", id: needId() };
    case "status":
      return { kind: "status", id: needId(), status: String(args.status ?? "") as PackageStatus, ...(args.note !== undefined ? { note: str(args.note, "note") } : {}) };
    case "create":
      if (!fields.title?.trim()) throw new Error("create needs a title");
      return { kind: "create", ...fields, title: fields.title };
    case "edit":
      return { kind: "edit", id: needId(), ...fields };
    default:
      throw new Error("action is one of claim, release, status, create, edit");
  }
}
