import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { claudeRoomSettings } from "../src/main/claudeRoomSandbox";
import { codexRoomPermissions, roomGitDirs } from "../src/main/codexRoomSandbox";
import { HOME_RUNS_CODE } from "../src/main/secrets";
import { git, makeRepo, tempDir } from "./helpers";

/** A Claude team room session's sandbox and deny rules (--settings), as main writes them. */

const settingsOf = (o: Parameters<typeof claudeRoomSettings>[0]) => claudeRoomSettings(o).settings as any;

describe("a Claude room session's settings", () => {
  it("sandboxes Bash with no way out, Bash still asking, the network open, and every write of HOME_RUNS_CODE denied to it and to the file tools", () => {
    const s = settingsOf({ git: null, hooks: [] });
    expect(s.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: false, network: { allowLocalBinding: true, allowedDomains: ["*"] } });
    expect(s.sandbox.excludedCommands).toBeUndefined();
    expect(s.sandbox.network.allowUnixSockets).toBeUndefined();
    for (const p of ["~/.mockingbird", "~/.zshenv", "~/.zshrc", "~/.zprofile", "~/.zlogin", "~/.bashrc", "~/.bash_profile", "~/.profile", "~/.claude", "~/.codex", "~/.gitconfig", "~/.config/git", "~/.ssh", "~/Library/LaunchAgents"]) {
      expect(s.sandbox.filesystem.denyWrite).toContain(p);
    }
    expect(s.permissions.deny).toEqual(HOME_RUNS_CODE.map((x) => `Edit(${x})`));
    expect(s.sandbox.filesystem.denyWrite).toEqual(HOME_RUNS_CODE.map((x) => x.replace(/\/\*\*$/, "")));
    expect(s.permissions.blockWritesOutsideWorkingDirectories).toBe(true);
    // no cache in home: their contents are run later, outside the sandbox
    expect(s.sandbox.filesystem.allowWrite).toEqual([]);
    expect(s.hooks).toBeUndefined();
  });

  it("writes only the room's own caches, never home's", () => {
    const s = settingsOf({ git: null, hooks: [], caches: "/c/rooms/r1" });
    expect(s.sandbox.filesystem.allowWrite).toEqual(["/c/rooms/r1"]);
    for (const home of ["~/.npm", "~/.cache", "~/Library/Caches", "~/go/pkg", "~/.cargo/registry", "~/.nuget/packages"]) expect(s.sandbox.filesystem.allowWrite).not.toContain(home);
  });

  it("keeps the file tools off what the sandbox keeps Bash off inside the session's folders, there and below", () => {
    const s = settingsOf({ git: null, hooks: [], folders: ["/w/5110", "/extra"] });
    for (const dir of ["/w/5110", "/extra"]) {
      for (const rule of [`Edit(/${dir}/.git)`, `Edit(/${dir}/.git/**)`, `Edit(/${dir}/.mcp.json)`, `Edit(/${dir}/.claude/**)`, `Edit(/${dir}/.vscode/**)`, `Edit(/${dir}/.idea/**)`, `Edit(/${dir}/.gitmodules)`, `Edit(/${dir}/.zshrc)`]) {
        expect(s.permissions.deny).toContain(rule);
      }
      expect(s.permissions.deny).toContain(`Edit(/${dir}/**/.mcp.json)`);
      expect(s.permissions.deny).toContain(`Edit(/${dir}/**/.git/**)`);
      for (const rule of [`Edit(/${dir}/.envrc)`, `Edit(/${dir}/**/.envrc)`, `Edit(/${dir}/.codex/**)`, `Edit(/${dir}/**/.codex/**)`]) expect(s.permissions.deny).toContain(rule);
      // Husky's hooks run on the user's own commits and pushes, outside the sandbox
      for (const rule of [`Edit(/${dir}/.husky/**)`, `Edit(/${dir}/**/.husky/**)`]) expect(s.permissions.deny).toContain(rule);
    }
  });

  it("keeps Bash off them too by its own denyWrite, not only Claude Code's list (which lacks .envrc and .codex), leaving .git to the git rules", () => {
    const s = settingsOf({ git: null, hooks: [], folders: ["/w/5110"] });
    const denied: string[] = s.sandbox.filesystem.denyWrite;
    for (const p of ["/w/5110/.envrc", "/w/5110/**/.envrc", "/w/5110/.codex", "/w/5110/.codex/**", "/w/5110/**/.codex", "/w/5110/**/.codex/**", "/w/5110/.vscode/**", "/w/5110/**/.mcp.json", "/w/5110/**/.zshrc", "/w/5110/.husky/**", "/w/5110/**/.husky/**"]) {
      expect(denied).toContain(p);
    }
    expect(denied.filter((p) => p.includes(".git") && !p.includes(".gitconfig") && !p.includes(".gitmodules"))).toEqual([]);
  });

  it("reports in with its own SessionStart hook, when given one", () => {
    const s = settingsOf({ git: null, hooks: [], marker: "'/m/room-sandbox.sh' abc" });
    expect(s.hooks).toEqual({ SessionStart: [{ hooks: [{ type: "command", command: "'/m/room-sandbox.sh' abc" }] }] });
  });

  it("denies the other worktrees' git folders by name, as they are at launch, and the shared attributes", () => {
    const repo = tempDir("repo");
    const common = path.join(repo, ".git");
    for (const w of ["5110", "5120", "5130"]) fs.mkdirSync(path.join(common, "worktrees", w), { recursive: true });
    const own = path.join(common, "worktrees", "5110");
    const s = settingsOf({ git: { common, own }, hooks: [] });
    const denied = s.sandbox.filesystem.denyWrite;
    expect(denied).toEqual(expect.arrayContaining([path.join(common, "worktrees", "5120"), path.join(common, "worktrees", "5130"), path.join(common, "info", "attributes")]));
    expect(denied).not.toContain(own);
    for (const d of denied) expect(own.startsWith(d + "/")).toBe(false);
    expect(s.permissions.deny).toEqual(expect.arrayContaining([`Edit(/${path.join(common, "info", "attributes")})`]));
  });

  it("denies what git runs or follows in every worktree's git folder by pattern, so one made after the launch is covered, and leaves its own commits writable", async () => {
    const repo = makeRepo();
    const at = tempDir("wt");
    git(repo, "worktree", "add", "-q", "-b", "own", path.join(at, "own"));
    git(repo, "worktree", "add", "-q", "-b", "before", path.join(at, "before"));
    const dirs = (await roomGitDirs(path.join(at, "own")))!;
    const s = settingsOf({ git: dirs, hooks: [] });
    // made while the pane runs, after its settings were written
    const later = path.join(at, "later");
    git(repo, "worktree", "add", "-q", "-b", "later", later);
    const laterGit = path.resolve(later, git(later, "rev-parse", "--git-dir"));
    expect(path.dirname(laterGit)).toBe(path.join(dirs.common, "worktrees"));
    // where git reads a linked worktree's config, pointers and submodules: its own folder, not the shared one
    for (const name of ["config.worktree", "commondir", "modules"]) expect(path.resolve(later, git(later, "rev-parse", "--git-path", name))).toBe(path.join(laterGit, name));

    const denyWrite: string[] = s.sandbox.filesystem.denyWrite;
    const editDenied: string[] = s.permissions.deny;
    // a pattern matches what it names, `**` one folder or more (narrow) or none at all too (wide), and a path what's under it
    const matches = (pattern: string, p: string, wide: boolean) => {
      if (!pattern.includes("*")) return p === pattern || p.startsWith(pattern + "/");
      const re = pattern
        .split(/(\*\*\/|\*\*|\*)/)
        .map((part) => (part === "**/" ? (wide ? "(?:.*/)?" : "(?:[^/]+/)+") : part === "**" ? ".*" : part === "*" ? "[^/]*" : part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")))
        .join("");
      return new RegExp(`^${re}$`).test(p);
    };
    const deniedBy = (list: string[], p: string, wide = false) => list.some((d) => matches(d, p, wide));
    const editRules = editDenied.flatMap((r) => (r.startsWith("Edit(//") ? [r.slice("Edit(/".length, -1)] : []));

    const runs = (gitDir: string) => ["config.worktree", "commondir", "gitdir", "modules", "modules/lib/config", "modules/lib/hooks/pre-commit"].map((f) => path.join(gitDir, f));
    for (const p of [...runs(laterGit), ...runs(dirs.own)]) {
      expect(deniedBy(denyWrite, p), p).toBe(true);
      expect(deniedBy(editRules, p), p).toBe(true);
    }
    // one there at launch is denied whole, by name
    const before = path.join(dirs.common, "worktrees", "before");
    for (const f of ["HEAD", "index", "commondir", "modules/lib/config"]) expect(deniedBy(denyWrite, path.join(before, f)), f).toBe(true);
    // what a commit, a branch, a stash and a fetch write stays writable, however a pattern's `**` is read
    const writes = [
      ...["HEAD", "index", "ORIG_HEAD", "logs/HEAD", "refs/bisect/bad", "COMMIT_EDITMSG", "MERGE_HEAD", "AUTO_MERGE", "rebase-merge/done"].map((f) => path.join(dirs.own, f)),
      ...["objects/ab/cdef", "objects/pack/pack-1.pack", "objects/info/commit-graph", "objects/info/packs", "refs/heads/own", "refs/stash", "packed-refs", "logs/refs/heads/own", "FETCH_HEAD", "refs/remotes/origin/main"].map((f) => path.join(dirs.common, f)),
    ];
    expect(s.sandbox.filesystem.allowWrite).toEqual([dirs.common, dirs.own]);
    for (const p of writes) expect(deniedBy(denyWrite, p, true), p).toBe(false);
  });

  it("keeps the shared git folder's config files and pointers read-only, to Bash and to the file tools, for a main checkout's session and a linked worktree's", () => {
    // git follows a commondir in a main checkout's .git as in a linked worktree's folder, to another folder's config
    const repo = makeRepo();
    const elsewhere = tempDir("elsewhere");
    fs.cpSync(path.join(repo, ".git"), path.join(elsewhere, "git"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".git", "commondir"), path.join(elsewhere, "git") + "\n");
    expect(fs.realpathSync(git(repo, "rev-parse", "--path-format=absolute", "--git-path", "config"))).toBe(fs.realpathSync(path.join(elsewhere, "git", "config")));
    const files = ["config", "config.worktree", "commondir", "gitdir", "info/attributes", "info/exclude", "objects/info/alternates", "remotes", "branches"];
    for (const own of ["/code/app/.git", "/code/app/.git/worktrees/5110"]) {
      const s = settingsOf({ git: { common: "/code/app/.git", own }, hooks: [] });
      for (const f of files) {
        expect(s.sandbox.filesystem.denyWrite, `${own}: ${f}`).toContain(`/code/app/.git/${f}`);
        expect(s.permissions.deny, `${own}: ${f}`).toContain(`Edit(//code/app/.git/${f})`);
      }
    }
  });

  it("keeps the legacy remotes and branches folders and info/exclude read-only, to Bash and to the file tools: git takes a remote from them, and hides what's excluded, and nothing a commit, branch, stash, fetch or gc does writes them", () => {
    const repo = makeRepo();
    const common = fs.realpathSync(path.join(repo, ".git"));
    // a remote the config doesn't define, from either legacy folder: a fetch of it reaches wherever the file says
    const elsewhere = makeRepo({ "x.txt": "x\n" }, "elsewhere");
    fs.mkdirSync(path.join(common, "remotes"));
    fs.writeFileSync(path.join(common, "remotes", "team"), `URL: ${elsewhere}\nPull: refs/heads/main:refs/remotes/team/main\n`);
    fs.mkdirSync(path.join(common, "branches"), { recursive: true });
    fs.writeFileSync(path.join(common, "branches", "old"), `${elsewhere}#main\n`);
    expect(git(repo, "config", "--list").split("\n").filter((l) => l.startsWith("remote."))).toEqual([]);
    git(repo, "fetch", "-q", "team");
    expect(git(repo, "rev-parse", "refs/remotes/team/main")).toBe(git(elsewhere, "rev-parse", "HEAD"));
    git(repo, "fetch", "-q", "old");
    expect(git(repo, "rev-parse", "FETCH_HEAD")).toBe(git(elsewhere, "rev-parse", "HEAD"));
    // a file info/exclude names isn't in status, so not in what a snapshot or a take-over's backup stores
    fs.writeFileSync(path.join(repo, "hidden.txt"), "h\n");
    expect(git(repo, "status", "--porcelain")).toContain("hidden.txt");
    fs.appendFileSync(path.join(common, "info", "exclude"), "hidden.txt\n");
    expect(git(repo, "status", "--porcelain")).toBe("");

    // denied by both sandboxes, a main checkout's session and a linked worktree's
    const paths = ["remotes/team", "branches/old", "info/exclude"].map((f) => path.join(common, f));
    for (const own of [common, path.join(common, "worktrees", "wt")]) {
      const s = settingsOf({ git: { common, own }, hooks: [] });
      const editRules = (s.permissions.deny as string[]).flatMap((r) => (r.startsWith("Edit(//") ? [r.slice("Edit(/".length, -1)] : []));
      const deniedBy = (list: string[], p: string) => list.some((d) => p === d || p.startsWith(d + "/") || (d.endsWith("/**") && p.startsWith(d.slice(0, -2))));
      for (const p of paths) {
        expect(deniedBy(s.sandbox.filesystem.denyWrite, p), `${own}: ${p}`).toBe(true);
        expect(deniedBy(editRules, p), `${own}: ${p}`).toBe(true);
      }
      const profile = codexRoomPermissions({ workTrackerPath: tempDir("wt"), git: { common, own }, hooks: [] }).config.join("\n");
      for (const f of ["remotes", "branches", "info/exclude"]) expect(profile, `${own}: ${f}`).toContain(`${JSON.stringify(path.join(common, f))}="read"`);
    }

    // with them read-only, a commit, a branch, a stash, a fetch and a gc go through
    const remote = path.join(tempDir("remote"), "origin.git");
    git(path.dirname(remote), "init", "-q", "--bare", remote);
    git(repo, "remote", "add", "origin", remote);
    git(repo, "push", "-q", "origin", "main");
    const locked = [path.join(common, "remotes"), path.join(common, "branches")];
    for (const d of locked) for (const f of fs.readdirSync(d)) fs.chmodSync(path.join(d, f), 0o444);
    for (const d of locked) fs.chmodSync(d, 0o555);
    fs.chmodSync(path.join(common, "info", "exclude"), 0o444);
    try {
      fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
      git(repo, "add", "a.txt");
      git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "a");
      git(repo, "branch", "side");
      fs.writeFileSync(path.join(repo, "a.txt"), "b\n");
      git(repo, "stash", "-q");
      git(repo, "fetch", "-q", "origin");
      git(repo, "gc", "-q");
      expect(git(repo, "log", "-1", "--format=%s")).toBe("a");
      expect(git(repo, "stash", "list")).toContain("stash@{0}");
    } finally {
      for (const d of locked) fs.chmodSync(d, 0o755);
      for (const d of locked) for (const f of fs.readdirSync(d)) fs.chmodSync(path.join(d, f), 0o644);
      fs.chmodSync(path.join(common, "info", "exclude"), 0o644);
    }
  });

  it("lets a worktree's commits write the shared git folder but its config, hooks, submodules and its own pointers", () => {
    const git = { common: "/code/app/.git", own: "/code/app/.git/worktrees/5110" };
    const s = settingsOf({ git, hooks: ["/h/githooks", "/h/coauthors"] });
    expect(s.sandbox.filesystem.allowWrite.slice(0, 2)).toEqual([git.common, git.own]);
    const denied = s.sandbox.filesystem.denyWrite;
    expect(denied).toEqual(expect.arrayContaining(["/code/app/.git/config", "/code/app/.git/hooks", "/code/app/.git/modules", `${git.own}/config.worktree`, `${git.own}/commondir`, `${git.own}/gitdir`, `${git.own}/modules`]));
    // a denied folder holding its own git folder would stop every commit: Claude's denyWrite outranks allowWrite
    expect(denied).not.toContain("/code/app/.git/worktrees");
    for (const d of denied) expect(git.own.startsWith(d + "/")).toBe(false);
    expect(s.permissions.deny).toEqual(expect.arrayContaining(["Edit(//code/app/.git/config)", "Edit(//code/app/.git/hooks/**)"]));
    expect(s.sandbox.filesystem.allowRead).toEqual(["/h/githooks", "/h/coauthors"]);
    // a main checkout's git folder is its own
    const main = settingsOf({ git: { common: "/code/app/.git", own: "/code/app/.git" }, hooks: [] });
    expect(main.sandbox.filesystem.allowWrite[0]).toBe("/code/app/.git");
    expect(main.sandbox.filesystem.denyWrite).toContain("/code/app/.git/worktrees");
    // which holds every worktree's, later ones too: no pattern needed
    expect(main.sandbox.filesystem.denyWrite.filter((d: string) => d.includes("*") && d.startsWith("/code/app/.git"))).toEqual([]);
  });

  it("denies the secrets to its commands as Codex's sandbox does, the known PAT file included, and says what it couldn't find", () => {
    const wt = tempDir("worktracker");
    fs.mkdirSync(path.join(wt, "secrets"), { recursive: true });
    fs.writeFileSync(path.join(wt, "config.json"), JSON.stringify({ azureDevOps: { patFile: "secrets/ado.pat" } }));
    const s = claudeRoomSettings({ workTrackerPath: wt, git: null, hooks: [] });
    expect(s.problem).toBeNull();
    expect((s.settings as any).sandbox.filesystem.denyRead).toEqual(
      expect.arrayContaining(["~/.ssh", "~/.mockingbird/team", "~/.mockingbird/mcp-tokens", "~/Library/Messages", "~/Library/Keychains", "~/.codex/auth.json", path.join(wt, "secrets/ado.pat")])
    );
    fs.writeFileSync(path.join(wt, "config.json"), "{ not json");
    expect(claudeRoomSettings({ workTrackerPath: wt, git: null, hooks: [] }).problem).toMatch(/^Couldn't find the Azure DevOps PAT file: .+ — so it isn't denied by path$/);
  });

  it("runs a headless Council seat's commands without asking, with its Docker socket", () => {
    const s = settingsOf({ git: null, hooks: [], autoAllowBash: true, sockets: ["/var/run/docker.sock"] });
    expect(s.sandbox).toMatchObject({ autoAllowBashIfSandboxed: true, network: { allowUnixSockets: ["/var/run/docker.sock"] } });
  });
});
