import { execFile } from "child_process";

/**
 * Who's at the other end of the agents' socket, by process (W20). A launch's token is readable by any same-uid process
 * outside a sandbox, so the token alone doesn't say who's calling: the calling process also has to be the launch's
 * own (its root, the pane's pty or a Council turn's shell) or descend from it.
 *
 * Node gives no peer credentials on a unix socket, so this asks the system: one `ps` for the process table, one `lsof`
 * over main and the root's descendants, where the process holding the socket's other end lists main's end's kernel
 * address as its peer (`->0x…`), then one `ps` of the caller's line back to the root, so a pid that changed hands
 * while it was looked at isn't taken for the one in the table. Nothing a client sends is used: only main's fd, the
 * kernel's addresses and the process table. Whatever can't be run or read refuses the call (`failed`); nothing falls
 * back to the token.
 */

/** When a process started, as `ps` says (UTC); or that it isn't running; or why that couldn't be read. */
export type StartOf = { at: string } | { gone: true } | { failed: string };

/** A launch's own process, pinned by when it started, so a pid the system has given to another process isn't it. */
export interface LaunchRoot {
  pid: number;
  /**
   * Read when it's bound, and kept once it's a start from before then. Until then it's read again at each call: a read
   * that failed, or found nothing running, is never final; a start after it was bound means the pid is another's.
   */
  started(): Promise<StartOf>;
}

export type PeerVerdict =
  | { ok: true; pid: number }
  /** The caller isn't the root or one of its descendants. */
  | { ok: false; outside: true }
  /** The root process has ended, or its pid is now another process's. */
  | { ok: false; gone: true }
  | { ok: false; failed: string };

export interface PeerCheck {
  /** Whether the other end of `fd`, a connection main accepted, is `root` or descends from it. */
  check(fd: unknown, root: LaunchRoot): Promise<PeerVerdict>;
  /** `pid` as a launch's root. */
  root(pid: number): LaunchRoot;
}

/** Runs a system tool with exactly `env`, answering its stdout; rejects on failure, with `code` its exit status. */
export type Exec = (file: string, args: string[], o: { timeoutMs: number; env: Readonly<Record<string, string>> }) => Promise<string>;

const PS = "/bin/ps";
const LSOF = "/usr/sbin/lsof";
/**
 * The tools' whole environment: a fixed PATH, the C locale, and UTC, so a start time reads the same whatever zone the
 * Mac moves to. Nothing of Mockingbird's own environment reaches them.
 */
export const TOOL_ENV: Readonly<Record<string, string>> = Object.freeze({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C", TZ: "UTC" });
/** One check's tools, all told; and, before it starts, how long it waits for a turn. Past either, the call is refused. */
export const PEER_CHECK_MS = 2000;
/** A tree bigger than this isn't searched: refused, saying so. */
const MAX_CANDIDATES = 2000;
/** Checks that run at once; more wait their turn, up to MAX_WAITING, so a flood of calls can't fill the process table. */
export const MAX_RUNNING = 4;
export const MAX_WAITING = 32;

export const systemExec: Exec = (file, args, o) =>
  new Promise((resolve, reject) =>
    execFile(file, args, { timeout: o.timeoutMs, maxBuffer: 32 << 20, encoding: "utf8", env: { ...o.env } }, (err, stdout) => (err ? reject(Object.assign(err, { stdout })) : resolve(stdout)))
  );

const failure = (tool: string, err: unknown): string => {
  const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string; code?: unknown };
  if (e.code === "ENOENT") return `${tool} isn't there`;
  if (e.killed || e.signal === "SIGTERM") return `${tool} took too long`;
  return `${tool} failed (${typeof e.code === "number" ? `exit ${e.code}` : String(e.code ?? e.message)})`;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** `ps -o lstart` in UTC ("Mon Nov  9 16:58:01 2026", spaces folded) as ms since the epoch; null when it isn't one. */
export function lstartMs(at: string): number | null {
  const m = /^\w{3} (\w{3}) (\d{1,2}) (\d\d):(\d\d):(\d\d) (\d{4})$/.exec(at);
  const month = m ? MONTHS.indexOf(m[1]) : -1;
  return m && month >= 0 ? Date.UTC(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])) : null;
}

/** ps's lines of pid, parent and start; null when one can't be read. */
function processLines(out: string): Map<number, { ppid: number; at: string }> | null {
  const rows = new Map<number, { ppid: number; at: string }>();
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const m = /^\s*(\d+)\s+(\d+)\s+(\S.*\S)\s*$/.exec(line);
    if (!m) return null;
    rows.set(Number(m[1]), { ppid: Number(m[2]), at: m[3].replace(/\s+/g, " ") });
  }
  return rows;
}

/** lsof exits 1 when some pid has no unix socket to list, and ps when some pid isn't running: what they did list counts. */
const partial = (err: unknown): string | null => {
  const e = err as { code?: unknown; stdout?: string; killed?: boolean };
  return e.code === 1 && !e.killed && typeof e.stdout === "string" ? e.stdout : null;
};

export function systemPeerCheck(o: { exec?: Exec; self?: number; now?: () => number } = {}): PeerCheck {
  const run = o.exec ?? systemExec;
  const self = o.self ?? process.pid;
  const now = o.now ?? Date.now;

  let running = 0;
  const waiting: (() => void)[] = [];
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else running--;
  };
  /** A turn to run a check: at once while fewer than MAX_RUNNING run, else in line; false when the line is full or slow. */
  const turn = (): Promise<boolean> => {
    if (running < MAX_RUNNING) {
      running++;
      return Promise.resolve(true);
    }
    if (waiting.length >= MAX_WAITING) return Promise.resolve(false);
    return new Promise((resolve) => {
      const go = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        waiting.splice(waiting.indexOf(go), 1);
        resolve(false);
      }, PEER_CHECK_MS);
      waiting.push(go);
    });
  };

  async function startOf(pid: number): Promise<StartOf> {
    let out: string;
    try {
      out = await run(PS, ["-o", "lstart=", "-p", String(pid)], { timeoutMs: PEER_CHECK_MS, env: TOOL_ENV });
    } catch (err) {
      // ps exits 1, listing nothing, for a pid that isn't running
      if (partial(err)?.trim() === "") return { gone: true };
      return { failed: `ps couldn't say when its workspace's process started: ${failure("ps", err)}` };
    }
    const at = out.trim().replace(/\s+/g, " ");
    if (!at) return { failed: "ps gave no start for its workspace's process" };
    return lstartMs(at) === null ? { failed: "ps gave a start for its workspace's process it couldn't read" } : { at };
  }

  async function confirmed(table: Map<number, { ppid: number; at: string }>, root: LaunchRoot, peer: number, left: () => number): Promise<PeerVerdict> {
    // the caller's line back to the root, as the table had it
    const line = [peer];
    while (line[line.length - 1] !== root.pid && line.length <= MAX_CANDIDATES) line.push(table.get(line[line.length - 1])!.ppid);
    let out: string;
    try {
      out = await run(PS, ["-o", "pid=,ppid=,lstart=", "-p", line.join(",")], { timeoutMs: left(), env: TOOL_ENV });
    } catch (err) {
      const listed = partial(err);
      if (listed === null) return { ok: false, failed: failure("ps", err) };
      out = listed;
    }
    const now = processLines(out);
    if (!now) return { ok: false, failed: "ps gave a line it couldn't read" };
    if (now.get(root.pid)?.at !== table.get(root.pid)!.at) return { ok: false, gone: true };
    // the same processes: each pid started when the table said, under the same parent
    const same = line.every((pid) => pid === root.pid || (now.get(pid)?.at === table.get(pid)!.at && now.get(pid)?.ppid === table.get(pid)!.ppid));
    return same ? { ok: true, pid: peer } : { ok: false, failed: "a process in its workspace changed while it was being checked" };
  }

  async function checkNow(fd: number, root: LaunchRoot): Promise<PeerVerdict> {
    const deadline = now() + PEER_CHECK_MS;
    const left = () => Math.max(1, deadline - now());

    const started = await root.started();
    if ("gone" in started) return { ok: false, gone: true };
    if ("failed" in started) return { ok: false, failed: started.failed };

    // the process table: pid, parent, start
    let out: string;
    try {
      out = await run(PS, ["-A", "-o", "pid=,ppid=,lstart="], { timeoutMs: left(), env: TOOL_ENV });
    } catch (err) {
      return { ok: false, failed: failure("ps", err) };
    }
    const table = processLines(out);
    if (!table) return { ok: false, failed: "ps gave a line it couldn't read" };
    if (!table.has(self)) return { ok: false, failed: "ps didn't list Mockingbird itself" };
    if (table.get(root.pid)?.at !== started.at) return { ok: false, gone: true };

    // the root and everything under it
    const children = new Map<number, number[]>();
    for (const [pid, { ppid }] of table) if (pid !== ppid) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
    const tree = new Set<number>([root.pid]);
    for (const pid of tree) {
      for (const c of children.get(pid) ?? []) tree.add(c);
      if (tree.size > MAX_CANDIDATES) return { ok: false, failed: `its workspace runs more than ${MAX_CANDIDATES} processes, too many to check` };
    }

    // main's end of this connection, and which of them holds the other end
    let sockets: string;
    try {
      sockets = await run(LSOF, ["-a", "-U", "-F", "pfdn", "-p", [...new Set([self, ...tree])].join(",")], { timeoutMs: left(), env: TOOL_ENV });
    } catch (err) {
      // as long as main's end is in what it listed
      const listed = partial(err);
      if (!listed) return { ok: false, failed: failure("lsof", err) };
      sockets = listed;
    }
    let pid = -1;
    let file = "";
    let own: bigint | null = null;
    const peers: { pid: number; to: bigint }[] = [];
    for (const line of sockets.split("\n")) {
      const v = line.slice(1);
      if (line[0] === "p") [pid, file] = [/^\d+$/.test(v) ? Number(v) : -1, ""];
      else if (line[0] === "f") file = v;
      else if (line[0] === "d" && pid === self && file === String(fd) && /^0x[0-9a-f]+$/i.test(v)) own = BigInt(v);
      else if (line[0] === "n" && /^->0x[0-9a-f]+$/i.test(v)) peers.push({ pid, to: BigInt(v.slice(2)) });
    }
    if (own === null) return { ok: false, failed: "lsof didn't list Mockingbird's end of the connection" };
    const peer = peers.find((p) => p.to === own && tree.has(p.pid));
    return peer ? confirmed(table, root, peer.pid, left) : { ok: false, outside: true };
  }

  return {
    root(pid) {
      const bound = now();
      let start = startOf(pid);
      let kept = false;
      return {
        pid,
        async started() {
          const s = await start;
          if (kept) return s;
          if (!("at" in s)) {
            start = startOf(pid);
            return s;
          }
          kept = true;
          // a whole-second start from after it was bound is another process's, for good
          if (lstartMs(s.at)! > bound) start = Promise.resolve({ gone: true });
          return start;
        },
      };
    },

    async check(fd, root) {
      if (typeof fd !== "number" || !Number.isInteger(fd) || fd < 0) return { ok: false, failed: "the connection has no descriptor to look up" };
      if (!Number.isInteger(root.pid) || root.pid <= 1) return { ok: false, failed: "its launch has no process to check against" };
      if (!(await turn())) return { ok: false, failed: "too many calls were being checked at once" };
      try {
        return await checkNow(fd, root);
      } finally {
        release();
      }
    },
  };
}
