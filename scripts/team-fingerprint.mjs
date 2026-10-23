// This install's team-rooms fingerprint, without the app:
//
//   npm run team:fingerprint
//
// Reads ~/.mockingbird/team/identity.json's public key, or creates the file
// as the app would without the Keychain (an Ed25519 key, owner-only; the app
// seals the private key into the Keychain when it next starts), and prints
// the fingerprint and the command that lets it create rooms on the signaling
// Worker (signaling/README.md). The private key is never opened or printed.
//
//   npm run team:e2e-fingerprint
//
// The same for the two-instance tests' room creator, whose identity is kept
// under $TMPDIR/mockingbird-e2e-creator (E2E_CREATOR_HOME in
// test/e2e/appInstance.ts): allow it on a Worker to run those tests against
// it (MB_E2E_SIGNALING_URL).
import * as esbuild from "esbuild";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(os.tmpdir(), `mockingbird-team-fingerprint-${process.pid}.mjs`);
await esbuild.build({
  stdin: {
    contents: 'export { readPublicIdentity, TEAM_DIR } from "./src/main/team/identity";\nexport { formatFingerprint, allowCreatorsCommand } from "./src/shared/team/protocol";\n',
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
  const { readPublicIdentity, TEAM_DIR, formatFingerprint, allowCreatorsCommand } = await import(pathToFileURL(out).href);
  const e2e = process.argv.includes("--e2e");
  const dir = e2e ? path.join(os.tmpdir(), "mockingbird-e2e-creator", ".mockingbird", "team") : TEAM_DIR;
  const existed = fs.existsSync(path.join(dir, "identity.json"));
  const id = readPublicIdentity(dir);
  console.log(`${e2e ? "The e2e tests' room creator's" : "This Mockingbird's"} team fingerprint: ${formatFingerprint(id.id)}`);
  console.log(existed ? `(from ${path.join(dir, "identity.json")})` : `(new: ${path.join(dir, "identity.json")} — the ${e2e ? "tests use" : "app uses"} this same key)`);
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
