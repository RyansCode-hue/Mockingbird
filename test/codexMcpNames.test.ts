import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { CodexMcpNames } from "../src/main/codexMcpNames";
import { tempDir } from "./helpers";

/** The names of the user's Codex MCP servers, read once from `codex mcp list --json` and again only when the config changes. */

const LISTING = [
  { name: "github", enabled: true, transport: { type: "stdio", command: "gh-mcp", env: { GITHUB_TOKEN: "ghp_secretvalue" } } },
  { name: "dotted.name", enabled: false, transport: { type: "streamable_http", url: "https://mcp.example.com", bearer_token: "sk-secretvalue" } },
];

function reader(out: () => { code: number; out: string }) {
  const dir = tempDir("codex-home");
  const config = path.join(dir, "config.toml");
  fs.writeFileSync(config, "[mcp_servers.github]\n");
  let reads = 0;
  const names = new CodexMcpNames({
    list: async (bin) => {
      expect(bin).toBe("/bin/codex");
      reads++;
      return out();
    },
    configFiles: () => [config, path.join(dir, "no-such-system-config.toml")],
  });
  return { names, config, reads: () => reads };
}

describe("the user's Codex MCP server names", () => {
  it("are read once, by every launch at the same time, and again only once the config file changes", async () => {
    const r = reader(() => ({ code: 0, out: JSON.stringify(LISTING) }));
    const [a, b] = await Promise.all([r.names.names("/bin/codex"), r.names.names("/bin/codex")]);
    expect(a).toEqual(["github", "dotted.name"]);
    expect(b).toEqual(a);
    expect(await r.names.names("/bin/codex")).toEqual(a);
    expect(r.reads()).toBe(1);
    fs.appendFileSync(r.config, "[mcp_servers.linear]\n");
    await r.names.names("/bin/codex");
    expect(r.reads()).toBe(2);
  });

  it("fail when they can't be read, saying how but nothing the listing holds — and the next launch tries again", async () => {
    let answer = { code: 1, out: 'Error: invalid transport in `mcp_servers.github`: bearer_token = "sk-secretvalue"' };
    const r = reader(() => answer);
    const exited = await r.names.names("/bin/codex").catch((e: Error) => e.message);
    expect(exited).toBe("`codex mcp list` exited with code 1");
    answer = { code: 0, out: '{"oops": "ghp_secretvalue" ' };
    const notJson = await r.names.names("/bin/codex").catch((e: Error) => e.message);
    expect(notJson).toBe("`codex mcp list --json` didn't print JSON");
    answer = { code: 0, out: JSON.stringify({ servers: LISTING }) };
    await expect(r.names.names("/bin/codex")).rejects.toThrow("didn't print the list of servers Mockingbird reads");
    answer = { code: 0, out: JSON.stringify([{ name: 7, token: "ghp_secretvalue" }]) };
    const odd = await r.names.names("/bin/codex").catch((e: Error) => e.message);
    expect(odd).not.toContain("secretvalue");
    expect(r.reads()).toBe(4);
    answer = { code: 0, out: "[]" };
    expect(await r.names.names("/bin/codex")).toEqual([]);
  });
});
