// The UI preview: the real interface running in a browser against fixture
// data (src/preview/stub.ts) instead of the main process. For looking at and
// clicking through UI changes without the app, from any session or by hand.
//
//   npm run ui-preview            build, serve on http://localhost:5190, and
//                                 rebuild on every source change (reload the page)
//   npm run ui-preview -- --port 5300
//   open http://localhost:5190/?reset to start again from the fixtures
//
//   npm run ui-preview -- --shot out/shot.png [--size 1400x900] [--query "tab=dashboard&theme=light"]
//                                 build once, render in headless Chrome, save a
//                                 screenshot, exit — for sessions without a browser
//                                 (open the PNG with the Read tool)
import * as esbuild from "esbuild";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import * as os from "os";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const options = (outDir) => ({
  entryPoints: [path.join(root, "src/preview/entry.ts")],
  bundle: true,
  platform: "browser",
  format: "iife",
  outfile: path.join(outDir, "renderer.js"),
  loader: { ".css": "css" },
  logLevel: "error",
});

function writeHtml(outDir) {
  const html = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8").replace("<title>Mockingbird</title>", "<title>Mockingbird · UI preview</title>");
  fs.writeFileSync(path.join(outDir, "index.html"), html);
}

/** Bundle the interface with the fixture stand-in into `outDir`. */
export async function buildPreview(outDir = path.join(root, "out", "ui-preview")) {
  fs.mkdirSync(outDir, { recursive: true });
  await esbuild.build(options(outDir));
  writeHtml(outDir);
  return outDir;
}

/** Build, then keep rebuilding as the source changes. */
async function watchPreview(outDir = path.join(root, "out", "ui-preview")) {
  fs.mkdirSync(outDir, { recursive: true });
  writeHtml(outDir);
  const ctx = await esbuild.context({
    ...options(outDir),
    plugins: [{ name: "report", setup: (b) => b.onEnd((r) => console.log(r.errors.length ? `UI preview: build failed (${r.errors.length} error${r.errors.length === 1 ? "" : "s"})` : `UI preview: built ${new Date().toLocaleTimeString()}`)) }],
  });
  await ctx.watch();
  return outDir;
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".map": "application/json" };

function serve(dir, port, onListening = (p) => console.log(`UI preview: http://localhost:${p}  (?reset starts from the fixtures; Ctrl-C to stop)`)) {
  return http
    .createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
      const file = path.resolve(dir, rel);
      if (!file.startsWith(dir + path.sep) || !fs.existsSync(file)) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
      fs.createReadStream(file).pipe(res);
    })
    .listen(port, "127.0.0.1", function () {
      onListening(this.address().port);
    })
    .on("error", (err) => {
      console.error(`UI preview couldn't listen on port ${port}: ${err.message}`);
      process.exit(1);
    });
}

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/**
 * Render the preview in headless Chrome and save a screenshot. Chrome runs
 * with a throwaway profile and a mock keychain, so it never touches (or asks
 * about) the user's own Chrome data.
 */
export async function screenshot(file, { size = "1400x900", query = "", outDir } = {}) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.rmSync(target, { force: true });
  // Chrome writes the screenshot within seconds but can linger for minutes
  // before exiting, so the file decides when it's done (or, once Chrome has gone, that it's there)
  let lastSize = -1;
  await inChrome({ size, query: `shot${query ? `&${query.replace(/^[?&]/, "")}` : ""}`, outDir, args: [`--screenshot=${target}`], what: "the screenshot" }, (closed) => {
    const now = fs.existsSync(target) ? fs.statSync(target).size : -1;
    const done = now > 0 && (closed || now === lastSize);
    lastSize = now;
    return done;
  });
  if (!fs.existsSync(target)) throw new Error("Chrome finished without writing the screenshot");
  return target;
}

/**
 * Render the preview in headless Chrome and return the page's HTML once the
 * fixtures have landed — with `measure=<selector>` in the query, it holds
 * where those elements sit (src/preview/stub.ts), for layout checks.
 */
export async function pageDom({ size = "1400x900", query = "", outDir } = {}) {
  let html = "";
  await inChrome({ size, query, outDir, args: ["--dump-dom"], what: "the page", onStdout: (d) => (html += d) }, () => html.includes("</html>"));
  return html;
}

/**
 * Render the preview in headless Chrome in real time (no virtual time: animations and View Transitions only
 * run in real frames) and return what the page's expression `read` gives, once it gives anything but null —
 * for checks a page script reports on, like the motion audit (src/preview/stub.ts). `scale` sets the device pixel
 * ratio (2 for a Retina screen's raster costs).
 */
/** The keys a page can ask to have pressed (window.__mbKeys), as Chrome's input names them. */
const KEYS = {
  n: { key: "n", code: "KeyN", keyCode: 78, text: "n" },
  N: { key: "N", code: "KeyN", keyCode: 78, text: "N" },
  e: { key: "e", code: "KeyE", keyCode: 69, text: "e" },
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
};

/**
 * Press, for real, the keys the page asked for: it pushes { key, shift?, meta? } onto window.__mbKeys, and
 * window.__mbKeysDone counts the ones pressed. They reach whatever has the keyboard, as a person's would, which a
 * KeyboardEvent dispatched at an element can't show.
 */
async function pressAsked(ask) {
  const asked = await ask("Runtime.evaluate", { expression: "JSON.stringify((window.__mbKeys || []).splice(0))", returnByValue: true });
  const keys = JSON.parse(asked?.result?.value ?? "[]");
  for (const k of keys) {
    const d = KEYS[k.key];
    if (!d) throw new Error(`the page asked for a key this driver doesn't press: ${k.key}`);
    const modifiers = (k.shift ? 8 : 0) | (k.meta ? 4 : 0);
    const base = { modifiers, key: d.key, code: d.code, windowsVirtualKeyCode: d.keyCode, nativeVirtualKeyCode: d.keyCode };
    await ask("Input.dispatchKeyEvent", { type: d.text && !k.meta ? "keyDown" : "rawKeyDown", ...base, ...(d.text && !k.meta ? { text: d.text, unmodifiedText: d.text } : {}) });
    await ask("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }
  if (keys.length) await ask("Runtime.evaluate", { expression: `window.__mbKeysDone = (window.__mbKeysDone || 0) + ${keys.length}` });
}

export async function pageResult({ size = "1400x900", query = "", outDir, read, scale = null }) {
  let devtools = null;
  let result = null;
  let ws = null;
  let id = 0;
  const ask = (method, params) =>
    new Promise((resolve) => {
      const n = ++id;
      const on = (e) => {
        const m = JSON.parse(String(e.data));
        if (m.id !== n) return;
        ws.removeEventListener("message", on);
        resolve(m.result);
      };
      ws.addEventListener("message", on);
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  try {
    await inChrome({ size, query, outDir, budget: null, args: ["--remote-debugging-port=0", ...(scale ? [`--force-device-scale-factor=${scale}`] : [])], what: "the page's result", onStderr: (text) => (devtools ??= text.match(/DevTools listening on (ws:\/\/\S+)/)?.[1] ?? null) }, async () => {
      if (!devtools) return false;
      if (!ws) {
        const pages = await (await fetch(`http://127.0.0.1:${new URL(devtools).port}/json`)).json();
        const page = pages.find((t) => t.type === "page" && t.url.startsWith("http://localhost"));
        if (!page) return false;
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((r, j) => {
          ws.addEventListener("open", r, { once: true });
          ws.addEventListener("error", j, { once: true });
        });
      }
      await pressAsked(ask);
      const r = await ask("Runtime.evaluate", { expression: read, returnByValue: true });
      result = r?.result?.value ?? null;
      return result !== null;
    });
  } finally {
    ws?.close();
  }
  return result;
}

/**
 * Build and serve the preview, open it in headless Chrome with `args`, and stop it all once `done(closed)` says
 * the result is there (`closed`: Chrome has exited and its output is read). `budget` is the virtual time the
 * page gets (null: real time).
 */
async function inChrome({ size, query, outDir, args, what, onStdout, onStderr, budget = 4000 }, done) {
  if (!fs.existsSync(CHROME)) throw new Error(`Chrome isn't at ${CHROME} — set CHROME to its binary`);
  const [w, h] = size.split("x").map(Number);
  if (!w || !h) throw new Error(`--size wants WIDTHxHEIGHT, not "${size}"`);
  const dir = await buildPreview(outDir);
  const server = await new Promise((resolve) => {
    const s = serve(dir, 0, () => resolve(s));
  });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "mb-preview-chrome-"));
  const url = `http://localhost:${server.address().port}/?reset${query ? `&${query.replace(/^[?&]/, "")}` : ""}`;
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--user-data-dir=${profile}`,
      "--use-mock-keychain",
      "--password-store=basic",
      "--no-first-run",
      "--hide-scrollbars",
      `--window-size=${w},${h}`,
      // the fixtures answer after short delays; let them land
      ...(budget === null ? [] : [`--virtual-time-budget=${budget}`]),
      ...args,
      url,
    ],
    { stdio: ["ignore", onStdout ? "pipe" : "ignore", "pipe"] }
  );
  if (onStdout) chrome.stdout.on("data", (d) => onStdout(String(d)));
  // closed: exited, and its output read to the end
  let closed = false;
  chrome.once("close", () => (closed = true));
  let stderr = "";
  chrome.stderr.on("data", (d) => {
    stderr = (stderr + d).slice(-2000);
    onStderr?.(stderr);
  });
  try {
    const started = Date.now();
    for (;;) {
      if (await done(closed)) break;
      if (closed) throw new Error(`Chrome exited without ${what}: ${stderr.trim().split("\n").pop() ?? ""}`);
      if (Date.now() - started > 60_000) throw new Error(`Chrome took over a minute without ${what}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  } finally {
    await stopChild(chrome);
    server.close();
    await removeWhenLetGo(profile);
  }
}

/** A child stopped: asked, given `askMs`, then SIGKILLed, and waited for a little longer. */
export async function stopChild(child, { askMs = 10_000, killMs = 5_000 } = {}) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((r) => child.once("exit", r));
  const within = (ms) => Promise.race([exited.then(() => true), new Promise((r) => setTimeout(() => r(false), ms))]);
  child.kill();
  if (await within(askMs)) return;
  child.kill("SIGKILL");
  await within(killMs);
}

/**
 * Folder `dir` removed, trying for a while: Chrome's helper processes can still be writing to its profile after Chrome
 * has gone, under load for seconds. A folder that won't go is no failure of what used it: it's warned about, by name.
 * Whether it went.
 */
export async function removeWhenLetGo(dir, { attempts = 20, delayMs = 500, remove = (d) => fs.rmSync(d, { recursive: true, force: true }), warn = console.warn } = {}) {
  for (let i = 1; ; i++) {
    try {
      remove(dir);
      return true;
    } catch (err) {
      if (i >= attempts) {
        warn(`UI preview: couldn't remove ${dir} after ${attempts} tries: ${err.message}`);
        return false;
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const shot = arg("--shot");
  if (shot) {
    try {
      const file = await screenshot(shot, { size: arg("--size"), query: arg("--query") });
      console.log(`UI preview screenshot: ${file}`);
      process.exit(0);
    } catch (err) {
      console.error(`UI preview: ${err.message}`);
      process.exit(1);
    }
  }
  const port = Number(arg("--port") ?? process.env.PORT) || 5190;
  const dir = await watchPreview();
  serve(dir, port);
}
