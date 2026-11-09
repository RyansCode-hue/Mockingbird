import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { knownSecretFiles, roomSecretReads, SECRET_FILE_GLOBS, SECRET_READS, secretPathspecs } from "../src/main/secrets";
import { snapshotCommit } from "../src/main/snapshots";
import { codexRoomPermissions } from "../src/main/codexRoomSandbox";
import { git, makeRepo, tempDir, write } from "./helpers";
import { ORDINARY, SECRETS, workTracker } from "./secretFixtures";

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

  it("keeps room agents out of Messages and Mail, which Full Disk Access for phone replies opens to everything Mockingbird runs", () => {
    const { rules } = roomSecretReads(tempDir("none"));
    expect(rules).toContain("Read(~/Library/Messages/**)");
    expect(rules).toContain("Read(~/Library/Mail/**)");
    const profile = codexRoomPermissions({ workTrackerPath: tempDir("none"), git: null, hooks: [] }).config.join("\n");
    expect(profile).toContain(`"~/Library/Messages"="deny"`);
    expect(profile).toContain(`"~/Library/Mail"="deny"`);
  });

  it("keeps room agents out of the artifacts this Mac's areas keep, which are no room's", () => {
    expect(roomSecretReads(tempDir("none")).rules).toContain("Read(~/.mockingbird/artifacts/areas/**)");
    const profile = codexRoomPermissions({ workTrackerPath: tempDir("none"), git: null, hooks: [] }).config.join("\n");
    expect(profile).toContain(`"~/.mockingbird/artifacts/areas"="deny"`);
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
    const secrets = secretPathspecs(repo, [patFile, "/elsewhere/ado.pat"]);
    const leftOut = (tree: string[]) => {
      for (const f of SECRETS) expect(tree, f).not.toContain(f);
      expect(tree).not.toContain("tools/WorkTracker/my-token.txt");
      for (const f of ORDINARY) expect(tree, f).toContain(f);
    };
    leftOut(git(repo, "ls-tree", "-r", "--name-only", (await snapshotCommit(repo, "backup", { secrets }))!.sha).split("\n"));
    // staged, they still stay out
    git(repo, "add", "-A");
    leftOut(git(repo, "ls-tree", "-r", "--name-only", (await snapshotCommit(repo, "backup", { secrets }))!.sha).split("\n"));
    // a known file outside the repository adds nothing
    expect(secretPathspecs(repo, ["/elsewhere/ado.pat"])).toHaveLength(SECRET_FILE_GLOBS.length);
  });

  it("stays out of a backup staged before the repository's first commit", async () => {
    const repo = path.join(tempDir("code"), "fresh");
    fs.mkdirSync(repo);
    git(repo, "init", "-q");
    write(repo, { ".env": "TOKEN=x\n", "src/app.ts": "app\n" });
    git(repo, "add", "-A");
    const snap = await snapshotCommit(repo, "backup", { secrets: secretPathspecs(repo) });
    expect(snap!.parent).toBeNull();
    expect(git(repo, "ls-tree", "-r", "--name-only", snap!.sha).split("\n")).toEqual(["src/app.ts"]);
    expect(git(repo, "status", "--porcelain").split("\n")).toEqual(["A  .env", "A  src/app.ts"]);
  });
});

describe("the MCP servers' token folder", () => {
  it("is denied to room agents' file tools, and to a Codex room's sandbox, by path", async () => {
    const { HOME_SECRETS, roomSecretReads } = await import("../src/main/secrets");
    expect(HOME_SECRETS).toContain("~/.mockingbird/mcp-tokens/**");
    expect(roomSecretReads("/no/such/worktracker").rules).toContain("Read(~/.mockingbird/mcp-tokens/**)");
    const { codexRoomPermissions } = await import("../src/main/codexRoomSandbox");
    const { config } = codexRoomPermissions({ workTrackerPath: "/no/such/worktracker", git: null, hooks: [] } as any);
    expect(config.join(" ")).toContain('"~/.mockingbird/mcp-tokens"="deny"');
  });
  it("is one of this Mac's credential stores, so a room artifact added from it is asked about", async () => {
    const os = await import("os");
    const path = await import("path");
    const { homeSecretPlace } = await import("../src/main/secrets");
    expect(homeSecretPlace(path.join(os.homedir(), ".mockingbird", "mcp-tokens", "abc"))).toBe("~/.mockingbird/mcp-tokens/**");
  });
});
