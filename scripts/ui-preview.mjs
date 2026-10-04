// The UI preview: the real interface running in a browser against fixture
// data (src/preview/stub.ts) instead of the main process. For looking at and
// clicking through UI changes without the app, from any session or by hand.
//
//   npm run ui-preview            build, serve on http://localhost:5190, and
//                                 rebuild on every source change (reload the page)
//   npm run ui-preview -- --port 5300
//   open http://localhost:5190/?reset to start again from the fixtures
import * as esbuild from "esbuild";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
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

function serve(dir, port) {
  http
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
    .listen(port, "127.0.0.1", () => console.log(`UI preview: http://localhost:${port}  (?reset starts from the fixtures; Ctrl-C to stop)`))
    .on("error", (err) => {
      console.error(`UI preview couldn't listen on port ${port}: ${err.message}`);
      process.exit(1);
    });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--port");
  const port = Number(i > 0 ? process.argv[i + 1] : process.env.PORT) || 5190;
  const dir = await watchPreview();
  serve(dir, port);
}
