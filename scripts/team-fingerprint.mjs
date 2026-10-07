// This install's team-rooms fingerprint, without the app:
//
//   npm run team:fingerprint
//
// Reads ~/.mockingbird/team/identity.json, or creates it exactly as the app
// would (an Ed25519 key, owner-only), and prints the fingerprint and the
// command that lets it create rooms on the signaling Worker
// (signaling/README.md). The private key is never printed.
import * as esbuild from "esbuild";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(os.tmpdir(), `mockingbird-team-fingerprint-${process.pid}.mjs`);
await esbuild.build({
  stdin: {
    contents: 'export { loadIdentity, TEAM_DIR } from "./src/main/team/identity";\nexport { formatFingerprint, allowCreatorsCommand } from "./src/shared/team/protocol";\n',
    resolveDir: root,
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: out,
  logLevel: "error",
});
try {
  const { loadIdentity, TEAM_DIR, formatFingerprint, allowCreatorsCommand } = await import(pathToFileURL(out).href);
  const existed = fs.existsSync(path.join(TEAM_DIR, "identity.json"));
  const id = loadIdentity(TEAM_DIR);
  console.log(`This Mockingbird's team fingerprint: ${formatFingerprint(id.id)}`);
  console.log(existed ? `(from ${path.join(TEAM_DIR, "identity.json")})` : `(new: ${path.join(TEAM_DIR, "identity.json")} — the app uses this same key)`);
  console.log("");
  console.log("To let it create rooms on your signaling Worker (list every creator's fingerprint,");
  console.log("comma-separated: the secret is replaced each time):");
  console.log(`  ${allowCreatorsCommand([id.id])}`);
} catch (err) {
  console.error(`Couldn't read or create the team identity: ${err.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(out, { force: true });
}
