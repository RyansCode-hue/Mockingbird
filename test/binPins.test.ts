import * as fs from "fs";
import * as path from "path";
import { describe, expect, it, vi } from "vitest";
import { BinPins, readVersionAt } from "../src/main/binPins";
import { tempDir } from "./helpers";

/** A Claude Code install as the native installer lays it out: versions/<x.y.z> files, and a link to one of them. */
function install(versions: string[]) {
  const dir = tempDir("claude-install");
  fs.mkdirSync(path.join(dir, "versions"));
  fs.mkdirSync(path.join(dir, "bin"));
  for (const v of versions) write(path.join(dir, "versions", v), v);
  const link = path.join(dir, "bin", "claude");
  const point = (v: string) => {
    fs.rmSync(link, { force: true });
    fs.symlinkSync(path.join(dir, "versions", v), link);
  };
  point(versions[0]);
  return { link, point, file: (v: string) => fs.realpathSync(path.join(dir, "versions", v)) };
}

/** A stand-in binary that says `version` when asked, as `claude --version` does. */
function write(file: string, version: string) {
  fs.writeFileSync(file, `#!/bin/sh\n[ "$1" = --version ] && echo "${version} (Claude Code)"\nexit 0\n`, { mode: 0o755 });
}

describe("the file a Claude room launch runs", () => {
  it("is the one its link names as it starts, at the version that file says, read once for each file", async () => {
    const claude = install(["2.1.320", "2.1.321"]);
    const reads: string[] = [];
    const pins = new BinPins((file) => (reads.push(file), readVersionAt(file)));
    expect(await pins.pin(claude.link)).toEqual({ bin: claude.file("2.1.320"), version: "2.1.320" });
    expect(await pins.pin(claude.link)).toEqual({ bin: claude.file("2.1.320"), version: "2.1.320" });
    expect(reads).toEqual([claude.file("2.1.320")]);
    // Claude Code updated between launches: the next one runs, and is read at, the new file
    claude.point("2.1.321");
    expect(await pins.pin(claude.link)).toEqual({ bin: claude.file("2.1.321"), version: "2.1.321" });
    expect(reads).toEqual([claude.file("2.1.320"), claude.file("2.1.321")]);
  }, 30_000);

  it("reads a file rewritten where it is (an npm update) again, and a burst of launches reads it once", async () => {
    const claude = install(["2.1.320"]);
    const reads: string[] = [];
    const pins = new BinPins((file) => (reads.push(file), readVersionAt(file)));
    const burst = await Promise.all([pins.pin(claude.link), pins.pin(claude.link), pins.pin(claude.link)]);
    expect(burst.map((p) => p.version)).toEqual(["2.1.320", "2.1.320", "2.1.320"]);
    expect(reads).toHaveLength(1);
    write(claude.file("2.1.320"), "2.1.3200");
    expect(await pins.pin(claude.link)).toEqual({ bin: claude.file("2.1.320"), version: "2.1.3200" });
    expect(reads).toHaveLength(2);
  }, 30_000);

  it("reads a version that couldn't be read again on the next launch, and says why it couldn't", async () => {
    const claude = install(["2.1.320"]);
    const answers: (string | null)[] = [null, "2.1.320"];
    const pins = new BinPins(async () => answers.shift() ?? null);
    expect(await pins.pin(claude.link)).toEqual({ bin: claude.file("2.1.320"), version: null });
    expect(await pins.pin(claude.link)).toEqual({ bin: claude.file("2.1.320"), version: "2.1.320" });
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken = path.join(tempDir("not-claude"), "claude");
    fs.writeFileSync(broken, "#!/bin/sh\necho 'command not found' >&2\nexit 127\n", { mode: 0o755 });
    expect(await new BinPins(readVersionAt).pin(broken)).toEqual({ bin: fs.realpathSync(broken), version: null });
    expect(warned.mock.calls.map((c) => String(c[0]))).toEqual([`[sessions] couldn't read the version of ${fs.realpathSync(broken)}: command not found`]);
    warned.mockRestore();
  }, 30_000);

  it("leaves a binary that isn't there as it is, with no version: the pane's own shell says it isn't found", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const read = vi.fn(async () => "2.1.320");
    const pins = new BinPins(read);
    expect(await pins.pin("claude")).toEqual({ bin: "claude", version: null });
    const gone = path.join(tempDir("gone"), "claude");
    expect(await pins.pin(gone)).toEqual({ bin: gone, version: null });
    expect(read).not.toHaveBeenCalled();
    expect(warned.mock.calls.map((c) => String(c[0]))).toEqual([expect.stringMatching(/^\[sessions\] couldn't resolve .*claude to the file it runs: ENOENT/)]);
    warned.mockRestore();
  });
});
