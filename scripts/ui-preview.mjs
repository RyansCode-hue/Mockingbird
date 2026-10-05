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
  if (!fs.existsSync(CHROME)) throw new Error(`Chrome isn't at ${CHROME} — set CHROME to its binary`);
  const [w, h] = size.split("x").map(Number);
  if (!w || !h) throw new Error(`--size wants WIDTHxHEIGHT, not "${size}"`);
  const dir = await buildPreview(outDir);
  const server = await new Promise((resolve) => {
    const s = serve(dir, 0, () => resolve(s));
  });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "mb-preview-chrome-"));
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const url = `http://localhost:${server.address().port}/?reset&shot${query ? `&${query.replace(/^[?&]/, "")}` : ""}`;
  // Chrome writes the screenshot within seconds but can linger for minutes
  // before exiting, so the file decides when it's done, not the process
  fs.rmSync(target, { force: true });
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
      "--virtual-time-budget=4000", // the fixtures answer after short delays; let them land
      `--screenshot=${target}`,
      url,
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
  let stderr = "";
  chrome.stderr.on("data", (d) => (stderr = (stderr + d).slice(-2000)));
  try {
    await new Promise((resolve, reject) => {
      const started = Date.now();
      let lastSize = -1;
      const tick = setInterval(() => {
        const size = fs.existsSync(target) ? fs.statSync(target).size : -1;
        if (size > 0 && size === lastSize) {
          clearInterval(tick);
          return resolve();
        }
        lastSize = size;
        if (chrome.exitCode !== null && size <= 0) {
          clearInterval(tick);
          reject(new Error(`Chrome exited without the screenshot: ${stderr.trim().split("\n").pop() ?? ""}`));
        } else if (Date.now() - started > 60_000) {
          clearInterval(tick);
          reject(new Error("Chrome took over a minute without writing the screenshot"));
        }
      }, 250);
    });
  } finally {
    // the profile can only go once Chrome has let go of it
    if (chrome.exitCode === null) {
      const exited = new Promise((r) => chrome.once("exit", r));
      chrome.kill();
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    }
    server.close();
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  if (!fs.existsSync(target)) throw new Error("Chrome finished without writing the screenshot");
  return target;
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
