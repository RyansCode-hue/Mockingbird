import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { CODEX_ROOM_PROFILE, codexRoomPermissions, knownSecretFiles, roomSecretReads, SECRET_FILE_GLOBS, SECRET_READS, secretPathspecs } from "../src/main/secrets";
import { agentFor, cliVersion } from "../src/main/agents";
import { quote } from "../src/main/shell";
import { CODEX_ROOM_GUARD_SINCE, codexGuardsSecrets } from "../src/shared/team/livePanes";
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

describe("a Codex room session's permission profile", () => {
  const profileOf = (config: string[]) => config.find((c) => c.startsWith(`permissions.${CODEX_ROOM_PROFILE}=`))!;

  it("is selected per launch and built from the secret file list: in the session's folders, anywhere on disk but certificate bundles, home credentials and the ADO PAT file", () => {
    const wt = workTracker("secrets/ado.pat");
    const { config, problem } = codexRoomPermissions(wt);
    expect(problem).toBeNull();
    expect(config[0]).toBe(`default_permissions="${CODEX_ROOM_PROFILE}"`);
    const profile = profileOf(config);
    expect(profile).toContain(`extends=":workspace"`);
    expect(profile).toContain("network={enabled=true}");
    for (const g of SECRET_FILE_GLOBS) expect(profile).toContain(`"**/${g}"="deny"`);
    for (const g of SECRET_FILE_GLOBS.filter((g) => g !== "*.pem")) expect(profile).toContain(`"/**/${g}"="deny"`);
    expect(profile).not.toContain(`"/**/*.pem"`);
    for (const p of ["~/.ssh", "~/.aws", "~/.config/gh", "~/.netrc", "~/.git-credentials", "~/.mockingbird/team"]) expect(profile).toContain(`"${p}"="deny"`);
    expect(profile).toContain(`${JSON.stringify(path.join(wt, "secrets/ado.pat"))}="deny"`);
  });

  it("says when the PAT file can't be worked out, and still denies everything else", () => {
    const wt = tempDir("worktracker");
    fs.writeFileSync(path.join(wt, "config.json"), "{ not json");
    const { config, problem } = codexRoomPermissions(wt);
    expect(problem).toMatch(/Azure DevOps PAT file/);
    expect(profileOf(config)).toContain(`"**/.env"="deny"`);
  });

  it("is used from the first Codex release whose permission profiles hold it", () => {
    expect(codexGuardsSecrets(CODEX_ROOM_GUARD_SINCE)).toBe(true);
    expect(codexGuardsSecrets("0.156.1")).toBe(true);
    expect(codexGuardsSecrets("1.0.0")).toBe(true);
    expect(codexGuardsSecrets("0.137.9")).toBe(false);
    expect(codexGuardsSecrets("0.99.0")).toBe(false);
    expect(codexGuardsSecrets(null)).toBe(false);
    expect(codexGuardsSecrets(undefined)).toBe(false);
  });

  // The real binary, without a model: `codex sandbox` runs a command under the
  // permission profile the same -c settings select for a session.
  const codexVersion = (() => {
    try {
      return cliVersion(execFileSync("codex", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 20_000 }));
    } catch {
      return null; // not installed: the test below is skipped
    }
  })();
  it.skipIf(!!process.env.CI || !codexGuardsSecrets(codexVersion))("keeps the installed Codex from reading secret files while ordinary ones stay readable", () => {
    const repo = makeRepo(Object.fromEntries([...SECRETS, ...ORDINARY].map((f) => [f, `${f}\n`])));
    const wt = workTracker("secrets/ado.pat");
    write(wt, { "secrets/ado.pat": "pat\n" });
    const elsewhere = tempDir("other-repo");
    write(elsewhere, { ".env": "OTHER=1\n", "server.key": "key\n", "notes.md": "notes\n" });
    write(os.homedir(), { ".ssh/id_ed25519": "key\n", ".mockingbird/team/identity.json": "{}\n" });
    const denied = [
      ...SECRETS,
      path.join(wt, "secrets/ado.pat"),
      path.join(elsewhere, ".env"),
      path.join(elsewhere, "server.key"),
      path.join(os.homedir(), ".ssh/id_ed25519"),
      path.join(os.homedir(), ".mockingbird/team/identity.json"),
    ];
    // certificate bundles stay readable outside the session's folders, or TLS breaks
    const readable = [...ORDINARY, path.join(elsewhere, "notes.md"), ...(fs.existsSync("/etc/ssl/cert.pem") ? ["/etc/ssl/cert.pem"] : [])];
    const probe = `for f; do if cat "$f" >/dev/null 2>&1; then echo "read $f"; else echo "denied $f"; fi; done; echo x > written.txt && echo wrote`;
    // the settings as a room launch passes them: through the Codex adapter, quoted for the pane's shell
    const settings = agentFor("codex").launchArgs({ repoPath: null, useWorktree: false }, { codexPermissions: codexRoomPermissions(wt).config });
    const cmd = ["codex", "sandbox", ...settings, "--", "sh", "-c", probe, "sh", ...denied, ...readable].map(quote).join(" ");
    const out = execFileSync("/bin/zsh", ["-c", cmd], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, CODEX_HOME: tempDir("codex-home") },
      timeout: 60_000,
    });
    for (const f of denied) expect(out, f).toContain(`denied ${f}\n`);
    for (const f of readable) expect(out, f).toContain(`read ${f}\n`);
    expect(out).toContain("wrote");
  }, 90_000);
});
