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
const letter = (c, shift = false) => ({ key: shift ? c.toUpperCase() : c, code: `Key${c.toUpperCase()}`, keyCode: c.toUpperCase().charCodeAt(0), text: shift ? c.toUpperCase() : c });
const KEYS = {
  ...Object.fromEntries([..."abcdefghijklmnopqrstuvwxyz"].flatMap((c) => [[c, letter(c)], [c.toUpperCase(), letter(c, true)]])),
  0: { key: "0", code: "Digit0", keyCode: 48, text: "0" },
  1: { key: "1", code: "Digit1", keyCode: 49, text: "1" },
  "=": { key: "=", code: "Equal", keyCode: 187, text: "=" },
  "-": { key: "-", code: "Minus", keyCode: 189, text: "-" },
  "?": { key: "?", code: "Slash", keyCode: 191, text: "?" },
  "\\": { key: "\\", code: "Backslash", keyCode: 220, text: "\\" },
  " ": { key: " ", code: "Space", keyCode: 32, text: " " },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
  Shift: { key: "Shift", code: "ShiftLeft", keyCode: 16 },
};

/**
 * Press, for real, the keys and the mouse the page asked for: it pushes { key, shift?, meta?, alt?, ctrl?, hold?, repeat? }
 * (hold: "down" or "up", only that half of the press; repeat: the key held, as the keyboard repeats it),{ mouse: { x, y, clickCount, button?, shift? } } (clickCount 2: a double
 * click's second), { move: { x, y } }, { wheel: { x, y, dx, dy, meta?, ctrl? } } or { drag: { x0, y0, x1, y1, hold? } } onto
 * window.__mbKeys, or { pause: ms } between two of them, and window.__mbKeysDone counts the ones done. They reach whatever has the keyboard or is under the
 * pointer, as a person's would, which an event dispatched at an element can't show.
 */
async function pressAsked(ask) {
  const asked = await ask("Runtime.evaluate", { expression: "JSON.stringify((window.__mbKeys || []).splice(0))", returnByValue: true });
  const keys = JSON.parse(asked?.result?.value ?? "[]");
  for (const k of keys) {
    const mods = (o) => (o.alt ? 1 : 0) | (o.ctrl ? 2 : 0) | (o.meta ? 4 : 0) | (o.shift ? 8 : 0);
    if (k.mouse) {
      const { x, y, clickCount, button = "left" } = k.mouse;
      const held = button === "right" ? 2 : button === "middle" ? 4 : 1;
      const modifiers = mods(k.mouse);
      await ask("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers });
      await ask("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, buttons: held, clickCount, modifiers });
      await ask("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, buttons: 0, clickCount, modifiers });
      continue;
    }
    if (k.move) {
      await ask("Input.dispatchMouseEvent", { type: "mouseMoved", x: k.move.x, y: k.move.y });
      continue;
    }
    if (k.pause) {
      await new Promise((r) => setTimeout(r, k.pause));
      continue;
    }
    if (k.wheel) {
      const { x, y, dx = 0, dy = 0 } = k.wheel;
      await ask("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: dx, deltaY: dy, modifiers: mods(k.wheel) });
      continue;
    }
    if (k.drag) {
      // hold "down": pressed and moved, not let go (a later { drag, hold: "up" } lets go there); "up": only the letting go
      const { x0, y0, x1, y1, hold } = k.drag;
      if (hold !== "up") {
        await ask("Input.dispatchMouseEvent", { type: "mouseMoved", x: x0, y: y0 });
        await ask("Input.dispatchMouseEvent", { type: "mousePressed", x: x0, y: y0, button: "left", buttons: 1, clickCount: 1 });
        for (const f of [0.25, 0.5, 0.75, 1]) await ask("Input.dispatchMouseEvent", { type: "mouseMoved", x: x0 + (x1 - x0) * f, y: y0 + (y1 - y0) * f, button: "left", buttons: 1 });
      }
      if (hold !== "down") await ask("Input.dispatchMouseEvent", { type: "mouseReleased", x: x1, y: y1, button: "left", buttons: 0, clickCount: 1 });
      continue;
    }
    const d = KEYS[k.key];
    if (!d) throw new Error(`the page asked for a key this driver doesn't press: ${k.key}`);
    const modifiers = mods(k);
    const typed = d.text && !k.meta && !k.ctrl && !k.alt;
    // No native key code: given one, Chrome builds an OS key event and hands the browser any key the page didn't
    // consume, and on macOS AppKit answers a typed key nothing takes (a letter or Enter on no field) with the alert
    // sound. Without one, the key reaches the page just the same and ends there (DevTools' skip_if_unhandled).
    // test/uiNoAlertSound.test.ts holds every driver to this.
    const base = { modifiers, key: d.key, code: d.code, windowsVirtualKeyCode: d.keyCode, ...(k.repeat ? { autoRepeat: true } : {}) };
    if (k.hold !== "up") await ask("Input.dispatchKeyEvent", { type: typed ? "keyDown" : "rawKeyDown", ...base, ...(typed ? { text: d.text, unmodifiedText: d.text } : {}) });
    if (k.hold !== "down") await ask("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }
  if (keys.length) await ask("Runtime.evaluate", { expression: `window.__mbKeysDone = (window.__mbKeysDone || 0) + ${keys.length}` });
}

/** How long one DevTools call gets before the run fails naming it. */
const ASK_MS = 20_000;

/** `limitMs`: how long Chrome gets to have the result (an audit that drives a lot, longer). `onChrome`: told Chrome's pid once it's started. */
export async function pageResult({ size = "1400x900", query = "", outDir, read, scale = null, limitMs = 60_000, onChrome }) {
  let devtools = null;
  let result = null;
  let ws = null;
  let id = 0;
  // Chrome's whole answer ({ result } or { error }); a call it never answers fails by name rather than leaving the run
  // to time out saying nothing
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      const timer = setTimeout(() => {
        ws.removeEventListener("message", on);
        reject(new Error(`Chrome didn't answer ${method} ${JSON.stringify(params ?? {}).slice(0, 160)} within ${ASK_MS / 1000} s`));
      }, ASK_MS);
      const on = (e) => {
        const m = JSON.parse(String(e.data));
        if (m.id !== n) return;
        clearTimeout(timer);
        ws.removeEventListener("message", on);
        resolve(m);
      };
      ws.addEventListener("message", on);
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  // its result: none for a call refused while the page is still loading, polled again next time round
  const ask = async (method, params) => (await call(method, params)).result;
  /** A JS dialog the page opened (it holds up every call until it's answered). */
  let dialog = null;
  /** Whether the page still answers, and where its keyboard is: said with a call that stalled. */
  const alive = async () => {
    const probe = call("Runtime.evaluate", {
      expression:
        "`visible: ${document.visibilityState}, focus: ${document.hasFocus()}, keyboard: ${document.activeElement?.className || document.activeElement?.tagName}, keys asked ${(window.__mbKeys || []).length} / done ${window.__mbKeysDone || 0}, so far: ${JSON.stringify(window.__mbAuditOut ?? null)?.slice(0, 600)}`",
      returnByValue: true,
    });
    const r = await Promise.race([probe.then((m) => m.result?.result?.value ?? "no value"), new Promise((r) => setTimeout(() => r(null), 3000))]);
    return r === null ? "the page doesn't answer either" : `the page answers (${r})`;
  };
  // when the page was first reached: the stall report below runs from about when inChrome's time-out does
  let started = Infinity;
  try {
    await inChrome({ size, query, outDir, budget: null, limitMs, onChrome, args: ["--remote-debugging-port=0", ...(scale ? [`--force-device-scale-factor=${scale}`] : [])], what: "the page's result", onStderr: (text) => (devtools ??= text.match(/DevTools listening on (ws:\/\/\S+)/)?.[1] ?? null) }, async () => {
      if (!devtools) return false;
      if (!ws) {
        const pages = await (await fetch(`http://127.0.0.1:${new URL(devtools).port}/json`)).json();
        const page = pages.find((t) => t.type === "page" && t.url.startsWith("http://localhost"));
        if (!page) return false;
        started = Date.now();
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((r, j) => {
          ws.addEventListener("open", r, { once: true });
          ws.addEventListener("error", j, { once: true });
        });
        ws.addEventListener("message", (e) => {
          const m = JSON.parse(String(e.data));
          if (m.method === "Page.javascriptDialogOpening") dialog = `${m.params.type} dialog ("${String(m.params.message).slice(0, 120)}")`;
        });
        await call("Page.enable", {});
        // The page keeps the window's focus whatever is pressed: headless Chrome otherwise hides it on Esc (its timers
        // slow to about a second each and its animation frames stop) and blurs the window, which closes popovers and
        // menus on its own, so an Esc the app ignored would still look handled
        const emulated = await call("Emulation.setFocusEmulationEnabled", { enabled: true });
        if (emulated.error) throw new Error(`Chrome refused focus emulation, which the driver's keys need: ${emulated.error.message}`);
      }
      try {
        await pressAsked(ask);
        const r = await ask("Runtime.evaluate", { expression: read, returnByValue: true });
        result = r?.result?.value ?? null;
      } catch (err) {
        throw new Error(`${err.message}${dialog ? `; the page had opened a ${dialog}` : ""}; ${await alive()}`);
      }
      if (dialog) throw new Error(`the page opened a ${dialog}`);
      // about to run out of time: say where the page is, which the bare time-out can't
      if (result === null && Date.now() - started > limitMs - 3000) throw new Error(`no result in ${Math.round(limitMs / 1000)} s; ${await alive()}`);
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
async function inChrome({ size, query, outDir, args, what, onStdout, onStderr, onChrome, budget = 4000, limitMs = 60_000 }, done) {
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
  onChrome?.(chrome.pid);
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
      if (Date.now() - started > limitMs) throw new Error(`Chrome took over ${Math.round(limitMs / 1000)} s without ${what}`);
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
