// The local signaling server (signaling/src/local), bundled and run:
//
//   npm run team:signaling                 http://127.0.0.1:8787
//   npm run team:signaling -- --port 9000 --stun
//
// For two Mockingbird dev instances on one Mac; the deployed signaling is the
// Cloudflare Worker (signaling/README.md).
import * as esbuild from "esbuild";
import * as os from "os";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(os.tmpdir(), `mockingbird-local-signaling-${process.pid}.mjs`);
await esbuild.build({
  entryPoints: [path.join(root, "signaling/src/local/main.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: out,
  logLevel: "error",
});
await import(pathToFileURL(out).href);
