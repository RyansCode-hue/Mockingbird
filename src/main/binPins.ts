import * as fs from "fs";
import * as path from "path";
import { cliVersion } from "./agents";
import { loginShell, quote } from "./shell";

/**
 * The file one launch runs. Claude Code updates itself by pointing its link (~/.local/bin/claude) at a new file, so
 * the link followed twice — by a pane and by the sandbox check beside it, or by a version read minutes before — can
 * name two releases. A room launch resolves the link once, and the pane, its check and its version are all that file's.
 */
export interface PinnedBin {
  /** The file behind the link: what the pane runs, and what's run to check it. */
  bin: string;
  /** That file's version, as it says when run; null when it couldn't be read. */
  version: string | null;
}

/** A file's version as it says, run in the user's login shell (a script's interpreter comes from their PATH). */
export async function readVersionAt(file: string): Promise<string | null> {
  const r = await loginShell(`${quote(file)} --version`, { timeoutMs: 20_000 });
  const v = r.code === 0 ? cliVersion(r.out) : null;
  if (!v) console.warn(`[sessions] couldn't read the version of ${file}: ${(r.stderr.trim() || r.out.trim()).slice(0, 200) || `it exited with code ${r.code}`}`);
  return v;
}

export class BinPins {
  /**
   * Versions read, by file and by what the file is (device, inode, size, times): a native install's versions are
   * files of their own, and one rewritten where it is (an npm update) is another file and read again.
   */
  private readonly versions = new Map<string, Promise<string | null>>();

  constructor(private readonly read: (file: string) => Promise<string | null>) {}

  /** `bin` resolved to the file it names now, and that file's version. A bare name (not found) stays as it is. */
  async pin(bin: string): Promise<PinnedBin> {
    if (!path.isAbsolute(bin)) return { bin, version: null };
    let file: string;
    let id: string;
    try {
      file = fs.realpathSync(bin);
      const st = fs.statSync(file);
      id = `${file}\0${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
    } catch (err) {
      console.warn(`[sessions] couldn't resolve ${bin} to the file it runs: ${(err as Error).message}`);
      return { bin, version: null };
    }
    let read = this.versions.get(id);
    if (!read) {
      const reading = this.read(file).catch((err): null => {
        console.warn(`[sessions] couldn't read the version of ${file}: ${(err as Error).message}`);
        return null;
      });
      this.versions.set(id, reading);
      // one that couldn't be read is read again by the next launch
      void reading.then((v) => {
        if (!v && this.versions.get(id) === reading) this.versions.delete(id);
      });
      read = reading;
    }
    return { bin: file, version: await read };
  }
}
