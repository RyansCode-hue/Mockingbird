import { createHash, randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";

const hashOf = (token: string): string => createHash("sha256").update(token).digest("hex");

/**
 * Who's calling on the agents' socket. Each launch of the MCP server gets a token of its own, handed over in a 0600
 * file whose path is all that travels in the launch's argv and environment. The server reads the file once and removes
 * it; main holds only each token's hash and the identity it stands for, in memory, so a new run of the app knows none
 * of the last run's.
 *
 * A launch's token goes when the launch does (retire), not by time: an agent can sit on a trust dialog for as long as
 * it likes before it starts its servers. What a crash leaves behind goes when the next run starts (sweep).
 */
export class McpTokens {
  private readonly identities = new Map<string, string>();
  private readonly hashes = new Map<string, string>();

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

  /** Who a request's token stands for; null for anything else. */
  identity(token: unknown): string | null {
    return typeof token === "string" && token ? (this.identities.get(hashOf(token)) ?? null) : null;
  }

  /** This launch is over: its token stops working, and its file goes if its server never read it. Safe to repeat. */
  retire(file: string): void {
    const hash = this.hashes.get(file);
    if (hash) this.identities.delete(hash);
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

  /** Remove every file left, quitting: the agents' servers that haven't started by now never will. */
  removeUnread(): void {
    for (const name of this.names()) this.remove(path.join(this.dir, name));
  }

  private names(): string[] {
    try {
      return fs.readdirSync(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`messaging: can't list ${this.dir}, so unread tool tokens there stay: ${(err as Error).message}`);
      return [];
    }
  }

  private remove(file: string): void {
    try {
      fs.rmSync(file, { force: true });
    } catch (err) {
      console.warn(`messaging: can't remove ${file}, a tool token nothing reads now: ${(err as Error).message}`);
    }
  }
}
