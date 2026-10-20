// A debug adapter on stdio for test/debug.test.ts. "launch" starts a debuggee
// (a Node process that idles) as its own child, the way netcoredbg starts a
// dotnet app; "attach" takes `processId`, a process started elsewhere.
// "disconnect" ends an attached process when told to terminate it (debugpy
// honours terminateDebuggee on an attach too), but never the debuggee it
// launched, standing in for an adapter that leaves its debuggee behind. Both
// pids are reported in an output event: "adapter <pid> debuggee <pid>".
import { spawn } from "child_process";

let buf = Buffer.alloc(0);
let seq = 1;
let attachedTo = null;

const send = (m) => {
  const body = Buffer.from(JSON.stringify({ seq: seq++, ...m }), "utf8");
  process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]));
};
const reply = (req, body = {}) => send({ type: "response", request_seq: req.seq, command: req.command, success: true, body });
const report = (pid) => send({ type: "event", event: "output", body: { category: "console", output: `adapter ${process.pid} debuggee ${pid}\n` } });

function handle(req) {
  const args = req.arguments ?? {};
  if (req.command === "initialize") {
    reply(req, { supportsConfigurationDoneRequest: true, supportTerminateDebuggee: true });
    send({ type: "event", event: "initialized" });
    return;
  }
  if (req.command === "launch") report(spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: args.cwd, stdio: "ignore" }).pid);
  if (req.command === "attach") report((attachedTo = args.processId));
  if (req.command === "disconnect" && args.terminateDebuggee && attachedTo) process.kill(attachedTo, "SIGTERM");
  reply(req);
}

process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const end = buf.indexOf("\r\n\r\n");
    if (end < 0) return;
    const len = Number(/Content-Length:\s*(\d+)/i.exec(buf.subarray(0, end).toString("ascii"))[1]);
    if (buf.length < end + 4 + len) return;
    const msg = JSON.parse(buf.subarray(end + 4, end + 4 + len).toString("utf8"));
    buf = buf.subarray(end + 4 + len);
    if (msg.type === "request") handle(msg);
  }
});
