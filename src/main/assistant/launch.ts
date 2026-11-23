import { askAgent, type ShellRunner } from "../headless";
import { bindMcpLaunch, claudeToolName, mcpLaunch, retireMcpLaunch } from "../messaging";
import type { SpawnRequest } from "./turns";

/**
 * Real Assistant turns: `claude -p` (askAgent) on the model Settings → Assistant names (`r.model`, an alias), with no
 * built-in tools and Mockingbird's MCP server as its only one, allowed only the Assistant's tools. The turn's token is
 * minted for its caller (`r.identity`), bound to the shell the run is spawned in before Claude can start the server,
 * and retired when the run ends however it ends.
 *
 * The run's MOCKINGBIRD_SESSION is askAgent's tag, which names no pane: Mockingbird's hooks, which the user's Claude
 * settings run for it as for any Claude, leave its events but never take them for a pane's (statusFromHook), and in
 * its scratch folder there's no room context or claims file for them to act on.
 *
 * ENABLE_TOOL_SEARCH=false: Claude Code otherwise may hold MCP tools back behind its ToolSearch tool, a built-in that
 * `--tools ""` removes, so the model could see none of them.
 */
export function cliSpawner(o: { run: ShellRunner; env: () => Record<string, string> }): (r: SpawnRequest) => Promise<string> {
  return async (r) => {
    const launch = mcpLaunch(r.identity);
    try {
      return await askAgent(r.prompt, {
        agent: "claude",
        bin: r.bin,
        run: o.run,
        env: { ...o.env(), ENABLE_TOOL_SEARCH: "false" },
        tag: "app-assistant",
        model: r.model,
        timeoutMs: r.timeoutMs,
        mcp: { launch, allowedTools: r.tools.map(claudeToolName) },
        system: r.system,
        onSpawn: (pid) => bindMcpLaunch(launch, pid),
      });
    } finally {
      retireMcpLaunch(launch);
    }
  };
}
