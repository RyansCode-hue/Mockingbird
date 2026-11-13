import { execFileSync, spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CODEX_ROOM_APPROVALS,
  CODEX_ROOM_PROFILE,
  codexHomeOf,
  codexOutsideOff,
  codexProjectFolders,
  codexRoomPermissions,
  roomCacheEnv,
  roomGitDirs,
  type CodexRoomPlaces,
} from "../src/main/codexRoomSandbox";
import { CodexMcpNames } from "../src/main/codexMcpNames";
import { clearGitPins, gitPinRefusal, pinGitDirs } from "../src/main/gitPins";
import { SECRET_FILE_GLOBS } from "../src/main/secrets";
import { agentFor, cliVersion, codexMcpOff } from "../src/main/agents";
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
    const shared = ["config", "config.worktree", "commondir", "gitdir", "info/attributes", "info/exclude", "objects/info/alternates", "remotes", "branches", "hooks", "modules", "worktrees"];
    for (const r of [...shared, "worktrees/wt/config.worktree", "worktrees/wt/commondir", "worktrees/wt/gitdir", "worktrees/wt/modules"]) expect(profile).toContain(`"/r/.git/${r}"="read"`);
    // no folder on PATH
    for (const bin of ["~/.yarn\"", "~/go\"", "~/.cargo\"", "~/.dotnet", "~/.local/bin", "~/Library/pnpm\""]) expect(profile).not.toContain(bin);
    // a main checkout: one git folder, whose commondir would lead the main checkout's git (the user's own) elsewhere
    const main = profileOf(codexRoomPermissions(places({ git: { common: "/r/.git", own: "/r/.git" } })).config);
    expect(main).toContain(`"/r/.git"="write"`);
    for (const r of shared) expect(main).toContain(`"/r/.git/${r}"="read"`);
    // outside a repository nothing of git's is writable
    expect(profileOf(codexRoomPermissions(places()).config)).not.toContain(`.git"="write"`);
  });

  it("keeps every other worktree read-only, one made after the launch included, by the folder that holds them, its own alone writable", () => {
    const profile = profileOf(codexRoomPermissions(places({ git: { common: "/r/.git", own: "/r/.git/worktrees/wt" } })).config);
    // the profile's path entries, each with its access; Codex goes by the most specific one that holds a path
    const entries = [...profile.matchAll(/"(\/[^"]*)"="(write|read|deny)"/g)].map((m) => ({ at: m[1], access: m[2] }));
    const access = (p: string) => entries.filter((e) => p === e.at || p.startsWith(e.at + "/")).sort((a, b) => b.at.length - a.at.length)[0]?.access;
    for (const f of ["HEAD", "index", "commondir", "gitdir", "config.worktree", "modules/lib/config"]) expect(access(`/r/.git/worktrees/made-later/${f}`), f).toBe("read");
    for (const f of ["HEAD", "index", "logs/HEAD", "refs/bisect/bad"]) expect(access(`/r/.git/worktrees/wt/${f}`), f).toBe("write");
    for (const f of ["commondir", "gitdir", "config.worktree", "modules/lib/config"]) expect(access(`/r/.git/worktrees/wt/${f}`), f).toBe("read");
    for (const f of ["objects/ab/cdef", "refs/heads/wt", "packed-refs"]) expect(access(`/r/.git/${f}`), f).toBe("write");
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

  it("gives its git folders with symlinks resolved, as the sandboxes' rules match paths, for a repository and a worktree reached through a link", async () => {
    const repo = makeRepo();
    const wt = path.join(tempDir("wt"), "feature");
    git(repo, "worktree", "add", "-q", "-b", "feature", wt);
    const links = tempDir("links");
    fs.symlinkSync(repo, path.join(links, "repo"));
    fs.symlinkSync(path.dirname(wt), path.join(links, "wts"));
    const common = fs.realpathSync(path.join(repo, ".git"));
    expect(await roomGitDirs(path.join(links, "repo"))).toEqual({ common, own: common });
    const viaLink = (await roomGitDirs(path.join(links, "wts", "feature")))!;
    expect(viaLink).toEqual({ common, own: path.join(common, "worktrees", "feature") });
    // and the rules made from them name what the sandbox compares against
    const profile = profileOf(codexRoomPermissions(places({ git: viaLink })).config);
    for (const f of ["config", "hooks", "remotes", "worktrees/feature/commondir"]) expect(profile, f).toContain(`${JSON.stringify(path.join(common, f))}="read"`);
    // a worktree whose own .git file names its git folder through a link
    const gitLink = path.join(links, "git");
    fs.symlinkSync(common, gitLink);
    fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(gitLink, "worktrees", "feature")}\n`);
    expect(await roomGitDirs(wt)).toEqual({ common, own: path.join(common, "worktrees", "feature") });
  });

  it("gives its git folders in the case the disk has them, for a folder named in another case, and still pins them", async () => {
    const repo = makeRepo({ "a.txt": "a\n" }, "CaseRepo");
    const shouted = path.join(path.dirname(repo), "CASEREPO");
    // only where names are matched without case, as on a Mac's own disk
    if (!fs.existsSync(shouted)) return;
    const wt = path.join(tempDir("wt"), "Feature");
    git(repo, "worktree", "add", "-q", "-b", "feature", wt);
    const common = fs.realpathSync.native(path.join(repo, ".git"));
    expect(path.basename(path.dirname(common))).toBe("CaseRepo");
    expect(await roomGitDirs(shouted)).toEqual({ common, own: common });
    const shoutedWt = path.join(path.dirname(wt), "FEATURE");
    expect(await roomGitDirs(shoutedWt)).toEqual({ common, own: path.join(common, "worktrees", "Feature") });
    const profile = profileOf(codexRoomPermissions(places({ git: (await roomGitDirs(shoutedWt))! })).config);
    expect(profile).toContain(`${JSON.stringify(path.join(common, "config"))}="read"`);
    // pinned as found, the folder's own .git read the same way, so git still runs there
    try {
      expect(pinGitDirs(shouted, (await roomGitDirs(shouted))!, shouted)).toBeNull();
      expect(pinGitDirs(shoutedWt, (await roomGitDirs(shoutedWt))!, shouted)).toBeNull();
      expect(gitPinRefusal(shoutedWt)).toBeNull();
      expect(gitPinRefusal(shouted)).toBeNull();
      // and held there however the folder is named: led elsewhere, git is refused in it by its own case too
      const evil = path.join(tempDir("evil"), "wt");
      fs.cpSync(path.join(common, "worktrees", "Feature"), evil, { recursive: true });
      fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${evil}\n`);
      expect(gitPinRefusal(wt)).toMatch(/won't run git in .*its \.git now leads to /);
      expect(gitPinRefusal(shoutedWt)).toMatch(/won't run git in /);
    } finally {
      clearGitPins();
    }
  });

  it("names CODEX_HOME only when it isn't ~/.codex", () => {
    expect(codexHomeOf({})).toBeUndefined();
    expect(codexHomeOf({ CODEX_HOME: home(".codex") })).toBeUndefined();
    expect(codexHomeOf({ CODEX_HOME: "/elsewhere/codex" })).toBe("/elsewhere/codex");
  });

  it("keeps the editors', agents' and shells' settings files read-only at the session folder's top and hidden below it, leaving .git to gitWrites", () => {
    const profile = profileOf(codexRoomPermissions(places()).config);
    const roots = /":workspace_roots"=\{([^}]*)\}/.exec(profile)![1];
    for (const f of [".envrc", ".mcp.json", ".zshrc", ".gitmodules"]) expect(roots).toContain(`"${f}"="read", "*/**/${f}"="deny"`);
    for (const d of [".codex", ".claude", ".vscode", ".idea", ".husky"]) expect(roots).toContain(`"${d}"="read", "*/**/${d}"="deny", "*/**/${d}/**"="deny"`);
    expect(roots).not.toContain(`.git"=`);
  });

  it("keeps a launch from what a repository commits or its agent picks to run outside the sandbox: each folder untrusted, notify, apps, plugins, computer and browser use", () => {
    expect(codexOutsideOff(["/r", "/r/web"])).toEqual([
      `projects={"/r"={trust_level="untrusted"}, "/r/web"={trust_level="untrusted"}}`,
      "notify=[]",
      ...["apps", "plugins", "computer_use", "browser_use", "browser_use_external", "skill_mcp_dependency_install"].map((f) => `features.${f}=false`),
    ]);
    expect(codexOutsideOff([])[0]).toBe("notify=[]");
    // a folder with dots stays one key
    expect(codexOutsideOff(["/Users/me/.mockingbird/wt/a.b"])[0]).toBe(`projects={"/Users/me/.mockingbird/wt/a.b"={trust_level="untrusted"}}`);
  });

  it("names every folder from the repository's top down to the session's, as given and resolved", () => {
    const repo = makeRepo({ "web/src/a.ts": "x\n" });
    const real = fs.realpathSync(repo);
    const link = path.join(tempDir("link"), "repo");
    fs.symlinkSync(repo, link);
    const all = (...ps: string[]) => [...new Set(ps)];
    expect(codexProjectFolders(path.join(link, "web", "src"), link)).toEqual(
      all(path.join(link, "web", "src"), path.join(real, "web", "src"), path.join(link, "web"), path.join(real, "web"), link, real)
    );
    // outside a repository: the folder itself
    const plain = tempDir("plain");
    expect(codexProjectFolders(plain, null)).toEqual(all(plain, fs.realpathSync(plain)));
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
      try npm-cache test -d "$npm_config_cache/_cacache"
      try room-cache sh -c 'mkdir -p "$XDG_CACHE_HOME/mb-probe" && echo x > "$XDG_CACHE_HOME/mb-probe/x"'
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
    // the room's own caches, which the agent's command points its tools at; home's stay unwritten
    const caches = outsideTmp("room-caches");
    let out: string;
    try {
      out = await inRoomSandbox({
        cwd: wt,
        places: places({ git: gitDirs, hooks: [hooksDir, coauthorsDir], caches }),
        home,
        script,
        args: [path.join(pkg, "tiny-local-1.0.0.tgz"), remote, gitDirs.common, gitDirs.own, port],
        env: { ...hooksEnv(hooksDir, ""), MOCKINGBIRD_SESSION: "s1", ...roomCacheEnv(caches) },
      });
    } finally {
      service.close();
    }
    for (const done of ["commit", "stash", "branch", "fetch", "install", "npm-cache", "room-cache", "local-service"]) expect(out, done).toContain(`ok ${done}\n`);
    for (const refused of ["push", "ssh-push", "config", "hook", "commondir", "home-write", "path-write", "macos-cache", "xdg-cache"]) expect(out, refused).toContain(`failed ${refused}\n`);
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

  it("can't write the editors', agents' and shells' settings files in its folder or below, and still reads them at the top", async () => {
    const home = outsideTmp("home");
    const repo = makeRepo({ "README.md": "hello\n", ".claude/settings.json": "{}\n", "web/index.ts": "x\n" }, "repo", outsideTmp("code"));
    const script = `
      try() { label=$1; shift; if "$@" >/dev/null 2>&1; then echo "ok $label"; else echo "failed $label"; fi; }
      try envrc sh -c 'echo x > .envrc'
      try nested-envrc sh -c 'echo x > web/.envrc'
      try claude-settings sh -c 'echo x > .claude/settings.json'
      try codex-config sh -c 'mkdir -p .codex && echo x > .codex/config.toml'
      try nested-codex sh -c 'mkdir -p web/.codex && echo x > web/.codex/config.toml'
      try nested-vscode sh -c 'mkdir -p web/.vscode && echo x > web/.vscode/settings.json'
      try mcp-json sh -c 'echo {} > .mcp.json'
      try zshrc sh -c 'echo x > web/.zshrc'
      try ordinary sh -c 'echo x > web/notes.md'
      try read-claude cat .claude/settings.json
    `;
    const out = await inRoomSandbox({ cwd: repo, places: places({ git: (await roomGitDirs(repo))! }), home, script });
    for (const done of ["ordinary", "read-claude"]) expect(out, done).toContain(`ok ${done}\n`);
    for (const refused of ["envrc", "nested-envrc", "claude-settings", "codex-config", "nested-codex", "nested-vscode", "mcp-json", "zshrc"]) expect(out, refused).toContain(`failed ${refused}\n`);
    expect(fs.readFileSync(path.join(repo, ".claude/settings.json"), "utf8")).toBe("{}\n");
  }, 120_000);

  /**
   * A room session's worktree whose repository the user's config trusts, with a .codex config of its own, and the
   * user's config naming two MCP servers (one with dots in its name) and a notify program. `ran` collects what started.
   */
  function trustedWorktree(extra = "") {
    const codexHome = outsideTmp("codex-home");
    const ran = outsideTmp("ran");
    const repo = makeRepo({ "README.md": "x\n" }, "repo", outsideTmp("code"));
    const wt = path.join(outsideTmp("wt"), "dot.feature");
    git(repo, "worktree", "add", "-q", "-b", "feature", wt);
    const mark = (name: string) => `["/bin/sh", "-c", ${JSON.stringify(`echo x >> ${path.join(ran, name)}`)}]`;
    const server = (name: string) => `command = "/bin/sh"\nargs = ["-c", ${JSON.stringify(`echo x >> ${path.join(ran, name)}; sleep 1`)}]\n`;
    write(wt, { ".codex/config.toml": `[mcp_servers.reposrv]\n${server("reposrv")}` });
    write(codexHome, {
      "config.toml":
        `cli_auth_credentials_store = "file"\nnotify = ${mark("notify")}\n${extra}\n` +
        `[mcp_servers.usersrv]\n${server("usersrv")}\n[mcp_servers."dotted.name"]\n${server("dotted")}\n` +
        `[projects.${JSON.stringify(fs.realpathSync(repo))}]\ntrust_level = "trusted"\n`,
    });
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_/i.test(k))), CODEX_HOME: codexHome };
    const codex = (cwd: string, args: string[]) => spawnSync("codex", args, { cwd, encoding: "utf8", env, timeout: 90_000, stdio: ["ignore", "pipe", "pipe"] });
    /** codex, leaving this process free to answer it (the stand-in model runs here). */
    const codexAsync = (cwd: string, args: string[]) =>
      new Promise<{ status: number | null; stderr: string }>((resolve, reject) => {
        const child = spawn("codex", args, { cwd, env, stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        child.stderr.on("data", (d) => (stderr += d));
        child.on("error", reject);
        child.on("close", (status) => resolve({ status, stderr }));
      });
    // the names as a launch reads them: from Codex itself, outside any project
    const names = new CodexMcpNames({ list: async () => ({ code: 0, out: codex("/", ["mcp", "list", "--json"]).stdout }), configFiles: () => [path.join(codexHome, "config.toml")] });
    /** A room launch's settings in the worktree, Mockingbird's own server given as `mcp`. */
    const launch = async (mcp?: { command: string; args: string[]; env: Record<string, string> }) =>
      agentFor("codex").launchArgs(
        { repoPath: null, useWorktree: false },
        {
          ...(mcp ? { mcp } : {}),
          codexPermissions: [
            ...codexMcpOff(await names.names("codex")),
            ...codexOutsideOff(codexProjectFolders(wt, wt)),
            CODEX_ROOM_APPROVALS,
            ...codexRoomPermissions(places({ git: (await roomGitDirs(wt))! })).config,
          ],
        }
      );
    return { wt, ran, codex, codexAsync, names, launch };
  }

  it("reads none of the repository's .codex config and switches the user's MCP servers off but Mockingbird's, under a room launch's settings", async () => {
    const t = trustedWorktree();
    expect(await t.names.names("codex")).toEqual(["dotted.name", "usersrv"]);
    const servers = (args: string[]) => Object.fromEntries((JSON.parse(t.codex(t.wt, [...args, "mcp", "list", "--json"]).stdout) as { name: string; enabled: boolean }[]).map((s) => [s.name, s.enabled]));
    // as configured, the trusted repository's own server loads
    expect(servers([])).toEqual({ "dotted.name": true, reposrv: true, usersrv: true });
    expect(servers(await t.launch({ command: "/bin/echo", args: ["mb"], env: { MOCKINGBIRD_SESSION: "s1" } }))).toEqual({ "dotted.name": false, mockingbird: true, usersrv: false });
    const features = t.codex(t.wt, [...(await t.launch()), "features", "list"]).stdout;
    for (const f of ["apps", "plugins", "computer_use", "browser_use", "skill_mcp_dependency_install"]) expect(features, f).toMatch(new RegExp(`^${f} .* false$`, "m"));
  }, 120_000);

  it("starts none of them in a turn, and runs no notify program — a stand-in model answering it on this machine", async () => {
    const model = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        if (req.url?.includes("/models")) return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ models: [] }));
        if (req.method !== "POST" || !req.url?.endsWith("/responses")) return void res.writeHead(404).end();
        const sse = (type: string, body: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(sse("response.created", { response: { id: "r1" } }));
        res.write(sse("response.output_item.done", { item: { type: "message", role: "assistant", id: "m1", content: [{ type: "output_text", text: "ok" }] } }));
        res.end(sse("response.completed", { response: { id: "r1", usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 } } }));
      });
    });
    await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
    const port = (model.address() as AddressInfo).port;
    try {
      const t = trustedWorktree(`model_provider = "standin"\nmodel = "gpt-5.1-codex"\n[model_providers.standin]\nname = "standin"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`);
      /** What started for a turn: the notify program runs once the turn is over, as the CLI exits. */
      const turn = async (args: string[]) => {
        for (const f of fs.readdirSync(t.ran)) fs.rmSync(path.join(t.ran, f));
        const r = await t.codexAsync(t.wt, ["exec", "--skip-git-repo-check", ...args, "say ok"]);
        expect(r.status, r.stderr).toBe(0);
        await new Promise((done) => setTimeout(done, 1500));
        return fs.readdirSync(t.ran).sort();
      };
      // as configured, everything starts outside the sandbox
      expect(await turn([])).toEqual(["dotted", "notify", "reposrv", "usersrv"]);
      expect(await turn(await t.launch())).toEqual([]);
    } finally {
      model.close();
    }
  }, 180_000);
});

