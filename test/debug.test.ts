import * as fs from "fs";
import * as http from "http";
import type * as https from "https";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import * as pty from "node-pty";
import { PassThrough } from "stream";
import { describe, expect, it } from "vitest";
import { DapConnection } from "../src/main/dap/client";
import { FrameParser, frame } from "../src/main/rpc";
import { DebugManager } from "../src/main/dap/session";
import { debugTargetFor, inferPython, shellWords } from "../src/main/dap/targets";
import { RunManager, type Spawn } from "../src/main/run";
import { validateProfile } from "../src/main/runProfile";
import { tempDir } from "./helpers";

describe("the DAP wire format", () => {
  it("frames messages and reassembles them however the bytes arrive", () => {
    const a = frame({ seq: 1, type: "event", event: "initialized" });
    const b = frame({ seq: 2, type: "event", event: "output", body: { output: "héllo\n" } });
    const all = Buffer.concat([a, b]);
    const p = new FrameParser();
    const got = [];
    for (let i = 0; i < all.length; i += 7) got.push(...p.push(all.subarray(i, i + 7)));
    expect(got.map((m) => m.event)).toEqual(["initialized", "output"]);
    expect(got[1].body.output).toBe("héllo\n");
  });

  it("matches responses to requests, surfaces failures, and answers the adapter's own requests", async () => {
    const toAdapter = new PassThrough();
    const fromAdapter = new PassThrough();
    const c = new DapConnection(fromAdapter, toAdapter);
    const sent: any[] = [];
    const p = new FrameParser();
    toAdapter.on("data", (d) => sent.push(...p.push(d)));
    const ok = c.request("threads");
    const bad = c.request("evaluate", { expression: "x" });
    await new Promise((r) => setImmediate(r));
    fromAdapter.write(frame({ seq: 9, type: "response", request_seq: sent[1].seq, command: "evaluate", success: false, message: "name 'x' is not defined" }));
    fromAdapter.write(frame({ seq: 10, type: "response", request_seq: sent[0].seq, command: "threads", success: true, body: { threads: [{ id: 1, name: "main" }] } }));
    await expect(ok).resolves.toEqual({ threads: [{ id: 1, name: "main" }] });
    await expect(bad).rejects.toThrow(/not defined/);
    c.reverse = async (cmd, args) => ({ processId: cmd === "runInTerminal" ? args.args.length : 0 });
    fromAdapter.write(frame({ seq: 11, type: "request", command: "runInTerminal", arguments: { args: ["a", "b"] } }));
    await new Promise((r) => setTimeout(r, 20));
    expect(sent.at(-1)).toMatchObject({ type: "response", request_seq: 11, success: true, body: { processId: 2 } });
    const pending = c.request("next", { threadId: 1 });
    fromAdapter.end();
    await expect(pending).rejects.toThrow(/closed the connection/);
  });

  it("closes on something unreadable, keeping what came before it in the same chunk", async () => {
    const fromAdapter = new PassThrough();
    const c = new DapConnection(fromAdapter, new PassThrough());
    const events: string[] = [];
    c.on("event", (e) => events.push(e));
    const closed = new Promise<string>((r) => c.once("close", r));
    const pending = c.request("threads");
    fromAdapter.write(Buffer.concat([frame({ seq: 1, type: "event", event: "initialized" }), Buffer.from("Bogus: 1\r\n\r\n{}")]));
    await expect(pending).rejects.toThrow(/sent something unreadable: a message header without Content-Length/);
    expect(await closed).toMatch(/unreadable/);
    expect(events).toEqual(["initialized"]);
    fromAdapter.write(frame({ seq: 2, type: "event", event: "output" })); // nothing more is read
    await new Promise((r) => setImmediate(r));
    expect(events).toEqual(["initialized"]);
  });

  it("closes when it can't write to the adapter, rather than throwing", async () => {
    const toAdapter = new PassThrough();
    const c = new DapConnection(new PassThrough(), toAdapter);
    const pending = c.request("threads");
    toAdapter.destroy(new Error("write EPIPE"));
    await expect(pending).rejects.toThrow(/Couldn't write to the debug adapter: write EPIPE/);
    await expect(c.request("threads")).rejects.toThrow(/write EPIPE/);
  });

  it("reports an adapter that stops reading and exits, with its last error line", async () => {
    const { spawnStdioAdapter } = await import("../src/main/dap/adapters");
    const a = spawnStdioAdapter("/bin/sh", ["-c", "exec 0<&-; echo 'adapter broke' >&2; sleep 0.3; exit 3"], { PATH: "/usr/bin:/bin" }, os.tmpdir());
    await new Promise((r) => setTimeout(r, 100));
    await expect(a.conn.request("initialize")).rejects.toThrow(/Couldn't write to the debug adapter|exited with code 3/);
    await new Promise<void>((r) => (a.conn.isClosed ? r() : a.conn.once("close", () => r())));
    const late = spawnStdioAdapter("/bin/sh", ["-c", "echo 'adapter broke' >&2; exit 3"], { PATH: "/usr/bin:/bin" }, os.tmpdir());
    await expect(new Promise((r) => late.conn.once("close", r))).resolves.toBe("The debug adapter exited with code 3: adapter broke");
  });
});

describe("downloading an adapter", () => {
  it("fails, rather than hanging, when the connection drops or stalls mid-download", async () => {
    const { download } = await import("../src/main/dap/adapters");
    const server = http.createServer((req, res) => {
      if (req.url === "/missing") return void res.writeHead(404).end();
      res.writeHead(200, { "Content-Length": "100000" });
      res.write("partial");
      if (req.url === "/drop") setTimeout(() => res.socket?.destroy(), 50);
      // "/stall" sends nothing more
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const dir = tempDir("dl");
    const get = http.get as unknown as typeof https.get;
    try {
      await expect(download(`${base}/drop`, path.join(dir, "a"), { get })).rejects.toThrow(/Downloading .*\/drop failed/);
      await expect(download(`${base}/stall`, path.join(dir, "b"), { get, timeoutMs: 300 })).rejects.toThrow(/Downloading .*\/stall failed/);
      await expect(download(`${base}/missing`, path.join(dir, "c"), { get })).rejects.toThrow(/HTTP 404/);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

describe("reading a Python service's command for the debugger", () => {
  it("splits words like a shell", () => {
    expect(shellWords(`a "b c" 'd e' f\\ g ""`)).toEqual(["a", "b c", "d e", "f g", ""]);
  });

  it("finds the venv's Python and the tool, keeps earlier steps, and drops --reload", () => {
    expect(inferPython("PYTHONPATH=. .venv/bin/alembic upgrade head && PYTHONPATH=. .venv/bin/uvicorn app.main:app --reload --port 8010")).toEqual({
      debug: { type: "python", python: ".venv/bin/python", module: "uvicorn", args: ["app.main:app", "--port", "8010"] },
      env: { PYTHONPATH: "." },
      pre: ["PYTHONPATH=. .venv/bin/alembic upgrade head"],
      droppedReload: true,
    });
    expect(inferPython("python3 -m http.server 8000")?.debug).toMatchObject({ python: "python3", module: "http.server", args: ["8000"] });
    expect(inferPython("venv/bin/python manage.py runserver")?.debug).toMatchObject({ python: "venv/bin/python", program: "manage.py", args: ["runserver"] });
    expect(inferPython("npm run dev")).toBeNull();
  });
});

// the real adapter, cached between test runs so it's downloaded once
const cache = path.join(os.tmpdir(), "mockingbird-test-debug-cache");

describe("debugging a real Python program", () => {
  it("stops at a breakpoint, shows locals, evaluates, steps, and runs to the end", async () => {
    const dir = fs.realpathSync(tempDir("dbg-py"));
    fs.writeFileSync(
      path.join(dir, "app.py"),
      ["def add(a, b):", "    total = a + b", "    return total", "", 'print("result", add(2, 3), flush=True)', ""].join("\n")
    );
    const events: any[] = [];
    const dbg = new DebugManager({ emit: (ch, ...args) => events.push([ch, ...args]), breakpointsDir: path.join(dir, ".bp") });
    await dbg.setBreakpoints(dir, "app.py", [2]);
    const spawn: Spawn = (command, o) => pty.spawn("/bin/sh", ["-c", command], { name: "xterm-256color", cols: 120, rows: 30, cwd: o.cwd, env: o.env });
    const profile = validateProfile({ services: [{ name: "app", command: "python3 app.py" }] }, dir);
    const runs = new RunManager({
      spawn,
      emit: (ch, ...args) => events.push([ch, ...args]),
      baseEnv: () => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir }),
      docker: async () => "docker",
      runShell: async () => ({ code: 0, out: "" }),
      profileFor: () => profile,
      mainOf: async () => dir,
      debugger: dbg,
      debugTarget: (s, ctx) => debugTargetFor(s, { ...ctx, debugRoot: cache }),
    });

    const stoppedAt = async () => {
      for (let i = 0; i < 200; i++) {
        const e = events.filter((x) => x[0] === "debug:stopped").pop();
        if (e && !e.seen) {
          e.seen = true;
          return e[2];
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`never stopped: ${JSON.stringify(events.filter((x) => x[0] === "debug:output").map((x) => x[3]))}`);
    };

    const r = (await runs.start(dir, { mode: "side", debug: ["app"] })) as { ids: string[] };
    const sessionId = runs.states()[0].debug!;
    expect(sessionId).toMatch(/^dbg-/);
    const first = await stoppedAt();
    expect(first.frame).toMatchObject({ path: path.join(dir, "app.py"), line: 2, name: "add" });

    const scopes = await dbg.scopes(sessionId, first.frame.id);
    const locals = await dbg.variables(sessionId, scopes[0].ref);
    expect(locals.filter((v) => ["a", "b"].includes(v.name)).map((v) => `${v.name}=${v.value}`)).toEqual(["a=2", "b=3"]);
    expect((await dbg.evaluate(sessionId, "a * 10 + b", first.frame.id, "repl")).result).toBe("23");

    await dbg.control(sessionId, "next", first.threadId);
    const second = await stoppedAt();
    expect(second.frame.line).toBe(3);
    const after = await dbg.variables(sessionId, (await dbg.scopes(sessionId, second.frame.id))[0].ref);
    expect(after.find((v) => v.name === "total")?.value).toBe("5");

    await dbg.control(sessionId, "continue", second.threadId);
    for (let i = 0; i < 100 && runs.states()[0].status !== "stopped"; i++) await new Promise((res) => setTimeout(res, 100));
    expect(runs.states()[0].status).toBe("stopped");
    expect(runs.buffer(r.ids[0])).toContain("result 5"); // the program's own output is in its log, like any service
  }, 120_000);
});

describe("reading a Node service's command for the debugger", () => {
  it("debugs a dev server's page in the browser, and other Node programs under Node", async () => {
    const { inferNode } = await import("../src/main/dap/targets");
    const vite = tempDir("vite-app");
    fs.writeFileSync(path.join(vite, "vite.config.ts"), "export default {}");
    expect(inferNode("npm run dev -- --port 5183 --strictPort", vite, "http://localhost:5183")).toEqual({ type: "chrome", url: "http://localhost:5183" });
    expect(inferNode("npx vite --port 5173", tempDir("x"), "http://localhost:5173")).toEqual({ type: "chrome", url: "http://localhost:5173" });
    expect(inferNode("node src/app.js --flag", tempDir("y"), undefined)).toEqual({ type: "node", program: "src/app.js", args: ["--flag"] });
    // the program only: PORT=3000 is the command's environment (see lastStep)
    expect(inferNode("PORT=3000 npm run dev", tempDir("z"), undefined)).toEqual({ type: "node", runtimeExecutable: "npm", runtimeArgs: ["run", "dev"] });
    expect(inferNode("dotnet run", tempDir("w"), undefined)).toBeNull();
    expect(inferNode('node -e "console.log(1)"', tempDir("v"), undefined)).toEqual({ type: "node", runtimeExecutable: "node", runtimeArgs: ["-e", "console.log(1)"] });
  });
});

describe("debugging real JavaScript", () => {
  const debugRun = (dir: string, profile: any, events: any[], extra: object = {}) => {
    const dbg = new DebugManager({ emit: (ch, ...a) => events.push([ch, ...a]), breakpointsDir: path.join(dir, ".bp") });
    const spawn: Spawn = (command, o) => pty.spawn("/bin/sh", ["-c", command], { name: "xterm-256color", cols: 120, rows: 30, cwd: o.cwd, env: o.env });
    const runs = new RunManager({
      spawn,
      emit: (ch, ...a) => events.push([ch, ...a]),
      baseEnv: () => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir }),
      docker: async () => "docker",
      runShell: async () => ({ code: 0, out: "" }),
      profileFor: () => validateProfile(profile, dir),
      mainOf: async () => dir,
      debugger: dbg,
      debugTarget: (s, ctx) => debugTargetFor(s, { ...ctx, debugRoot: cache, ...extra }),
    });
    return { dbg, runs };
  };
  const stopped = async (events: any[]) => {
    for (let i = 0; i < 300; i++) {
      const e = events.find((x) => x[0] === "debug:stopped" && !x.seen);
      if (e) {
        e.seen = true;
        return e;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`never stopped: ${JSON.stringify(events.filter((x) => x[0] === "debug:output").map((x) => x[3])).slice(0, 600)}`);
  };

  it("stops a Node program at a breakpoint and reads its variables", async () => {
    const dir = fs.realpathSync(tempDir("dbg-node"));
    fs.writeFileSync(path.join(dir, "app.js"), ["function add(a, b) {", "  const total = a + b;", "  return total;", "}", 'console.log("sum", add(4, 5));', ""].join("\n"));
    const events: any[] = [];
    const { dbg, runs } = debugRun(dir, { services: [{ name: "app", command: "node app.js" }] }, events);
    await dbg.setBreakpoints(dir, "app.js", [2]);
    const r = (await runs.start(dir, { mode: "side", debug: ["app"] })) as { ids: string[] };
    const e = await stopped(events);
    expect(e[2].frame).toMatchObject({ path: path.join(dir, "app.js"), line: 2, name: expect.stringMatching(/add$/) });
    const locals = await dbg.variables(e[1], (await dbg.scopes(e[1], e[2].frame.id))[0].ref);
    expect(locals.filter((v) => ["a", "b"].includes(v.name)).map((v) => `${v.name}=${v.value}`).sort()).toEqual(["a=4", "b=5"]);
    await dbg.control(e[1], "continue", e[2].threadId);
    const plain = () => runs.buffer(r.ids[0]).replace(/\x1b\[[0-9;]*m/g, ""); // node colours the 9
    for (let i = 0; i < 100 && !plain().includes("sum 9"); i++) await new Promise((res) => setTimeout(res, 100));
    expect(plain()).toContain("sum 9");
    await runs.stopAll();
    await dbg.stopAll();
  }, 120_000);

  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  // a real Chrome needs a desktop session: CI runners have none, so this runs on a developer's Mac only
  it.skipIf(!fs.existsSync(chrome) || !!process.env.CI)("opens a dev server's page in Chrome and stops at a breakpoint in its script", async () => {
    const dir = fs.realpathSync(tempDir("dbg-web"));
    fs.writeFileSync(path.join(dir, "index.html"), '<!doctype html><html><body><script src="main.js"></script></body></html>');
    fs.writeFileSync(path.join(dir, "main.js"), ["function greet(name) {", "  const message = 'hello ' + name;", "  document.title = message;", "}", "setTimeout(() => greet('mockingbird'), 500);", ""].join("\n"));
    const server = `node -e "const fs=require('fs'),p=require('path');require('http').createServer((q,s)=>{const f=p.join(process.cwd(),q.url==='/'?'index.html':q.url);fs.readFile(f,(e,d)=>{s.writeHead(e?404:200,{'Content-Type':f.endsWith('.js')?'text/javascript':'text/html'});s.end(d)})}).listen(\${port:web})"`;
    const events: any[] = [];
    const { dbg, runs } = debugRun(
      dir,
      { services: [{ name: "web", command: server, ports: [{ name: "web", base: 47410, url: "http://localhost:${port}/" }], ready: { port: "web" }, debug: { type: "chrome", url: "http://localhost:${port:web}/" } }] },
      events,
      { browserArgs: ["--headless=new", "--use-mock-keychain", "--password-store=basic"] }
    );
    await dbg.setBreakpoints(dir, "main.js", [2]);
    try {
      await runs.start(dir, { mode: "side", debug: ["web"] });
      const e = await stopped(events);
      expect(e[2].frame).toMatchObject({ line: 2, name: expect.stringMatching(/greet$/) });
      expect(e[2].frame.path).toBe(path.join(dir, "main.js")); // mapped back to the file on disk
      const r = await dbg.evaluate(e[1], "name.toUpperCase()", e[2].frame.id, "repl");
      expect(r.result).toContain("MOCKINGBIRD");
    } finally {
      // a failed run must not leave a headless Chrome behind
      await runs.stopAll();
      await dbg.stopAll();
    }
  }, 120_000);
});

describe("reading a .NET service's command for the debugger", () => {
  it("finds the project and the app's arguments", async () => {
    const { inferDotnet } = await import("../src/main/dap/targets");
    const repo = tempDir("dn");
    fs.mkdirSync(path.join(repo, "Quantous.Admin/Server"), { recursive: true });
    fs.writeFileSync(path.join(repo, "Quantous.Admin/Server/Quantous.Admin.Server.csproj"), "<Project/>");
    expect(inferDotnet("dotnet run --project Quantous.Admin/Server --no-launch-profile --urls https://localhost:5012 -- --seed", repo)).toEqual({
      type: "dotnet",
      program: "Quantous.Admin/Server/Quantous.Admin.Server.csproj",
      args: ["--urls", "https://localhost:5012", "--seed"],
    });
    expect(inferDotnet("ASPNETCORE_ENVIRONMENT=Development dotnet watch run --project api/Api.csproj", repo)?.program).toBe("api/Api.csproj");
    expect(inferDotnet("dotnet test", repo)).toBeNull();
  });
});

describe("a command's variables and earlier steps under the debugger", () => {
  it("splits off the last step's variables and the steps before it, quotes respected", async () => {
    const { lastStep } = await import("../src/main/dap/targets");
    expect(lastStep(`A=1 B="x y" npm run dev`)).toEqual({ pre: [], env: { A: "1", B: "x y" }, words: ["npm", "run", "dev"] });
    expect(lastStep(`dotnet ef database update && node -e "a && b"`)).toEqual({ pre: ["dotnet ef database update"], env: {}, words: ["node", "-e", "a && b"] });
  });

  it("keeps them for .NET and Node programs too", async () => {
    const dir = fs.realpathSync(tempDir("dn-env"));
    fs.writeFileSync(path.join(dir, "Api.csproj"), "<Project/>");
    const ctx = { cwd: dir, env: { PATH: "/usr/bin" }, expand: (x: string) => x, debugRoot: cache };
    const dn = await debugTargetFor({ name: "api" }, { ...ctx, command: "dotnet ef database update && ASPNETCORE_ENVIRONMENT=Development dotnet run --urls http://localhost:5000" });
    expect(dn.config.env).toEqual({ PATH: "/usr/bin", ASPNETCORE_ENVIRONMENT: "Development" });
    expect(dn.internal!.build).toMatch(/^dotnet ef database update && dotnet build /);
    expect(dn.notes.join("\n")).toContain("These run first, in the same terminal: dotnet ef database update");
    const node = await debugTargetFor({ name: "web" }, { ...ctx, command: "npm ci && PORT=3000 npm run dev" });
    expect(node.config.env).toEqual({ PATH: "/usr/bin", PORT: "3000" });
    expect(node.pre).toEqual(["npm ci"]);
  }, 120_000);
});

// the newest installed SDK decides the target framework, so the test builds wherever .NET is
const dotnetMajor = (() => {
  try {
    return parseInt(require("child_process").execFileSync("dotnet", ["--version"], { encoding: "utf8" }).trim().split(".")[0], 10) || 0;
  } catch {
    return 0;
  }
})();
const hasDotnet = dotnetMajor >= 6;

describe("debugging a real .NET program", () => {
  it.skipIf(!hasDotnet)("builds it on the service's terminal, stops at a breakpoint, and forwards its output to the log", async () => {
    const dir = fs.realpathSync(tempDir("dbg-dotnet"));
    fs.mkdirSync(path.join(dir, "app"));
    fs.writeFileSync(
      path.join(dir, "app", "app.csproj"),
      `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net${dotnetMajor}.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings></PropertyGroup></Project>`
    );
    fs.writeFileSync(
      path.join(dir, "app", "Program.cs"),
      ["static int Add(int a, int b)", "{", "    var total = a + b;", "    return total;", "}", 'Console.WriteLine($"sum {Add(4, 5)}");', ""].join("\n")
    );
    const events: any[] = [];
    const dbg = new DebugManager({ emit: (ch, ...a) => events.push([ch, ...a]), breakpointsDir: path.join(dir, ".bp") });
    await dbg.setBreakpoints(dir, "app/Program.cs", [3]);
    const runShell = (command: string, cwd: string, env: Record<string, string>) =>
      new Promise<{ code: number; out: string }>((res) => require("child_process").exec(command, { cwd, env }, (err: any, out: string, se: string) => res({ code: err ? err.code ?? 1 : 0, out: out + se })));
    const runs = new RunManager({
      spawn: (command, o) => pty.spawn("/bin/sh", ["-c", command], { name: "xterm-256color", cols: 120, rows: 30, cwd: o.cwd, env: o.env }),
      emit: (ch, ...a) => events.push([ch, ...a]),
      baseEnv: () => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME!, DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_NOLOGO: "1" }),
      docker: async () => "docker",
      runShell,
      profileFor: () => validateProfile({ services: [{ name: "app", command: "dotnet run --project app" }] }, dir),
      mainOf: async () => dir,
      debugger: dbg,
      debugTarget: (s, ctx) => debugTargetFor(s, { ...ctx, debugRoot: cache }),
    });
    try {
      const r = (await runs.start(dir, { mode: "side", debug: ["app"] })) as { ids: string[] };
      let e: any;
      for (let i = 0; i < 600 && !e; i++) {
        e = events.find((x) => x[0] === "debug:stopped");
        await new Promise((res) => setTimeout(res, 100));
      }
      expect(e, JSON.stringify(events.filter((x) => x[0] === "debug:output").map((x) => x[3])).slice(0, 600)).toBeTruthy();
      expect(e[2].frame).toMatchObject({ path: path.join(dir, "app", "Program.cs"), line: 3 });
      const locals = await dbg.variables(e[1], (await dbg.scopes(e[1], e[2].frame.id))[0].ref);
      expect(locals.filter((v) => ["a", "b"].includes(v.name)).map((v) => `${v.name}=${v.value}`).sort()).toEqual(["a=4", "b=5"]);
      await dbg.control(e[1], "continue", e[2].threadId);
      for (let i = 0; i < 100 && !runs.buffer(r.ids[0]).includes("sum 9"); i++) await new Promise((res) => setTimeout(res, 100));
      expect(runs.buffer(r.ids[0])).toContain("dotnet build"); // the build ran on the service's own terminal
      expect(runs.buffer(r.ids[0])).toContain("sum 9");
      for (let i = 0; i < 50 && runs.states()[0].status !== "stopped"; i++) await new Promise((res) => setTimeout(res, 100));
      expect(runs.states()[0]).toMatchObject({ status: "stopped", exitCode: 0 });
    } finally {
      await runs.stopAll();
      await dbg.stopAll();
    }
  }, 240_000);
});

describe("Blazor WebAssembly and containers", () => {
  it("recognises a server that hosts a Blazor WebAssembly client", async () => {
    const { hostsBlazorWasm } = await import("../src/main/dap/targets");
    const dir = tempDir("blazor");
    fs.writeFileSync(path.join(dir, "Server.csproj"), '<Project Sdk="Microsoft.NET.Sdk.Web"><ItemGroup><PackageReference Include="Microsoft.AspNetCore.Components.WebAssembly.Server" Version="10.0.0" /></ItemGroup></Project>');
    fs.writeFileSync(path.join(dir, "Api.csproj"), '<Project Sdk="Microsoft.NET.Sdk.Web" />');
    expect(hostsBlazorWasm(path.join(dir, "Server.csproj"))).toBe(true);
    expect(hostsBlazorWasm(path.join(dir, "Api.csproj"))).toBe(false);
    expect(hostsBlazorWasm(path.join(dir, "Missing.csproj"))).toBe(false);
  });

  it("mounts debugpy into the debugged compose service and publishes its port on loopback", async () => {
    const { buildOverride } = await import("../src/main/composeOverride");
    const config = { services: { app: { ports: [{ target: 8080, published: "58080" }], volumes: [{ type: "bind", source: "/m/src", target: "/app" }] }, red: {} } };
    const y = buildOverride(config, { main: "/m", worktree: "/m", slot: 0, step: 10, project: "p", debugpy: { service: "app", dir: "/dbg/debugpy", port: 5678 } });
    expect(y).toContain('"volumes": [{"type":"bind","source":"/dbg/debugpy","target":"/opt/mockingbird/debugpy","read_only":true}]');
    expect(y).toContain('"ports": [{"target":5678,"published":"5678","host_ip":"127.0.0.1","protocol":"tcp"}]');
    expect(y).toContain('"MOCKINGBIRD_DEBUGPY": "/opt/mockingbird/debugpy"');
    expect(y).not.toContain('"red"');
    // side by side, the debug port joins the shifted ports
    const y1 = buildOverride(config, { main: "/m", worktree: "/m", slot: 1, step: 10, project: "p", debugpy: { service: "app", dir: "/dbg", port: 5688 } });
    expect(y1).toContain('"ports": !override [{"target":8080,"published":"58090"},{"target":5678,"published":"5688","host_ip":"127.0.0.1","protocol":"tcp"}]');
  });

  it("attaches to a Python process that's already listening, and maps its paths", async () => {
    const dir = fs.realpathSync(tempDir("dbg-attach"));
    fs.writeFileSync(path.join(dir, "worker.py"), ["import time", "def tick(n):", "    value = n * 3", "    return value", "for i in range(1000):", "    tick(i)", "    time.sleep(0.05)", ""].join("\n"));
    const { ensureAdapter, DEBUGPY } = await import("../src/main/dap/adapters");
    const debugpyDir = await ensureAdapter(DEBUGPY, undefined, cache);
    const events: any[] = [];
    const dbg = new DebugManager({ emit: (ch, ...a) => events.push([ch, ...a]), breakpointsDir: path.join(dir, ".bp") });
    await dbg.setBreakpoints(dir, "worker.py", [3]);
    const runs = new RunManager({
      spawn: (command, o) => pty.spawn("/bin/sh", ["-c", command], { name: "xterm-256color", cols: 120, rows: 30, cwd: o.cwd, env: o.env }),
      emit: (ch, ...a) => events.push([ch, ...a]),
      baseEnv: () => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir }),
      docker: async () => "docker",
      runShell: async () => ({ code: 0, out: "" }),
      // like a container: the program listens with debugpy on its own, Mockingbird only attaches
      profileFor: () =>
        validateProfile(
          {
            services: [
              {
                name: "worker",
                command: `PYTHONPATH=${debugpyDir} python3 -m debugpy --listen 127.0.0.1:\${port:debug} worker.py`,
                ports: [{ name: "debug", base: 47630 }],
                ready: { port: "debug" },
                debug: { type: "python-attach", port: "debug", pathMappings: [{ localRoot: ".", remoteRoot: dir }] },
              },
            ],
          },
          dir
        ),
      mainOf: async () => dir,
      debugger: dbg,
      debugTarget: (s, ctx) => debugTargetFor(s, { ...ctx, debugRoot: cache }),
    });
    try {
      await runs.start(dir, { mode: "side", debug: ["worker"] });
      let e: any;
      for (let i = 0; i < 200 && !e; i++) {
        e = events.find((x) => x[0] === "debug:stopped");
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(e, JSON.stringify(events.filter((x) => x[0] === "debug:output").map((x) => x[3])).slice(0, 500)).toBeTruthy();
      expect(e[2].frame).toMatchObject({ path: path.join(dir, "worker.py"), line: 3, name: "tick" });
      const locals = await dbg.variables(e[1], (await dbg.scopes(e[1], e[2].frame.id))[0].ref);
      expect(locals.find((v) => v.name === "n")).toBeTruthy();
    } finally {
      await runs.stopAll();
      await dbg.stopAll();
    }
  }, 120_000);
});
