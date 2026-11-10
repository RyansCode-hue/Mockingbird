import { execFileSync, spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CODEX_ROOM_PROFILE, codexHomeOf, codexRoomPermissions, roomGitDirs, type CodexRoomPlaces } from "../src/main/codexRoomSandbox";
import { SECRET_FILE_GLOBS } from "../src/main/secrets";
import { agentFor, cliVersion } from "../src/main/agents";
import { quote } from "../src/main/shell";
import { ensureHooks, hooksEnv } from "../src/main/team/coauthors";
import { CODEX_ROOM_GUARD_SINCE, codexGuardsSecrets } from "../src/shared/team/livePanes";
import { git, makeRepo, tempDir, write } from "./helpers";
import { ORDINARY, SECRETS, workTracker } from "./secretFixtures";

const profileOf = (config: string[]) => config.find((c) => c.startsWith(`permissions.${CODEX_ROOM_PROFILE}=`))!;
const home = (p: string) => path.join(os.homedir(), p);

/** Where a room session's Codex runs: its WorkTracker, repository and the co-author hooks, as livePanes passes them. */
function places(over: Partial<CodexRoomPlaces> = {}): CodexRoomPlaces {
  return { workTrackerPath: workTracker("secrets/ado.pat"), git: null, hooks: [home(".mockingbird/team/githooks"), home(".mockingbird/team/coauthors")], ...over };
}

describe("a Codex room session's permission profile", () => {
  it("is selected per launch and denies the secret file list: in the session's folders, anywhere on disk but certificate bundles, home credentials, logins, Messages, Mail and the ADO PAT file", () => {
    const p = places({ codexHome: "/elsewhere/codex" });
    const { config, problem } = codexRoomPermissions(p);
    expect(problem).toBeNull();
    expect(config[0]).toBe(`default_permissions="${CODEX_ROOM_PROFILE}"`);
    const profile = profileOf(config);
    expect(profile).toContain(`extends=":workspace"`);
    // the network through Codex's proxy, which keeps Unix sockets (an SSH agent, Docker) closed
    expect(config).toContain("features.network_proxy=true");
    expect(profile).toContain(`network={enabled=true, domains={"*"="allow"}, allow_local_binding=true}`);
    for (const g of SECRET_FILE_GLOBS) expect(profile).toContain(`"**/${g}"="deny"`);
    for (const g of SECRET_FILE_GLOBS.filter((g) => g !== "*.pem")) expect(profile).toContain(`"/**/${g}"="deny"`);
    expect(profile).not.toContain(`"/**/*.pem"`);
    for (const x of ["~/.ssh", "~/.aws", "~/.config/gh", "~/.netrc", "~/.git-credentials", "~/.mockingbird/team", "~/Library/Keychains", "~/Library/Messages", "~/Library/Mail", "~/.codex/auth.json", "/elsewhere/codex/auth.json"]) {
      expect(profile).toContain(`"${x}"="deny"`);
    }
    expect(profile).toContain(`${JSON.stringify(path.join(p.workTrackerPath, "secrets/ado.pat"))}="deny"`);
    // the co-author hooks inside the denied team folder stay readable
    for (const h of p.hooks) expect(profile).toContain(`${JSON.stringify(h)}="read"`);
  });

  it("lets the session write its repository's git data and the room's own caches, but not git config, hooks, attributes, another worktree's pointers or home's caches", () => {
    const profile = profileOf(codexRoomPermissions(places({ git: { common: "/r/.git", own: "/r/.git/worktrees/wt" }, caches: "/c/rooms/r1" })).config);
    for (const w of ["/r/.git", "/r/.git/worktrees/wt", "/c/rooms/r1"]) expect(profile).toContain(`"${w}"="write"`);
    for (const w of ["~/.npm", "~/Library/Caches", "~/.cache", "~/go/pkg", "~/.nuget/packages", "~/.cargo/registry"]) expect(profile).not.toContain(`"${w}"="write"`);
    for (const r of ["config", "hooks", "modules", "worktrees", "info/attributes", "worktrees/wt/config.worktree", "worktrees/wt/commondir", "worktrees/wt/gitdir"]) expect(profile).toContain(`"/r/.git/${r}"="read"`);
    // no folder on PATH
    for (const bin of ["~/.yarn\"", "~/go\"", "~/.cargo\"", "~/.dotnet", "~/.local/bin", "~/Library/pnpm\""]) expect(profile).not.toContain(bin);
    // a main checkout: one git folder
    const main = profileOf(codexRoomPermissions(places({ git: { common: "/r/.git", own: "/r/.git" } })).config);
    expect(main).toContain(`"/r/.git"="write"`);
    expect(main).not.toContain("commondir");
    // outside a repository nothing of git's is writable
    expect(profileOf(codexRoomPermissions(places()).config)).not.toContain(`.git"="write"`);
  });

  it("says when the PAT file can't be worked out, and still denies everything else", () => {
    const wt = tempDir("worktracker");
    fs.writeFileSync(path.join(wt, "config.json"), "{ not json");
    const { config, problem } = codexRoomPermissions(places({ workTrackerPath: wt }));
    expect(problem).toMatch(/Azure DevOps PAT file/);
    expect(profileOf(config)).toContain(`"**/.env"="deny"`);
  });

  it("finds a repository's git folders, a worktree's own too", async () => {
    const repo = makeRepo();
    const wt = path.join(tempDir("wt"), "feature");
    git(repo, "worktree", "add", "-q", "-b", "feature", wt);
    const common = fs.realpathSync(path.join(repo, ".git"));
    const real = async (cwd: string) => {
      const d = (await roomGitDirs(cwd))!;
      return { common: fs.realpathSync(d.common), own: fs.realpathSync(d.own) };
    };
    expect(await real(repo)).toEqual({ common, own: common });
    expect(await real(wt)).toEqual({ common, own: path.join(common, "worktrees", "feature") });
    expect(await roomGitDirs(tempDir("plain"))).toBeNull();
  });

  it("names CODEX_HOME only when it isn't ~/.codex", () => {
    expect(codexHomeOf({})).toBeUndefined();
    expect(codexHomeOf({ CODEX_HOME: home(".codex") })).toBeUndefined();
    expect(codexHomeOf({ CODEX_HOME: "/elsewhere/codex" })).toBe("/elsewhere/codex");
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
});

// The real binary, without a model: `codex sandbox` runs a command under the
// permission profile the same -c settings select for a session.
const codexVersion = (() => {
  try {
    return cliVersion(execFileSync("codex", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 20_000 }));
  } catch {
    return null; // not installed: these are skipped
  }
})();
const realCodex = !process.env.CI && codexGuardsSecrets(codexVersion);

/**
 * Folders outside the temp folders, which the room's sandbox lets every
 * command write (this file's throwaway HOME is one): a write refused here was
 * refused by the profile. out/ is git-ignored.
 */
let scratch = "";
const outsideTmp = (name: string) => fs.mkdtempSync(path.join(scratch, `${name}-`));

/** A command under the room's settings as a room launch passes them: through the Codex adapter, quoted for the pane's shell. */
function inRoomSandbox(o: { cwd: string; places: CodexRoomPlaces; home: string; script: string; args?: string[]; env?: Record<string, string> }): Promise<string> {
  const settings = agentFor("codex").launchArgs({ repoPath: null, useWorktree: false }, { codexPermissions: codexRoomPermissions(o.places).config });
  const cmd = ["codex", "sandbox", ...settings, "--", "sh", "-c", o.script, "sh", ...(o.args ?? [])].map(quote).join(" ");
  // npm runs these tests with npm_config_* naming the real ~/.npm
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_/i.test(k)));
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/zsh", ["-c", cmd], { cwd: o.cwd, env: { ...env, HOME: o.home, CODEX_HOME: tempDir("codex-home"), ...o.env } });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("close", () => resolve(out));
  });
}

describe.skipIf(!realCodex)("the installed Codex in a room session's sandbox", () => {
  beforeAll(() => {
    const root = path.resolve("out", "sandbox-tests");
    fs.mkdirSync(root, { recursive: true });
    scratch = fs.mkdtempSync(path.join(root, "run-"));
  });
  afterAll(() => {
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("can't read secret files, logins, Messages or Mail, while ordinary files and certificate bundles stay readable", async () => {
    const home = outsideTmp("home");
    const repo = makeRepo(Object.fromEntries([...SECRETS, ...ORDINARY].map((f) => [f, `${f}\n`])));
    const hooks = [path.join(home, ".mockingbird/team/githooks"), path.join(home, ".mockingbird/team/coauthors")];
    const codexHome = outsideTmp("codex-elsewhere");
    const p = places({ git: { common: path.join(repo, ".git"), own: path.join(repo, ".git") }, hooks, codexHome });
    write(p.workTrackerPath, { "secrets/ado.pat": "pat\n" });
    const elsewhere = outsideTmp("other-repo");
    write(elsewhere, { ".env": "OTHER=1\n", "server.key": "key\n", "notes.md": "notes\n" });
    write(codexHome, { "auth.json": "{}\n" });
    const inHome = [".ssh/id_ed25519", ".git-credentials", ".config/git/credentials", ".config/gh/hosts.yml", ".aws/credentials", ".netrc", ".codex/auth.json", "Library/Keychains/login.keychain-db", "Library/Messages/chat.db", "Library/Mail/V10/MailData/Envelope Index", ".mockingbird/team/identity.json"];
    write(home, { ...Object.fromEntries(inHome.map((f) => [f, "secret\n"])), ".mockingbird/team/githooks/pre-commit": "#!/bin/sh\n", ".mockingbird/team/coauthors/s1": "Nick\n" });
    const denied = [...SECRETS, path.join(p.workTrackerPath, "secrets/ado.pat"), path.join(elsewhere, ".env"), path.join(elsewhere, "server.key"), path.join(codexHome, "auth.json"), ...inHome.map((f) => path.join(home, f))];
    const readable = [
      ...ORDINARY,
      path.join(elsewhere, "notes.md"),
      path.join(home, ".mockingbird/team/githooks/pre-commit"),
      path.join(home, ".mockingbird/team/coauthors/s1"),
      ...(fs.existsSync("/etc/ssl/cert.pem") ? ["/etc/ssl/cert.pem"] : []),
    ];
    const script = `for f; do if cat "$f" >/dev/null 2>&1; then echo "read $f"; else echo "denied $f"; fi; done`;
    const out = await inRoomSandbox({ cwd: repo, places: p, home, script, args: [...denied, ...readable] });
    for (const f of denied) expect(out, f).toContain(`denied ${f}\n`);
    for (const f of readable) expect(out, f).toContain(`read ${f}\n`);
  }, 120_000);

  it("commits (with co-author trailers), stashes, fetches, installs and reaches local services in a worktree, but can't push or change git config, hooks or pointers", async () => {
    const home = outsideTmp("home");
    const repo = makeRepo({ "README.md": "hello\n" }, "repo", outsideTmp("code"));
    const remote = path.join(outsideTmp("remote"), "origin.git");
    execFileSync("git", ["init", "-q", "--bare", remote]);
    git(repo, "remote", "add", "origin", remote);
    git(repo, "push", "-q", "origin", "main");
    const wt = path.join(outsideTmp("wt"), "feature");
    git(repo, "worktree", "add", "-q", "-b", "feature", wt);
    // a project to install into (npm would otherwise climb to this checkout's), and a home with the folders a Mac's has
    write(wt, { "package.json": JSON.stringify({ name: "app", version: "1.0.0", private: true }) });
    fs.mkdirSync(path.join(home, "Library/Caches"), { recursive: true });
    // a package installed from a local tarball: npm needs its cache, not the registry
    const pkg = outsideTmp("pkg");
    write(pkg, { "package/package.json": JSON.stringify({ name: "tiny-local", version: "1.0.0", main: "index.js" }), "package/index.js": "module.exports = 1;\n" });
    execFileSync("tar", ["-czf", path.join(pkg, "tiny-local-1.0.0.tgz"), "-C", pkg, "package"]);
    // Mockingbird's co-author hooks where the app keeps them: inside the denied team folder
    const hooksDir = path.join(home, ".mockingbird/team/githooks");
    const coauthorsDir = path.join(home, ".mockingbird/team/coauthors");
    ensureHooks(hooksDir, coauthorsDir);
    write(coauthorsDir, { s1: "Nick Smith <nick@example.com>\n" });
    const service = http.createServer((_req, res) => res.end("local service"));
    await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
    const port = String((service.address() as AddressInfo).port);
    const gitDirs = (await roomGitDirs(wt))!;
    const script = `
      export tgz="$1" remote="$2" common="$3" own="$4" port="$5"
      try() { label=$1; shift; if "$@" >/dev/null 2>&1; then echo "ok $label"; else echo "failed $label"; fi; }
      echo change >> README.md
      try commit sh -c 'git add README.md && git commit -qm "in the sandbox"'
      echo wip >> README.md
      try stash git stash -q
      try branch git branch side
      try fetch git fetch -q origin
      try install npm install --no-audit --no-fund --offline "$tgz"
      try npm-cache test -d "$HOME/.npm/_cacache"
      try macos-cache sh -c 'mkdir -p "$HOME/Library/Caches/mb-probe" && echo x > "$HOME/Library/Caches/mb-probe/x"'
      try xdg-cache sh -c 'mkdir -p "$HOME/.cache/mb-probe" && echo x > "$HOME/.cache/mb-probe/x"'
      try local-service sh -c 'curl -sf "http://127.0.0.1:$port/" | grep -q "local service"'
      try push git push -q origin feature
      try ssh-push env GIT_SSH_COMMAND='ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=no' git push -q "ssh://localhost$remote" feature
      try config git config user.name Mallory
      try hook sh -c 'echo "#!/bin/sh" > "$common/hooks/pre-commit"'
      try commondir sh -c 'echo /elsewhere > "$own/commondir"'
      try home-write sh -c 'echo x > "$HOME/.npmrc"'
      try path-write sh -c 'mkdir -p "$HOME/.local/bin" && echo x > "$HOME/.local/bin/git"'
      ssh-add -l >/dev/null 2>&1; echo "ssh-agent $?"
    `;
    let out: string;
    try {
      out = await inRoomSandbox({
        cwd: wt,
        places: places({ git: gitDirs, hooks: [hooksDir, coauthorsDir] }),
        home,
        script,
        args: [path.join(pkg, "tiny-local-1.0.0.tgz"), remote, gitDirs.common, gitDirs.own, port],
        env: { ...hooksEnv(hooksDir, ""), MOCKINGBIRD_SESSION: "s1" },
      });
    } finally {
      service.close();
    }
    for (const done of ["commit", "stash", "branch", "fetch", "install", "npm-cache", "macos-cache", "xdg-cache", "local-service"]) expect(out, done).toContain(`ok ${done}\n`);
    for (const refused of ["push", "ssh-push", "config", "hook", "commondir", "home-write", "path-write"]) expect(out, refused).toContain(`failed ${refused}\n`);
    // 2: no SSH agent reachable (the proxy keeps Unix sockets closed), whether or not one runs
    expect(out).toContain("ssh-agent 2\n");
    expect(git(wt, "log", "-1", "--format=%B")).toContain("in the sandbox\n\nCo-authored-by: Nick Smith <nick@example.com>");
    expect(git(wt, "stash", "list")).toContain("stash@{0}");
    expect(git(repo, "branch", "--list", "side")).toContain("side");
    expect(fs.existsSync(path.join(wt, "node_modules/tiny-local/index.js"))).toBe(true);
    expect(git(remote, "branch", "--list", "feature")).toBe("");
    expect(spawnSync("git", ["-C", repo, "config", "--get", "user.name"], { encoding: "utf8" }).stdout.trim()).not.toBe("Mallory");
  }, 180_000);

  it("commits in a repository's main checkout, whose .git is otherwise read-only to the sandbox, but can't change its config or hooks", async () => {
    const home = outsideTmp("home");
    const repo = makeRepo({ "README.md": "hello\n" }, "repo", outsideTmp("code"));
    const gitDirs = (await roomGitDirs(repo))!;
    expect(gitDirs.own).toBe(gitDirs.common);
    const script = `
      try() { label=$1; shift; if "$@" >/dev/null 2>&1; then echo "ok $label"; else echo "failed $label"; fi; }
      echo change >> README.md
      try commit sh -c 'git add README.md && git commit -qm "main checkout"'
      try config git config user.name Mallory
      try hook sh -c 'echo "#!/bin/sh" > .git/hooks/pre-commit'
    `;
    const out = await inRoomSandbox({ cwd: repo, places: places({ git: gitDirs }), home, script });
    expect(out).toContain("ok commit\n");
    for (const refused of ["config", "hook"]) expect(out, refused).toContain(`failed ${refused}\n`);
    expect(git(repo, "log", "-1", "--format=%s")).toBe("main checkout");
  }, 120_000);

  it("leaves Codex's own sign-in readable to the CLI itself", () => {
    const codexHome = outsideTmp("codex-signed-in");
    write(codexHome, { "auth.json": JSON.stringify({ OPENAI_API_KEY: "sk-mockingbird-test" }) });
    const { config } = codexRoomPermissions(places({ codexHome }));
    const r = spawnSync("codex", ["login", "status", ...config.flatMap((c) => ["-c", c])], { encoding: "utf8", env: { ...process.env, CODEX_HOME: codexHome }, timeout: 60_000 });
    expect(`${r.stdout}${r.stderr}`).toMatch(/logged in using an api key/i);
  }, 90_000);
});

