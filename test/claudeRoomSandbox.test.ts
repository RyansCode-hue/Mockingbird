import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { claudeRoomSettings } from "../src/main/claudeRoomSandbox";
import { HOME_RUNS_CODE } from "../src/main/secrets";
import { tempDir } from "./helpers";

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
    }
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

  it("lets a worktree's commits write the shared git folder but its config, hooks, submodules and its own pointers", () => {
    const git = { common: "/code/app/.git", own: "/code/app/.git/worktrees/5110" };
    const s = settingsOf({ git, hooks: ["/h/githooks", "/h/coauthors"] });
    expect(s.sandbox.filesystem.allowWrite.slice(0, 2)).toEqual([git.common, git.own]);
    const denied = s.sandbox.filesystem.denyWrite;
    expect(denied).toEqual(expect.arrayContaining(["/code/app/.git/config", "/code/app/.git/hooks", "/code/app/.git/modules", `${git.own}/config.worktree`, `${git.own}/commondir`, `${git.own}/gitdir`]));
    // a denied folder holding its own git folder would stop every commit: Claude's denyWrite outranks allowWrite
    expect(denied).not.toContain("/code/app/.git/worktrees");
    for (const d of denied) expect(git.own.startsWith(d + "/")).toBe(false);
    expect(s.permissions.deny).toEqual(expect.arrayContaining(["Edit(//code/app/.git/config)", "Edit(//code/app/.git/hooks/**)"]));
    expect(s.sandbox.filesystem.allowRead).toEqual(["/h/githooks", "/h/coauthors"]);
    // a main checkout's git folder is its own
    const main = settingsOf({ git: { common: "/code/app/.git", own: "/code/app/.git" }, hooks: [] });
    expect(main.sandbox.filesystem.allowWrite[0]).toBe("/code/app/.git");
    expect(main.sandbox.filesystem.denyWrite).toContain("/code/app/.git/worktrees");
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
