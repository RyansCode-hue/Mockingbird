import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { git } from "./git";
import { MB_DIR } from "./store";
import type { RunDebug, RunPort, RunProfile, RunService } from "../shared/types";

/**
 * How a repository's services run: kept by Mockingbird per main checkout (not
 * in the repo), so every worktree of the repo shares it and nothing is committed.
 */
export const RUN_DIR = path.join(MB_DIR, "run");
export const DEFAULT_SIDE_BY_SIDE = { slots: 3, step: 10 };

/** The main checkout a folder belongs to — itself, or the repository a worktree was made from. */
export async function mainCheckout(cwd: string): Promise<string> {
  const common = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return path.basename(common) === ".git" ? path.dirname(common) : common;
}

/** A short id of a main checkout's path: repos that share a folder name get different ones. */
export const repoHash = (repo: string) => crypto.createHash("sha1").update(repo).digest("hex").slice(0, 8);

export function profilePath(repo: string): string {
  return path.join(RUN_DIR, `${path.basename(repo).replace(/[^\w.-]/g, "_")}-${repoHash(repo)}.json`);
}

const isObj = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x);
const strMap = (x: unknown) => isObj(x) && Object.values(x).every((v) => typeof v === "string");
const strList = (x: unknown) => Array.isArray(x) && x.every((v) => typeof v === "string");

/**
 * A profile as written (by hand or drafted by a model), checked field by field;
 * the first problem is reported with where it is.
 */
export function validateProfile(x: unknown, repo: string): RunProfile {
  const fail = (where: string, what: string): never => {
    throw new Error(`Run setup: ${where} ${what}`);
  };
  if (!isObj(x)) fail("the profile", "must be an object");
  const p = x as Record<string, any>;
  if (!Array.isArray(p.services) || !p.services.length) fail("services", "must list at least one service");
  const names = new Set<string>();
  const services: RunService[] = p.services.map((s: any, i: number) => {
    const at = `services[${i}]`;
    if (!isObj(s)) fail(at, "must be an object");
    if (typeof s.name !== "string" || !/^[\w.-]+$/.test(s.name)) fail(`${at}.name`, "must be a word (letters, digits, - _ .)");
    if (names.has(s.name)) fail(`${at}.name`, `"${s.name}" is used twice`);
    names.add(s.name);
    const kind = s.kind ?? "process";
    if (kind !== "process" && kind !== "compose") fail(`${at}.kind`, 'must be "process" or "compose"');
    if (typeof s.command !== "string" && kind === "process") fail(`${at}.command`, "is required");
    const cwd = typeof s.cwd === "string" ? s.cwd : ".";
    if (path.isAbsolute(cwd) || cwd.split("/").includes("..")) fail(`${at}.cwd`, "must be a path inside the repository");
    if (s.env !== undefined && !strMap(s.env)) fail(`${at}.env`, "must map names to strings");
    if (s.envFiles !== undefined && !strList(s.envFiles)) fail(`${at}.envFiles`, "must be a list of paths");
    const ports: RunPort[] = (s.ports ?? []).map((pt: any, j: number) => {
      if (!isObj(pt) || typeof pt.name !== "string" || !Number.isInteger(pt.base) || pt.base < 1 || pt.base > 65535) {
        fail(`${at}.ports[${j}]`, "needs a name and a base port (1–65535)");
      }
      return { name: pt.name, base: pt.base, ...(typeof pt.url === "string" ? { url: pt.url } : {}) };
    });
    if (s.dependsOn !== undefined && !strList(s.dependsOn)) fail(`${at}.dependsOn`, "must be a list of service names");
    if (s.ready !== undefined && (!isObj(s.ready) || (s.ready.port !== undefined && !ports.some((pt) => pt.name === s.ready.port)))) {
      fail(`${at}.ready`, "must name one of the service's ports, or give a log pattern");
    }
    if (s.ready?.log !== undefined) {
      try {
        new RegExp(s.ready.log);
      } catch {
        fail(`${at}.ready.log`, "isn't a valid pattern");
      }
    }
    if (kind === "compose" && (!isObj(s.compose) || typeof s.compose.file !== "string")) fail(`${at}.compose.file`, "is required for a compose service");
    const debug = s.debug === undefined ? undefined : validateDebug(s.debug, `${at}.debug`, fail);
    return {
      name: s.name,
      kind,
      cwd,
      command: typeof s.command === "string" ? s.command : "",
      ...(s.env ? { env: s.env } : {}),
      ...(s.envFiles ? { envFiles: s.envFiles } : {}),
      ...(ports.length ? { ports } : {}),
      ...(s.dependsOn ? { dependsOn: s.dependsOn } : {}),
      ...(s.ready ? { ready: { ...(s.ready.port ? { port: s.ready.port } : {}), ...(s.ready.log ? { log: s.ready.log } : {}) } } : {}),
      ...(kind === "compose" ? { compose: { file: s.compose.file, ...(strList(s.compose.services) ? { services: s.compose.services } : {}) } } : {}),
      ...(debug ? { debug } : {}),
    };
  });
  for (const s of services) for (const d of s.dependsOn ?? []) if (!names.has(d)) fail(`${s.name}.dependsOn`, `names "${d}", which isn't a service`);
  startOrder(services); // throws on a cycle
  const portNames = new Set<string>();
  for (const s of services)
    for (const pt of s.ports ?? []) {
      if (portNames.has(pt.name)) fail(`${s.name}.ports`, `"${pt.name}" is used by two services`);
      portNames.add(pt.name);
    }
  const sbs = p.sideBySide;
  if (sbs !== undefined && (!isObj(sbs) || !Number.isInteger(sbs.slots) || sbs.slots < 0 || sbs.slots > 9 || !Number.isInteger(sbs.step) || sbs.step < 1)) {
    fail("sideBySide", "needs slots (0–9) and a step of at least 1");
  }
  const prepare = p.prepare;
  if (prepare !== undefined) {
    if (!isObj(prepare)) fail("prepare", "must be an object");
    if (prepare.copy !== undefined && !strList(prepare.copy)) fail("prepare.copy", "must be a list of paths or globs");
    for (const c of prepare.copy ?? []) if (path.isAbsolute(c) || c.split("/").includes("..")) fail("prepare.copy", `"${c}" must be inside the repository`);
    if (prepare.commands !== undefined && (!Array.isArray(prepare.commands) || !prepare.commands.every((c: any) => isObj(c) && typeof c.command === "string" && typeof c.ifMissing === "string"))) {
      fail("prepare.commands", "each needs a command and an ifMissing path");
    }
  }
  return {
    repo,
    services,
    ...(prepare ? { prepare: { ...(prepare.copy ? { copy: prepare.copy } : {}), ...(prepare.commands ? { commands: prepare.commands.map((c: any) => ({ cwd: typeof c.cwd === "string" ? c.cwd : ".", command: c.command, ifMissing: c.ifMissing })) } : {}) } } : {}),
    ...(sbs ? { sideBySide: { slots: sbs.slots, step: sbs.step } } : {}),
    ...(Array.isArray(p.blockers) ? { blockers: p.blockers.filter((b: any) => isObj(b) && typeof b.what === "string" && typeof b.fix === "string") } : {}),
    ...(strList(p.notes) ? { notes: p.notes } : {}),
  };
}

/** A service's debug setup, checked for its type's required fields; unknown fields are dropped. */
function validateDebug(d: any, at: string, fail: (where: string, what: string) => never): RunDebug {
  if (!isObj(d)) fail(at, "must be an object");
  const optStr = (k: string) => (typeof d[k] === "string" ? { [k]: d[k] } : {});
  const optList = (k: string) => (strList(d[k]) ? { [k]: d[k] } : {});
  switch (d.type) {
    case "python":
      if (!d.module && !d.program) fail(at, "needs a module or a program");
      return { type: "python", ...optStr("module"), ...optStr("program"), ...optStr("python"), ...optList("args"), ...(typeof d.justMyCode === "boolean" ? { justMyCode: d.justMyCode } : {}) } as RunDebug;
    case "node":
      if (!d.program && !d.runtimeExecutable) fail(at, "needs a program or a runtimeExecutable");
      return { type: "node", ...optStr("program"), ...optStr("runtimeExecutable"), ...optList("runtimeArgs"), ...optList("args") } as RunDebug;
    case "chrome":
      if (typeof d.url !== "string") fail(`${at}.url`, "is required");
      return { type: "chrome", url: d.url, ...optStr("webRoot") } as RunDebug;
    case "dotnet":
      if (typeof d.program !== "string") fail(`${at}.program`, "is required (the built .dll, or a project to build)");
      return {
        type: "dotnet",
        program: d.program,
        ...optList("args"),
        ...optStr("build"),
        ...(isObj(d.browser) && typeof d.browser.url === "string"
          ? { browser: { url: d.browser.url, ...(d.browser.blazor === true ? { blazor: true } : {}), ...(typeof d.browser.webRoot === "string" ? { webRoot: d.browser.webRoot } : {}) } }
          : {}),
      } as RunDebug;
    case "python-attach":
      if (typeof d.port !== "string") fail(`${at}.port`, "must name one of the service's ports");
      return {
        type: "python-attach",
        port: d.port,
        ...(Array.isArray(d.pathMappings) ? { pathMappings: d.pathMappings.filter((m: any) => isObj(m) && typeof m.localRoot === "string" && typeof m.remoteRoot === "string") } : {}),
        ...optStr("container"),
      } as RunDebug;
    default:
      return fail(`${at}.type`, 'must be "python", "node", "chrome", "dotnet" or "python-attach"');
  }
}

/** Services in an order where each comes after what it depends on. */
export function startOrder(services: RunService[]): RunService[] {
  const byName = new Map(services.map((s) => [s.name, s]));
  const out: RunService[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (s: RunService, chain: string[]) => {
    if (state.get(s.name) === "done") return;
    if (state.get(s.name) === "visiting") throw new Error(`Run setup: services depend on each other in a loop (${[...chain, s.name].join(" → ")})`);
    state.set(s.name, "visiting");
    for (const d of s.dependsOn ?? []) visit(byName.get(d)!, [...chain, s.name]);
    state.set(s.name, "done");
    out.push(s);
  };
  for (const s of services) visit(s, []);
  return out;
}

export function loadProfile(repo: string): RunProfile | null {
  let text: string;
  try {
    text = fs.readFileSync(profilePath(repo), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return validateProfile(JSON.parse(text), repo);
}

export function saveProfile(profile: unknown, repo: string): RunProfile {
  const p = validateProfile(profile, repo);
  fs.mkdirSync(RUN_DIR, { recursive: true });
  const file = profilePath(repo);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(p, null, 2));
  fs.renameSync(tmp, file);
  return p;
}

/** Each port of a service in a slot: slot 0 is the standard number, slot N adds N × step. */
export function slotPorts(profile: RunProfile, slot: number): Map<string, number> {
  const step = (profile.sideBySide ?? DEFAULT_SIDE_BY_SIDE).step;
  const out = new Map<string, number>();
  for (const s of profile.services) for (const pt of s.ports ?? []) out.set(pt.name, pt.base + slot * step);
  return out;
}

/** Fill in ${port:name}, ${slot} and ${worktree}; a port the profile doesn't define is an error, not a blank. */
export function expand(template: string, ctx: { ports: Map<string, number>; slot: number; worktree: string }): string {
  return template.replace(/\$\{(port:([\w.-]+)|slot|worktree)\}/g, (_m, whole: string, name?: string) => {
    if (whole === "slot") return String(ctx.slot);
    if (whole === "worktree") return ctx.worktree;
    const port = ctx.ports.get(name!);
    if (port === undefined) throw new Error(`Run setup: \${port:${name}} names a port no service defines`);
    return String(port);
  });
}

/** KEY=VALUE lines (optionally `export KEY=…`, quoted values); comments and blanks skipped. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if (/^".*"$/.test(v)) v = v.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"');
    else if (/^'.*'$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    out[m[1]] = v;
  }
  return out;
}
