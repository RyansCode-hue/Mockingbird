// The Mockingbird MCP server's launch, read from a CLI's arguments as that CLI reads them: Claude Code's --mcp-config
// JSON, Codex's -c mcp_servers.mockingbird.* settings (TOML values). Null when the arguments name no such server.
// Shared by the app tests' stand-ins (agentRelay.cjs, fakeCli.cjs).
function mcpLaunchFrom(argv) {
  const i = argv.indexOf("--mcp-config");
  if (i >= 0) {
    const m = JSON.parse(argv[i + 1]).mcpServers.mockingbird;
    return { command: m.command, args: m.args, env: m.env };
  }
  const value = (k) => argv.find((a) => a.startsWith(`mcp_servers.mockingbird.${k}=`))?.slice(`mcp_servers.mockingbird.${k}=`.length);
  if (!value("command")) return null;
  const env = Object.fromEntries([...value("env").matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  return { command: JSON.parse(value("command")), args: JSON.parse(value("args")), env };
}

module.exports = { mcpLaunchFrom };
