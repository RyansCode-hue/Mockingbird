// Stands in for an agent's own processes in the app tests. A stand-in agent starts it beside itself, so whatever it
// runs descends from the pane's pty, as a real agent's MCP server does, and passes Mockingbird's caller check (W20).
// It listens on $HOME/relay/<pane>.sock, one connection per use:
//   raw  each connection is piped to Mockingbird's socket as it is (a request, then its reply);
//   mcp  each connection gets an MCP server of its own, started from the agent's arguments as its CLI would start
//        it, with the connection as its stdin and stdout.
// It ends with the agent that started it, which passes its own pid ($$) as the second argument.
const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const path = require("path");
const { mcpLaunchFrom } = require("./cliLaunch.cjs");

const [mode, agentPid, ...argv] = process.argv.slice(2);
const home = process.env.HOME;
const pane = process.env.MOCKINGBIRD_SESSION;
const parent = Number(agentPid);
// an agent that has already ended leaves nothing behind, and doesn't take its pane's socket from a live relay
if (process.ppid !== parent) process.exit(0);

const servers = new Set();
const dir = path.join(home, "relay");
fs.mkdirSync(dir, { recursive: true });
const sock = path.join(dir, `${pane}.sock`);
fs.rmSync(sock, { force: true });
const server = net.createServer({ allowHalfOpen: true }, (c) => {
  if (mode === "raw") {
    const up = net.createConnection({ path: path.join(home, ".mockingbird", "mb.sock"), allowHalfOpen: true });
    c.pipe(up);
    up.pipe(c);
    up.on("error", () => c.destroy());
    c.on("error", () => up.destroy());
    return;
  }
  const m = mcpLaunchFrom(argv);
  if (!m) return c.end();
  const p = spawn(m.command, m.args, { env: { ...process.env, ...m.env }, stdio: ["pipe", "pipe", "ignore"] });
  servers.add(p);
  p.on("exit", () => (servers.delete(p), c.end()));
  c.pipe(p.stdin);
  p.stdout.pipe(c);
  c.on("close", () => p.kill());
  c.on("error", () => p.kill());
  p.stdin.on("error", () => p.kill());
});
let ino = null;
server.listen(sock, () => (ino = fs.statSync(sock).ino));

// ends with the agent: a pane's pty closing takes its agent with it, and this with that. The socket goes only if it's
// still this relay's: a restarted pane's relay may already listen at the same path.
setInterval(() => {
  if (process.ppid === parent) return;
  for (const p of servers) p.kill();
  try {
    if (ino !== null && fs.statSync(sock).ino === ino) fs.rmSync(sock);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  process.exit(0);
}, 200);
