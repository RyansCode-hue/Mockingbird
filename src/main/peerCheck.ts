import { execFile } from "child_process";

/**
 * Who's at the other end of the agents' socket, by process (W20). A launch's token is readable by any same-uid process
 * outside a sandbox, so the token alone doesn't say who's calling: the calling process also has to be the launch's
 * own (its root, the pane's pty or a Council turn's shell) or descend from it.
 *
 * Node gives no peer credentials on a unix socket, so this asks the system: one `ps` for the process table, then one
 * `lsof` over main and the root's descendants, where the process holding the socket's other end lists main's end's
 * kernel address as its peer (`->0x…`). Nothing a client sends is used: only main's fd, the kernel's addresses and
 * the process table. Whatever can't be run or read refuses the call (`failed`); nothing falls back to the token.
 */

/** When a process started, as `ps` says; or that it has ended; or why that couldn't be read. */
export type StartOf = { at: string } | { gone: true } | { failed: string };

/** A launch's own process, pinned by when it started, so a pid the system has given to another process isn't it. */
export interface LaunchRoot {
  pid: number;
  /** Read once, when it's bound; asked again next time only when it couldn't be read. */
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

/** Runs a system tool, answering its stdout; rejects on failure, with `code` its exit status. */
export type Exec = (file: string, args: string[], timeoutMs: number) => Promise<string>;

const PS = "/bin/ps";
const LSOF = "/usr/sbin/lsof";
/** The whole check, both tools: past this, the call is refused. */
export const PEER_CHECK_MS = 2000;
/** A tree bigger than this isn't searched: refused, saying so. */
const MAX_CANDIDATES = 2000;

const exec: Exec = (file, args, timeoutMs) =>
  new Promise((resolve, reject) =>
    // a fixed PATH and the C locale: what a client could set in its own environment never reaches these
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 32 << 20, encoding: "utf8", env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" } }, (err, stdout) =>
      err ? reject(Object.assign(err, { stdout })) : resolve(stdout)
    )
  );

const failure = (tool: string, err: unknown): string => {
  const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string; code?: unknown };
  if (e.code === "ENOENT") return `${tool} isn't there`;
  if (e.killed || e.signal === "SIGTERM") return `${tool} took too long`;
  return `${tool} failed (${typeof e.code === "number" ? `exit ${e.code}` : String(e.code ?? e.message)})`;
};

export function systemPeerCheck(o: { exec?: Exec; self?: number; now?: () => number } = {}): PeerCheck {
  const run = o.exec ?? exec;
  const self = o.self ?? process.pid;
  const now = o.now ?? Date.now;

  async function startOf(pid: number): Promise<StartOf> {
    try {
      const out = (await run(PS, ["-o", "lstart=", "-p", String(pid)], PEER_CHECK_MS)).trim().replace(/\s+/g, " ");
      return out ? { at: out } : { failed: "ps gave no start for its workspace's process" };
    } catch (err) {
      // ps exits 1, listing nothing, for a pid that isn't running
      const e = err as { code?: unknown; stdout?: string; killed?: boolean };
      if (e.code === 1 && !e.killed && !e.stdout?.trim()) return { gone: true };
      return { failed: `ps couldn't say when its workspace's process started: ${failure("ps", err)}` };
    }
  }

  return {
    root(pid) {
      let start = startOf(pid);
      return {
        pid,
        async started() {
          const s = await start;
          if ("failed" in s) start = startOf(pid);
          return s;
        },
      };
    },

    async check(fd, root) {
      if (typeof fd !== "number" || !Number.isInteger(fd) || fd < 0) return { ok: false, failed: "the connection has no descriptor to look up" };
      if (!Number.isInteger(root.pid) || root.pid <= 1) return { ok: false, failed: "its launch has no process to check against" };
      const deadline = now() + PEER_CHECK_MS;
      const left = () => Math.max(1, deadline - now());

      const started = await root.started();
      if ("gone" in started) return { ok: false, gone: true };
      if ("failed" in started) return { ok: false, failed: started.failed };

      // the process table: pid, parent, start
      let table: string;
      try {
        table = await run(PS, ["-A", "-o", "pid=,ppid=,lstart="], left());
      } catch (err) {
        return { ok: false, failed: failure("ps", err) };
      }
      const parent = new Map<number, number>();
      const startedAt = new Map<number, string>();
      for (const line of table.split("\n")) {
        if (!line.trim()) continue;
        const m = /^\s*(\d+)\s+(\d+)\s+(\S.*\S)\s*$/.exec(line);
        if (!m) return { ok: false, failed: "ps gave a line it couldn't read" };
        parent.set(Number(m[1]), Number(m[2]));
        startedAt.set(Number(m[1]), m[3].replace(/\s+/g, " "));
      }
      if (!parent.has(self)) return { ok: false, failed: "ps didn't list Mockingbird itself" };
      if (startedAt.get(root.pid) !== started.at) return { ok: false, gone: true };

      // the root and everything under it
      const children = new Map<number, number[]>();
      for (const [pid, ppid] of parent) if (pid !== ppid) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
      const tree = new Set<number>([root.pid]);
      for (const pid of tree) {
        for (const c of children.get(pid) ?? []) tree.add(c);
        if (tree.size > MAX_CANDIDATES) return { ok: false, failed: `its workspace runs more than ${MAX_CANDIDATES} processes, too many to check` };
      }

      // main's end of this connection, and which of them holds the other end
      let sockets: string;
      try {
        sockets = await run(LSOF, ["-a", "-U", "-F", "pfdn", "-p", [...new Set([self, ...tree])].join(",")], left());
      } catch (err) {
        // lsof exits 1 when some pid has no unix socket to list: what it did list still counts, as long as main's end is in it
        const e = err as { code?: unknown; stdout?: string; killed?: boolean };
        if (e.code !== 1 || e.killed || !e.stdout) return { ok: false, failed: failure("lsof", err) };
        sockets = e.stdout;
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
      return peer ? { ok: true, pid: peer.pid } : { ok: false, outside: true };
    },
  };
}
