import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { knownSecretFiles, roomSecretReads, SECRET_FILE_GLOBS, SECRET_READS, secretPathspecs } from "../src/main/secrets";
import { snapshotCommit } from "../src/main/snapshots";
import { git, makeRepo, tempDir, write } from "./helpers";

/** Secret files as they turn up in repositories, at the top and deeper. */
const SECRETS = [
  ".env",
  ".env.local",
  "api/.env.production",
  "config/dev.env",
  "certs/server.pem",
  "certs/server.key",
  "certs/client.pfx",
  "certs/client.p12",
  "credentials.json",
  "gcp/credentials.json",
  "secrets.json",
  "Functions/local.settings.json",
  "ado.pat",
  "tools/ado_pat.txt",
  "tools/azure-pat.txt",
  "pat.txt",
];
/** Files that look close but are ordinary work: a backup must carry them. */
const ORDINARY = ["src/env.ts", "src/keys.ts", "docs/compatibility.txt", "patterns.txt", "src/credentials.ts", "settings.json", "README.md"];

function workTracker(patFile: string): string {
  const wt = tempDir("worktracker");
  fs.writeFileSync(path.join(wt, "config.json"), JSON.stringify({ azureDevOps: { orgUrl: "https://dev.azure.com/acme", project: "P", patFile } }));
  return wt;
}

describe("the secret file list", () => {
  it("is where Claude's deny rules come from: relative, anywhere on disk, home credentials and the ADO PAT file", () => {
    for (const g of SECRET_FILE_GLOBS) expect(SECRET_READS).toContain(`Read(**/${g})`);
    expect(SECRET_READS).toHaveLength(SECRET_FILE_GLOBS.length);
    const wt = workTracker("secrets/ado.pat");
    const { rules, problem } = roomSecretReads(wt);
    expect(problem).toBeNull();
    for (const g of SECRET_FILE_GLOBS) {
      expect(rules).toContain(`Read(**/${g})`);
      expect(rules).toContain(`Read(//**/${g})`);
    }
    for (const g of [".env", ".env.*", "*.pem", "*.key", "credentials.json", "*.pat"]) expect(SECRET_FILE_GLOBS).toContain(g);
    expect(rules).toContain(`Read(/${path.join(wt, "secrets/ado.pat")})`);
    expect(rules).toContain("Read(~/.ssh/**)");
    expect(rules).toContain("Read(~/.mockingbird/team/**)");
  });

  it("says when the PAT file can't be worked out, and still denies everything else", () => {
    const wt = tempDir("worktracker");
    fs.writeFileSync(path.join(wt, "config.json"), "{ not json");
    const { rules, problem } = roomSecretReads(wt);
    expect(problem).toMatch(/Azure DevOps PAT file/);
    for (const r of SECRET_READS) expect(rules).toContain(r);
    expect(knownSecretFiles(tempDir("none"))).toEqual({ files: [], problem: null });
  });

  it("is what a room backup leaves out — by name at any depth, and the PAT file by path — while ordinary files go", async () => {
    const repo = makeRepo({ "README.md": "hi\n" });
    write(repo, Object.fromEntries([...SECRETS, ...ORDINARY.filter((f) => f !== "README.md"), "tools/WorkTracker/my-token.txt"].map((f) => [f, `${f}\n`])));
    const patFile = path.join(repo, "tools/WorkTracker/my-token.txt"); // the PAT file WorkTracker's config names, inside this repository
    const snap = await snapshotCommit(repo, "backup", { exclude: secretPathspecs(repo, [patFile, "/elsewhere/ado.pat"]) });
    const tree = git(repo, "ls-tree", "-r", "--name-only", snap!.sha).split("\n");
    for (const f of SECRETS) expect(tree, f).not.toContain(f);
    expect(tree).not.toContain("tools/WorkTracker/my-token.txt");
    for (const f of ORDINARY) expect(tree, f).toContain(f);
    // a known file outside the repository adds nothing
    expect(secretPathspecs(repo, ["/elsewhere/ado.pat"])).toHaveLength(SECRET_FILE_GLOBS.length);
  });
});
