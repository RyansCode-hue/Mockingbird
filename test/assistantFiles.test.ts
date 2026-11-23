import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";
import type { AssistantTool } from "../src/main/assistant/registry";
import { FOLDER_LIMITS, FolderRefusal, MORE_SECRET_GLOBS, readPinned, secretWhy } from "../src/main/assistant/sessionFiles";
import { HELPDESK_FOLDER } from "../src/main/assistant/tools/files";
import { OUTPUT_LINES } from "../src/main/assistant/tools/diagnose";
import { SECRET_FILE_GLOBS } from "../src/main/secrets";
import { git, makeRepo, tempDir } from "./helpers";
import { fakeMac, helpdesk, info, teammate } from "./assistantWorkFakes";
import { harness } from "./assistantHarness";

/** A Mac with session a1 in a repository the test makes (in its HOME), `files` committed. */
function macWithRepo(files: Record<string, string> = {}) {
  const repo = makeRepo({ "README.md": "hello\n", ".gitignore": "build/\nlocal.txt\n", "src/index.ts": "export const a = 1;\n", ...files });
  const mac = fakeMac();
  mac.own.push(info("a1", { cwd: repo, title: "api-fix" }));
  return { mac, repo };
}

/** Run `name` as the service would: its check, and its run only when the check passes; the refusal or the parsed answer. */
async function call(t: AssistantTool, args: Record<string, unknown>): Promise<Record<string, any>> {
  const why = await t.check?.(args);
  if (why) return { refused: why };
  try {
    return JSON.parse((await t.run(args)).text);
  } catch (err) {
    return { error: (err as Error).message };
  }
}
const why = (r: Record<string, any>): string => r.refused ?? r.error ?? `(it read: ${JSON.stringify(r).slice(0, 200)})`;

describe("read_file", () => {
  it("reads a text file in the session's folder, all of it or a range of lines", async () => {
    const { mac } = macWithRepo({ "notes.md": "one\ntwo\nthree\nfour\n" });
    const r = await call(mac.tool("read_file"), { session: "a1", path: "notes.md" });
    expect(r).toEqual({ path: "notes.md", startLine: 1, endLine: 4, totalLines: 4, text: "one\ntwo\nthree\nfour", redacted: 0 });
    expect(await call(mac.tool("read_file"), { session: "a1", path: "./notes.md", startLine: 2, endLine: 3 })).toMatchObject({ startLine: 2, endLine: 3, text: "two\nthree" });
    expect(why(await call(mac.tool("read_file"), { session: "a1", path: "notes.md", startLine: 9 }))).toContain("has 4 lines: there's no line 9");
    expect(why(await call(mac.tool("read_file"), { session: "a1", path: "nope.md" }))).toContain("There's no nope.md");
    expect(why(await call(mac.tool("read_file"), { session: "a1", path: "src" }))).toContain("is a folder");
  });

  it("refuses an absolute path, and a path that climbs out with ..", async () => {
    const { mac, repo } = macWithRepo();
    for (const p of ["/etc/passwd", path.join(repo, "README.md"), "~/.zshrc"]) expect(why(await call(mac.tool("read_file"), { session: "a1", path: p }))).toContain("is an absolute path");
    for (const p of ["../outside.txt", "src/../../outside.txt", ".."]) expect(why(await call(mac.tool("read_file"), { session: "a1", path: p }))).toContain("climbs out of the session's folder");
    // a .. that stays inside is just a path
    expect(await call(mac.tool("read_file"), { session: "a1", path: "src/../README.md" })).toMatchObject({ path: "README.md", text: "hello" });
  });

  it("refuses a link that leads out of the folder, and one that leads to a secret inside it", async () => {
    const { mac, repo } = macWithRepo({ "config/app.env": "TOKEN=abc\n" });
    const outside = path.join(tempDir("outside"), "private.txt");
    fs.writeFileSync(outside, "not the session's\n");
    fs.symlinkSync(outside, path.join(repo, "link.txt"));
    fs.symlinkSync(path.dirname(outside), path.join(repo, "dirlink"));
    fs.symlinkSync(path.join(repo, "config/app.env"), path.join(repo, "harmless.txt"));
    expect(why(await call(mac.tool("read_file"), { session: "a1", path: "link.txt" }))).toContain("a link that leads outside the session's folder");
    expect(why(await call(mac.tool("read_file"), { session: "a1", path: "dirlink/private.txt" }))).toContain("leads outside the session's folder");
    expect(why(await call(mac.tool("read_file"), { session: "a1", path: "harmless.txt" }))).toContain("it leads to config/app.env");
  });

  it("refuses every secret-shaped name, at any depth, saying which pattern", async () => {
    const names = [".env", ".env.local", ".envrc", "prod.env", "server.pem", "tls.key", "cert.p12", "cert.pfx", "id_rsa", "id_ed25519", ".npmrc", ".netrc", ".pypirc", ".git-credentials", "credentials.json", "aws-credentials", "my-secret.txt", "secrets.json", "local.settings.json", "ado.pat", "secrets/config.yml", "deploy/Credentials/x.txt"];
    const { mac } = macWithRepo();
    for (const n of names) {
      const r = why(await call(mac.tool("read_file"), { session: "a1", path: n }));
      expect(r, n).toMatch(/looks like a secret's \(.+\): env files, keys, certificates and credentials are never read/);
    }
    // the patterns the slice names are all covered, beyond the shared list room sandboxes use
    for (const g of [".env*", "id_*", ".npmrc", ".netrc", "*credentials*", "*secret*"]) expect(MORE_SECRET_GLOBS).toContain(g);
    for (const g of ["*.pem", "*.key", "*.p12"]) expect(SECRET_FILE_GLOBS).toContain(g);
    expect(secretWhy("src/secretary/notes.md")).toContain("“secretary” in its path");
    expect(secretWhy("src/index.ts")).toBeNull();
  });

  it("refuses git's own files, ignored files, and this Mac's known secret files", async () => {
    const { mac, repo } = macWithRepo();
    expect(why(await call(mac.tool("read_file"), { session: "a1", path: ".git/config" }))).toContain("git's own data");
    fs.writeFileSync(path.join(repo, "local.txt"), "mine\n");
    fs.mkdirSync(path.join(repo, "build"));
    fs.writeFileSync(path.join(repo, "build/out.js"), "built\n");
    expect(why(await call(mac.tool("read_file"), { session: "a1", path: "local.txt" }))).toContain("git ignores it");
    expect(why(await call(mac.tool("read_file"), { session: "a1", path: "build/out.js" }))).toContain("git ignores it");
    fs.writeFileSync(path.join(repo, "token.txt"), "abc\n");
    mac.secretFiles.push(path.join(repo, "token.txt"));
    expect(why(await call(mac.tool("read_file"), { session: "a1", path: "token.txt" }))).toContain("one of this Mac's secret files");
  });

  it("refuses binary files, files over the size it reads, and text holding a private key", async () => {
    const { mac, repo } = macWithRepo();
    fs.writeFileSync(path.join(repo, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0x0d, 1, 2, 3]));
    fs.writeFileSync(path.join(repo, "big.log"), "x".repeat(FOLDER_LIMITS.readBytes + 1));
    fs.writeFileSync(path.join(repo, "notes.txt"), "keep this\n-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n");
    expect(why(await call(mac.tool("read_file"), { session: "a1", path: "logo.png" }))).toContain("is a binary file");
    expect(why(await call(mac.tool("read_file"), { session: "a1", path: "big.log" }))).toContain("the Assistant reads files up to 200 KB");
    expect(why(await call(mac.tool("read_file"), { session: "a1", path: "notes.txt" }))).toContain("holds a private key");
  });

  it("stops at its line and character caps, saying where to read on, and redacts what looks like a secret", async () => {
    const lines = Array.from({ length: 2_500 }, (_, i) => `line ${i + 1}`);
    const wide = Array.from({ length: 900 }, (_, i) => `${String(i + 1).padStart(4, "0")} ${"w".repeat(95)}`);
    const { mac } = macWithRepo({ "long.txt": `${lines.join("\n")}\n`, "wide.txt": `${wide.join("\n")}\n`, "conf.ts": 'const key = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";\n' });
    const long = await call(mac.tool("read_file"), { session: "a1", path: "long.txt" });
    expect(long).toMatchObject({ startLine: 1, endLine: FOLDER_LIMITS.readLines, totalLines: 2_500, cut: expect.stringContaining("read on from line 2001") });
    expect(await call(mac.tool("read_file"), { session: "a1", path: "long.txt", startLine: 2_001 })).toMatchObject({ startLine: 2_001, endLine: 2_500 });
    const w = await call(mac.tool("read_file"), { session: "a1", path: "wide.txt" });
    expect(w.text.length).toBeLessThanOrEqual(FOLDER_LIMITS.readChars);
    expect(w.endLine).toBeLessThan(900);
    expect(w.cut).toContain(`read on from line ${w.endLine + 1}`);
    const c = await call(mac.tool("read_file"), { session: "a1", path: "conf.ts" });
    expect(c.text).not.toContain("ghp_abcdef");
    expect(c.redacted).toBe(1);
  });

  it("reads only this Mac's sessions' folders: not a teammate's, not the Helpdesk workspace's, not the home folder", async () => {
    const { mac } = macWithRepo();
    mac.remote.push(teammate());
    mac.own.push(helpdesk("h1"), info("t1", { shell: true, cwd: os.homedir(), title: "home terminal" }));
    expect(why(await call(mac.tool("read_file"), { session: "r~nick~n1", path: "README.md" }))).toContain("its folder is on their Mac");
    expect(why(await call(mac.tool("read_file"), { session: "h1", path: "README.md" }))).toBe(HELPDESK_FOLDER);
    expect(why(await call(mac.tool("list_files"), { session: "h1" }))).toBe(HELPDESK_FOLDER);
    expect(why(await call(mac.tool("read_file"), { session: "t1", path: ".zshrc" }))).toContain("your home folder");
    expect(why(await call(mac.tool("read_file"), { session: "zz", path: "README.md" }))).toContain("no session with id");
  });

  it("never reads in home's credential folders or Mockingbird's, Claude Code's and Codex's own, whatever the session's folder", async () => {
    // this file's HOME is its own throwaway folder: these are made in it
    const mac = fakeMac();
    for (const [id, dir] of [["c1", ".claude/projects"], ["m1", ".mockingbird"], ["s1", ".ssh"]] as const) {
      fs.mkdirSync(path.join(os.homedir(), dir), { recursive: true });
      fs.writeFileSync(path.join(os.homedir(), dir, "x.txt"), "private\n");
      mac.own.push(info(id, { shell: true, cwd: path.join(os.homedir(), dir) }));
    }
    expect(why(await call(mac.tool("read_file"), { session: "c1", path: "x.txt" }))).toContain("it's in ~/.claude, and it's Claude Code's own data");
    expect(why(await call(mac.tool("list_files"), { session: "m1" }))).toContain("it's in ~/.mockingbird");
    expect(why(await call(mac.tool("read_file"), { session: "s1", path: "x.txt" }))).toContain("it's in ~/.ssh, and it holds ssh keys");
  });

  it("refuses a file whose folder is swapped for a link as it's read, kept or put back", async () => {
    const base = fs.realpathSync(tempDir("pinned"));
    const outside = path.join(base, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "notes.txt"), "elsewhere\n");
    const root = path.join(base, "root");
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    const file = path.join(root, "src", "notes.txt");
    fs.writeFileSync(file, "inside\n");
    const swap = async () => {
      fs.renameSync(path.join(root, "src"), path.join(root, "src.real"));
      fs.symlinkSync(outside, path.join(root, "src"));
    };
    const unswap = async () => {
      fs.unlinkSync(path.join(root, "src"));
      fs.renameSync(path.join(root, "src.real"), path.join(root, "src"));
    };
    expect((await readPinned(file, 1000)).content.toString()).toBe("inside\n");
    // the swap is still there when it's checked: the path no longer resolves to itself
    await expect(readPinned(file, 1000, swap)).rejects.toThrow(FolderRefusal);
    await unswap();
    // the open goes through the swapped folder, which is put back before the check: another file was opened
    await swap();
    await expect(readPinned(file, 1000, unswap)).rejects.toThrow(/changed as it was read/);
    // swapped before the open and still swapped at the check: the opened file is the one the path now names, but the path leads out
    await swap();
    await expect(readPinned(file, 1000)).rejects.toThrow(/changed as it was read/);
    await unswap();
    expect((await readPinned(file, 1000)).content.toString()).toBe("inside\n");
  });
});

describe("list_files", () => {
  it("lists what git tracks and the untracked files it doesn't ignore, leaving out secrets and saying so", async () => {
    const { mac, repo } = macWithRepo({ "src/app.ts": "x\n", ".env.example": "A=1\n" });
    fs.writeFileSync(path.join(repo, "new.ts"), "y\n");
    fs.writeFileSync(path.join(repo, "local.txt"), "ignored\n");
    fs.writeFileSync(path.join(repo, ".env"), "SECRET=1\n");
    const r = await call(mac.tool("list_files"), { session: "a1" });
    expect(r.files).toEqual([".gitignore", "README.md", "new.ts", "src/app.ts", "src/index.ts"]);
    expect(r.total).toBe(5);
    expect(r.leftOut).toEqual(["2 files whose names look like a secret's (env files, keys, certificates, credentials)", "whatever git ignores"]);
    expect(r.cut).toBeUndefined();
    expect((await call(mac.tool("list_files"), { session: "a1", glob: "*.ts" })).files).toEqual(["new.ts", "src/app.ts", "src/index.ts"]);
    expect((await call(mac.tool("list_files"), { session: "a1", path: "src", glob: "src/app.*" })).files).toEqual(["src/app.ts"]);
    expect(why(await call(mac.tool("list_files"), { session: "a1", path: "../" }))).toContain("climbs out");
    expect(why(await call(mac.tool("list_files"), { session: "a1", path: ".git" }))).toContain("git's own data");
    expect(why(await call(mac.tool("list_files"), { session: "a1", path: "README.md" }))).toContain("is a file: read_file reads it");
  });

  it("says when it cut the list", async () => {
    const files = Object.fromEntries(Array.from({ length: FOLDER_LIMITS.listFiles + 20 }, (_, i) => [`f/${String(i).padStart(4, "0")}.txt`, "x\n"]));
    const { mac } = macWithRepo(files);
    const r = await call(mac.tool("list_files"), { session: "a1", path: "f" });
    expect(r.files).toHaveLength(FOLDER_LIMITS.listFiles);
    expect(r.total).toBe(FOLDER_LIMITS.listFiles + 20);
    expect(r.cut).toContain(`first ${FOLDER_LIMITS.listFiles} of ${FOLDER_LIMITS.listFiles + 20}`);
  });

  it("walks a folder outside git, skipping hidden, dependency and build folders", async () => {
    const dir = path.join(tempDir("plain"), "proj");
    for (const f of ["a.txt", "sub/b.txt", "node_modules/m/index.js", ".cache/c.txt", "dist/out.js", "id_rsa"]) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), "x\n");
    }
    const mac = fakeMac();
    mac.own.push(info("t1", { shell: true, cwd: dir }));
    const r = await call(mac.tool("list_files"), { session: "t1" });
    expect(r.files).toEqual(["a.txt", "sub/b.txt"]);
    expect(r.leftOut).toEqual(["1 file whose name looks like a secret's (env files, keys, certificates, credentials)", "hidden folders, and dependency and build folders"]);
    expect(await call(mac.tool("read_file"), { session: "t1", path: "sub/b.txt" })).toMatchObject({ text: "x" });
  });
});

describe("a folder that isn't a repository's top", () => {
  it("outside git, refuses what a repository inside it ignores", async () => {
    const parent = path.join(tempDir("parent"), "work");
    fs.mkdirSync(parent);
    const repo = makeRepo({ ".gitignore": "local.json\n", "a.ts": "x\n" }, "inner", parent);
    fs.writeFileSync(path.join(repo, "local.json"), "{}\n");
    const mac = fakeMac();
    mac.own.push(info("t1", { shell: true, cwd: parent }));
    expect(why(await call(mac.tool("read_file"), { session: "t1", path: "inner/local.json" }))).toContain("git ignores it");
    expect(await call(mac.tool("read_file"), { session: "t1", path: "inner/a.ts" })).toMatchObject({ text: "x" });
  });

  it("below its repository's top, lists and diffs only that folder, by paths from it", async () => {
    const repo = makeRepo({ "pkg/a.ts": "a\n", "other/b.ts": "b\n" });
    fs.writeFileSync(path.join(repo, "pkg/a.ts"), "a2\n");
    fs.writeFileSync(path.join(repo, "other/b.ts"), "b2\n");
    const mac = fakeMac();
    mac.own.push(info("p1", { cwd: path.join(repo, "pkg") }));
    expect((await call(mac.tool("list_files"), { session: "p1" })).files).toEqual(["a.ts"]);
    const d = await call(mac.tool("git_diff"), { session: "p1" });
    expect(d.diff).toContain("diff --git a/a.ts b/a.ts");
    expect(d.diff).not.toContain("b2");
    expect(why(await call(mac.tool("read_file"), { session: "p1", path: "../other/b.ts" }))).toContain("climbs out");
  });
});

describe("git_diff", () => {
  it("gives the uncommitted diff and the untracked files, leaving out secret files by name and saying why", async () => {
    const { mac, repo } = macWithRepo({ "config/secrets.yml": "a: 1\n", "deploy/.env.prod": "A=1\n" });
    fs.writeFileSync(path.join(repo, "src/index.ts"), "export const a = 2;\n");
    fs.writeFileSync(path.join(repo, "config/secrets.yml"), "a: 2\n");
    fs.writeFileSync(path.join(repo, "deploy/.env.prod"), "A=2\n");
    fs.writeFileSync(path.join(repo, "added.ts"), "new\n");
    fs.writeFileSync(path.join(repo, "my-credentials.txt"), "x\n");
    const r = await call(mac.tool("git_diff"), { session: "a1" });
    expect(r.diff).toContain("-export const a = 1;");
    expect(r.diff).toContain("+export const a = 2;");
    expect(r.diff).not.toContain("a: 2");
    expect(r.diff).not.toContain("A=2");
    expect(r.leftOut.sort()).toEqual([
      expect.stringMatching(/^config\/secrets\.yml: “secrets\.yml” in its path looks like a secret's/),
      expect.stringMatching(/^deploy\/\.env\.prod: “\.env\.prod” in its path looks like a secret's/),
      expect.stringMatching(/^my-credentials\.txt \(untracked\): its name looks like a secret's/),
    ]);
    expect(r.untracked).toEqual(["added.ts"]);
    expect(r.against).toContain("its last commit");
  });

  it("gives one file's diff, or only what's staged; refuses a secret path and a folder outside git", async () => {
    const { mac, repo } = macWithRepo({ "a.ts": "a\n", "b.ts": "b\n" });
    fs.writeFileSync(path.join(repo, "a.ts"), "a2\n");
    fs.writeFileSync(path.join(repo, "b.ts"), "b2\n");
    git(repo, "add", "b.ts");
    const one = await call(mac.tool("git_diff"), { session: "a1", path: "a.ts" });
    expect(one.diff).toContain("+a2");
    expect(one.diff).not.toContain("+b2");
    const staged = await call(mac.tool("git_diff"), { session: "a1", staged: true });
    expect(staged.diff).toContain("+b2");
    expect(staged.diff).not.toContain("+a2");
    expect(staged.against).toContain("staged");
    expect(why(await call(mac.tool("git_diff"), { session: "a1", path: ".env" }))).toContain("looks like a secret's");
    expect(why(await call(mac.tool("git_diff"), { session: "a1", path: "/etc/hosts" }))).toContain("absolute path");
    const plain = tempDir("plain");
    mac.own.push(info("t1", { shell: true, cwd: plain }));
    expect(why(await call(mac.tool("git_diff"), { session: "t1" }))).toContain("isn't a git repository");
  });

  it("withholds a file whose diff holds a private key, and cuts a long diff saying where", async () => {
    const { mac, repo } = macWithRepo({ "notes.txt": "keep\n", "big.txt": "start\n" });
    fs.writeFileSync(path.join(repo, "notes.txt"), "keep\n-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----\n");
    fs.writeFileSync(path.join(repo, "big.txt"), Array.from({ length: 5_000 }, (_, i) => `changed line ${i}`).join("\n"));
    const r = await call(mac.tool("git_diff"), { session: "a1" });
    expect(r.diff).not.toContain("PRIVATE KEY");
    expect(r.leftOut).toContain("notes.txt: its diff holds a private key");
    expect(r.diff).toContain("[… cut at");
    expect(r.notes.join(" ")).toContain("The diff was cut");
  });

  it("is a read the service runs, never a change: no Undo, nothing in the activity log", async () => {
    const { mac, repo } = macWithRepo();
    fs.writeFileSync(path.join(repo, "README.md"), "changed\n");
    const h = harness(mac.registry.list());
    let answer: any;
    await h.turn("what did api-fix change", async (call) => ((answer = await call("git_diff", { session: "a1" })), "It changed the README."));
    expect(JSON.parse(answer.result).diff).toContain("+changed");
    expect(h.audit).toEqual([]);
    expect(mac.registry.get("git_diff")!.tier).toBe("read");
  });
});

describe("session_output", () => {
  it("gives a running session's recent output with escape codes taken out, its last 120 lines unless asked for more", async () => {
    const mac = fakeMac();
    mac.own.push(info("a1", { status: "working", title: "api-fix" }));
    const raw = Array.from({ length: 500 }, (_, i) => `\x1b[32mline ${i + 1}\x1b[0m`).join("\r\n");
    mac.deps.output = () => raw;
    const r = await call(mac.tool("session_output"), { session: "a1" });
    expect(r).toMatchObject({ id: "a1", title: "api-fix", state: "working", lines: OUTPUT_LINES });
    expect(r.output.split("\n")[0]).toBe("line 381");
    expect(r.output).not.toContain("\x1b");
    expect((await call(mac.tool("session_output"), { session: "a1", lines: 5 })).output).toBe("line 496\nline 497\nline 498\nline 499\nline 500");
    // the schema stops past its most
    const h = harness(mac.registry.list());
    let answer: unknown;
    await h.turn("all of it", async (call) => ((answer = await call("session_output", { session: "a1", lines: 5_000 })), "No."));
    expect(answer).toEqual({ error: expect.stringContaining("must be at most 400") });
  });

  it("redacts what looks like a secret, cuts by characters too, and reads an exited or closed session's", async () => {
    const mac = fakeMac();
    mac.own.push(info("a1", { status: "dead", exitCode: 1 }));
    mac.closed.push(info("c1"));
    mac.deps.output = (id) => (id === "a1" ? `export GH=ghp_abcdefghijklmnopqrstuvwxyz0123456789\nfailed\n` : Array.from({ length: 300 }, () => "y".repeat(200)).join("\n"));
    const a = await call(mac.tool("session_output"), { session: "a1" });
    expect(a).toMatchObject({ state: "exited", redacted: expect.stringContaining("1 secret-looking value") });
    expect(a.output).not.toContain("ghp_abc");
    const c = await call(mac.tool("session_output"), { session: "c1", lines: 300 });
    expect(c.state).toBe("closed");
    expect(c.lines).toBeLessThan(300);
    expect(c.cut).toContain("more than 24,000 characters");
  });

  it("never reads the Helpdesk workspace's, and a teammate's only as this Mac mirrors it", async () => {
    const mac = fakeMac();
    mac.own.push(helpdesk("h1"));
    mac.remote.push(teammate());
    mac.deps.output = () => "secret admin page";
    expect(why(await call(mac.tool("session_output"), { session: "h1" }))).toContain("Helpdesk tasks workspace's conversation");
    expect(why(await call(mac.tool("session_output"), { session: "r~nick~n1" }))).toContain("its terminal isn't open here, so this Mac holds no copy of its output");
    mac.mirrors.set("r~nick~n1", "\x1b[1mnpm test\x1b[0m\r\n3 failing\r\n");
    const r = await call(mac.tool("session_output"), { session: "r~nick~n1" });
    expect(r).toMatchObject({ output: "npm test\n3 failing", from: expect.stringContaining("Nick's terminal") });
    expect(mac.did.filter((x) => x.startsWith("output"))).toEqual([]);
  });
});
