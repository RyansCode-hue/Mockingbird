import { createHash, randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { LaunchRoot } from "./peerCheck";

const hashOf = (token: string): string => createHash("sha256").update(token).digest("hex");

/**
 * Who's calling on the agents' socket. Each launch of the MCP server gets a token of its own, handed over in a 0600
 * file whose path is all that travels in the launch's argv and environment. The file stays for the launch's life, since
 * an agent may start its server more than once (a sub-agent's, a reconnect); main holds only each token's hash and the
 * identity it stands for, in memory, so a new run of the app knows none of the last run's.
 *
 * A launch's token goes when the launch does (retire), not by time: an agent can sit on a trust dialog for as long as
 * it likes before it starts its servers. What a crash leaves behind goes when the next run starts (sweep).
 */
export class McpTokens {
  private readonly identities = new Map<string, string>();
  private readonly hashes = new Map<string, string>();
  /** Each launch's own process, by its token's hash (bind): a caller has to be it or descend from it (peerCheck.ts). */
  private readonly roots = new Map<string, LaunchRoot>();
  /** Where a file that can't be listed or removed is said: main.log once the app's relay is made. */
  log: (context: string, err: unknown) => unknown = (context, err) => console.warn(`${context}: ${(err as Error).message}`);

  constructor(private readonly dir: string) {}

  /** A new token for `identity`, returning the file holding it. Throws when it can't be written: a launch can't go without it. */
  mint(identity: string): string {
    const token = randomBytes(32).toString("hex");
    const file = path.join(this.dir, randomBytes(16).toString("hex"));
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(this.dir, 0o700); // a folder from before, or made under a looser umask
      fs.writeFileSync(file, token, { mode: 0o600, flag: "wx" });
    } catch (err) {
      throw new Error(`Mockingbird couldn't give this agent its tools: no token could be written in ${this.dir} (${(err as Error).message})`, { cause: err });
    }
    const hash = hashOf(token);
    this.identities.set(hash, identity);
    this.hashes.set(file, hash);
    return file;
  }

  /** Whose running launch `file` is: the identity its token stands for, or null once it has ended (or never was). */
  launchOf(file: unknown): string | null {
    if (typeof file !== "string") return null;
    const hash = this.hashes.get(file);
    return hash ? (this.identities.get(hash) ?? null) : null;
  }

  /** The launch `file` runs as `root` (a pane's pty, a Council turn's shell), once it's started. */
  bind(file: string, root: LaunchRoot): void {
    const hash = this.hashes.get(file);
    if (hash) this.roots.set(hash, root);
  }

  /** The process a token's launch runs as; null when it has none bound, which a caller check refuses. */
  rootOf(token: unknown): LaunchRoot | null {
    return typeof token === "string" && token ? (this.roots.get(hashOf(token)) ?? null) : null;
  }

  /** Who a request's token stands for; null for anything else. */
  identity(token: unknown): string | null {
    return typeof token === "string" && token ? (this.identities.get(hashOf(token)) ?? null) : null;
  }

  /** This launch is over: its token stops working, and its file goes. Safe to repeat. */
  retire(file: string): void {
    const hash = this.hashes.get(file);
    if (hash) this.identities.delete(hash);
    if (hash) this.roots.delete(hash);
    this.hashes.delete(file);
    this.remove(file);
  }

  /** Remove every file this run hasn't a live launch for: what an earlier run left when it crashed. Run past the single-instance lock. */
  sweep(): void {
    for (const name of this.names()) {
      const file = path.join(this.dir, name);
      if (!this.hashes.has(file)) this.remove(file);
    }
  }

  /** Remove every file left, quitting: every launch ends with the app. */
  removeAll(): void {
    for (const name of this.names()) this.remove(path.join(this.dir, name));
  }

  private names(): string[] {
    try {
      return fs.readdirSync(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") this.log(`messaging: can't list ${this.dir}, so tool tokens left there stay`, err);
      return [];
    }
  }

  private remove(file: string): void {
    try {
      fs.rmSync(file, { force: true });
    } catch (err) {
      this.log(`messaging: can't remove ${file}, a tool token nothing uses now`, err);
    }
  }
}
