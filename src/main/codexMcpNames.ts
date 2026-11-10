import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { codexHomeOf } from "./codexRoomSandbox";
import { loginShell, quote, type ShellResult } from "./shell";

/**
 * The names of the MCP servers the user's Codex config defines, which a room launch and a Council turn switch off
 * (codexMcpOff): they run outside the sandbox. Read with `codex mcp list --json` — Codex's own reading of its config
 * layers, so no parser here can disagree with it — from "/", where no project's `.codex` folder is read; once, then again
 * only when a config file changes. The listing also carries each server's command, environment and headers, which can
 * hold tokens: only the names are kept, nothing of it is logged, and a failure says only how the read failed.
 */
export class CodexMcpNames {
  private cache: { key: string; names: string[] } | null = null;
  private reading: { key: string; names: Promise<string[]> } | null = null;

  constructor(
    private o: {
      /** Runs `codex mcp list --json` with `bin`. */
      list: (bin: string) => Promise<ShellResult>;
      /** The config files whose change means the names may have: Codex's config.toml, its system-wide one. */
      configFiles: () => string[];
    }
  ) {}

  /** The names, read again when the config changed; throws when they can't be read, so the caller fails closed. */
  async names(bin: string): Promise<string[]> {
    const key = [bin, ...this.o.configFiles().map(stamp)].join("\n");
    if (this.cache?.key === key) return this.cache.names;
    if (this.reading?.key !== key) {
      const names = this.read(bin).then((n) => {
        this.cache = { key, names: n };
        return n;
      });
      this.reading = { key, names };
      // a failed read isn't kept: the next launch tries again
      names.then(
        () => this.reading?.names === names && (this.reading = null),
        () => this.reading?.names === names && (this.reading = null)
      );
    }
    return this.reading.names;
  }

  private async read(bin: string): Promise<string[]> {
    const r = await this.o.list(bin);
    if (r.code !== 0) throw new Error(`\`codex mcp list\` exited with code ${r.code}`);
    let listed: unknown;
    try {
      listed = JSON.parse(r.out);
    } catch {
      // the parser's message quotes what it read
      throw new Error("`codex mcp list --json` didn't print JSON");
    }
    if (!Array.isArray(listed) || !listed.every((s) => s && typeof s === "object" && typeof (s as { name?: unknown }).name === "string")) {
      throw new Error("`codex mcp list --json` didn't print the list of servers Mockingbird reads");
    }
    return listed.map((s) => (s as { name: string }).name);
  }
}

/** A file's modification time and size, or that it's missing. */
function stamp(file: string): string {
  try {
    const st = fs.statSync(file);
    return `${file}:${st.mtimeMs}:${st.size}`;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return `${file}:none`;
    throw err;
  }
}

/** The app's reading, through the user's login shell (where CODEX_HOME may be set) like every agent launch. */
export const codexMcpNames = new CodexMcpNames({
  list: (bin) => loginShell(`${quote(bin)} mcp list --json`, { cwd: "/", timeoutMs: 20_000 }),
  configFiles: () => [path.join(codexHomeOf(process.env) ?? path.join(os.homedir(), ".codex"), "config.toml"), "/etc/codex/config.toml"],
});
