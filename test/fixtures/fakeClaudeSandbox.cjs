// Stands in for Claude Code answering Mockingbird's sandbox check (claudeSandboxProbe.ts): run as `claude -p --bare
// --input-format stream-json … --settings <json>`, it answers `initialize` and `get_sandbox_dialog` from stdin as
// Claude Code 2.1.318 does, the restrictions taken from its --settings. $MB_FAKE_SANDBOX picks a way it goes wrong:
//   good, enabled-renamed, filesystem-renamed, denyRead-renamed, allowUnsandboxed-renamed, not-started, deps,
//   extra-socket, all-sockets, excluded, extra-write, remote-unknown, missing-field, version, no-dialog,
//   dialog-error, non-json, timeout
// $MB_FAKE_SANDBOX_VERSION is its version (2.1.318); $MB_FAKE_SANDBOX_LOG, when set, gets its arguments, stdin and
// whether it saw any credential in its environment, as JSON.
const fs = require("fs");

const mode = process.env.MB_FAKE_SANDBOX || "good";
const version = process.env.MB_FAKE_SANDBOX_VERSION || "2.1.318";
const argv = process.argv.slice(2);
const at = argv.indexOf("--settings");
const settings = at >= 0 ? JSON.parse(argv[at + 1]) : {};
const sb = settings.sandbox || {};
const f = sb.filesystem || {};
const net = sb.network || {};

function dialog() {
  const d = {
    supported: true,
    locked: true,
    overrides_locked: true,
    policy_origins: [],
    enabled: true,
    enabled_in_settings: true,
    mode: sb.autoAllowBashIfSandboxed ? "auto-allow" : "regular",
    auto_allow_available: true,
    no_sandbox_allowed: true,
    unsandboxed_fallback: sb.allowUnsandboxedCommands !== false,
    dependencies: { errors: [], warnings: [] },
    excluded_commands: [],
    restrictions: {
      fs_deny_read: [...(f.denyRead || [])],
      fs_allow_read: [...(f.allowRead || [])],
      fs_allow_write: [...(f.allowWrite || [])],
      fs_deny_write: [...(f.denyWrite || [])],
      network_allowed_domains: [...(net.allowedDomains || [])],
      network_denied_domains: [],
      network_managed: false,
      unix_sockets: [...(net.allowUnixSockets || [])],
      allow_all_unix_sockets: false,
      ignored_glob_patterns: [],
    },
  };
  const r = d.restrictions;
  if (mode === "enabled-renamed") Object.assign(d, { enabled: false, enabled_in_settings: false, mode: "disabled" });
  if (mode === "filesystem-renamed") Object.assign(r, { fs_deny_read: [], fs_allow_read: [], fs_allow_write: [], fs_deny_write: [] });
  if (mode === "denyRead-renamed") r.fs_deny_read = [];
  if (mode === "allowUnsandboxed-renamed") d.unsandboxed_fallback = true;
  if (mode === "not-started") Object.assign(d, { enabled: false, unavailable_reason: "sandbox-exec is missing" });
  if (mode === "deps") d.dependencies.errors = ["ripgrep (rg) not found"];
  if (mode === "extra-socket") r.unix_sockets.push("/var/run/docker.sock");
  if (mode === "all-sockets") r.allow_all_unix_sockets = true;
  if (mode === "excluded") d.excluded_commands = ["docker *"];
  if (mode === "extra-write") r.fs_allow_write.unshift("~/Documents/private-notes");
  if (mode === "remote-unknown") d.policy_origins = ["remote_unknown"];
  if (mode === "missing-field") delete d.restrictions;
  return d;
}

const respond = (id, response) => process.stdout.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: id, response } }) + "\n");

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  if (process.env.MB_FAKE_SANDBOX_LOG) {
    const creds = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"].filter((v) => v in process.env);
    fs.writeFileSync(process.env.MB_FAKE_SANDBOX_LOG, JSON.stringify({ argv, input, creds }));
  }
  if (mode === "timeout") return setTimeout(() => {}, 600_000);
  if (mode === "non-json") {
    process.stdout.write("Error: unknown option '--bare'\n");
    process.exit(1);
  }
  for (const line of input.split("\n").filter(Boolean)) {
    const m = JSON.parse(line);
    if (m.type !== "control_request") continue;
    const sub = m.request.subtype;
    if (sub === "initialize") respond(m.request_id, { commands: [], claude_code_version: mode === "version" ? "9.9.9" : version, pid: process.pid });
    else if (sub === "get_sandbox_dialog") {
      if (mode === "no-dialog") continue;
      if (mode === "dialog-error") {
        process.stdout.write(JSON.stringify({ type: "control_response", response: { subtype: "error", request_id: m.request_id, error: "Unknown control request: get_sandbox_dialog" } }) + "\n");
        continue;
      }
      respond(m.request_id, dialog());
    }
  }
});
