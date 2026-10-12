import { execFile } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { isMissing, readJsonOrSetAside, writeFileAtomic } from "../fileOps";
import { MAX_ARTIFACT_FILE, SHA256_RE, ARTIFACT_ID_RE, safeArtifactFileName, type ArtifactView } from "../../shared/team/artifacts";

/**
 * A room's artifact files on this Mac, inside the room's folder (so leaving
 * the room deletes them):
 *
 *   artifacts/blobs/<sha256>          0400, hash verified: the only files ever served
 *   artifacts/partial/<sha256>        a download in progress, resumed from its length
 *   artifacts/tmp/<random>            a file being added (hashed as it's copied); cleared on start
 *   artifacts/view/<id>/<name>        0444 copies for Quick Look, Reveal and Save as, quarantined
 *   artifacts/sniff.json              what each blob's content is (sniffContent)
 *
 * File names on disk never come from what a teammate wrote: a blob is named by
 * a hash checked against SHA256_RE before any path is made of it, and a copy
 * by safeArtifactFileName, checked to stay inside its folder.
 */

/** Images bigger than this many pixels open in Quick Look, not in the viewer. */
export const MAX_INLINE_PIXELS = 50_000_000;
/** How much of a file's start sniffing looks at (images' sizes, SVG's root element). */
const HEAD_BYTES = 1024 * 1024;
const PRIVATE_KEY_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;

/** What a file is, from its content: how the viewer may show it, and whether it holds a private key. */
export interface Sniff {
  view: ArtifactView;
  mime: string;
  privateKey: boolean;
  width?: number;
  height?: number;
}

/** A file's bytes as they stream past: its hash, its size, and what sniffing needs. */
export class ContentScan {
  private hash = crypto.createHash("sha256");
  private decoder = new TextDecoder("utf-8", { fatal: true });
  private headParts: Buffer[] = [];
  private headSize = 0;
  private tail = "";
  size = 0;
  utf8 = true;
  nul = false;
  privateKey = false;

  push(chunk: Buffer): void {
    this.hash.update(chunk);
    this.size += chunk.length;
    if (this.headSize < HEAD_BYTES) {
      const part = chunk.subarray(0, HEAD_BYTES - this.headSize);
      this.headParts.push(Buffer.from(part));
      this.headSize += part.length;
    }
    if (!this.nul && chunk.includes(0)) this.nul = true;
    if (this.utf8) {
      try {
        this.decoder.decode(chunk, { stream: true });
      } catch {
        this.utf8 = false;
      }
    }
    if (!this.privateKey) {
      const text = this.tail + chunk.toString("latin1");
      if (PRIVATE_KEY_RE.test(text)) this.privateKey = true;
      this.tail = text.slice(-64);
    }
  }

  finish(): { sha256: string; size: number; head: Buffer; utf8: boolean; nul: boolean; privateKey: boolean } {
    if (this.utf8) {
      try {
        this.decoder.decode();
      } catch {
        this.utf8 = false; // ends inside a character
      }
    }
    return { sha256: this.hash.digest("hex"), size: this.size, head: Buffer.concat(this.headParts), utf8: this.utf8, nul: this.nul, privateKey: this.privateKey };
  }
}

const startsWith = (b: Buffer, bytes: number[], at = 0) => b.length >= at + bytes.length && bytes.every((x, i) => b[at + i] === x);
const ascii = (b: Buffer, s: string, at = 0) => b.length >= at + s.length && b.toString("latin1", at, at + s.length) === s;

/** An image's size from its header (PNG, GIF, BMP, WebP, JPEG), or null when it can't be read. */
export function imageSize(b: Buffer): { width: number; height: number } | null {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47]) && b.length >= 24) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if ((ascii(b, "GIF87a") || ascii(b, "GIF89a")) && b.length >= 10) return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (ascii(b, "BM") && b.length >= 26) return { width: Math.abs(b.readInt32LE(18)), height: Math.abs(b.readInt32LE(22)) };
  if (ascii(b, "RIFF") && ascii(b, "WEBP", 8) && b.length >= 30) {
    if (ascii(b, "VP8X", 12)) return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (ascii(b, "VP8L", 12)) {
      const bits = b.readUInt32LE(21);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
    }
    if (ascii(b, "VP8 ", 12)) return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    return null;
  }
  if (startsWith(b, [0xff, 0xd8])) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xff) {
        i++;
        continue;
      }
      const len = b.readUInt16BE(i + 2);
      // start-of-frame markers (not DHT, JPG or DAC)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
      i += 2 + len;
    }
  }
  return null;
}

const IMAGE_TYPES: [string, (b: Buffer) => boolean][] = [
  ["image/png", (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  ["image/jpeg", (b) => startsWith(b, [0xff, 0xd8, 0xff])],
  ["image/gif", (b) => ascii(b, "GIF87a") || ascii(b, "GIF89a")],
  ["image/webp", (b) => ascii(b, "RIFF") && ascii(b, "WEBP", 8)],
  ["image/bmp", (b) => ascii(b, "BM") && b.length >= 26],
];

const SVG_RE = /^﻿?\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE\s+svg[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i;

/**
 * How a file may be shown, from its content against an allowlist: PNG, JPEG,
 * GIF, WebP, BMP and SVG are images (shown only through <img>; one over
 * MAX_INLINE_PIXELS opens in Quick Look instead), PDF opens in Quick Look,
 * UTF-8 text without NULs is text (markdown or CSV by its name's extension);
 * anything else — HTML included, which is just text — is a binary file. The
 * name's extension and a teammate's declared type never make something an
 * image or a PDF.
 */
export function sniffContent(scan: { head: Buffer; utf8: boolean; nul: boolean; privateKey: boolean }, name: string): Sniff {
  const { head, privateKey } = scan;
  for (const [mime, is] of IMAGE_TYPES) {
    if (!is(head)) continue;
    const size = imageSize(head);
    if (size && size.width * size.height > MAX_INLINE_PIXELS) return { view: "binary", mime, privateKey, ...size };
    return { view: "image", mime, privateKey, ...(size ?? {}) };
  }
  if (ascii(head, "%PDF-")) return { view: "pdf", mime: "application/pdf", privateKey };
  if (scan.utf8 && !scan.nul) {
    if (SVG_RE.test(head.toString("utf8", 0, Math.min(head.length, 4096)))) return { view: "image", mime: "image/svg+xml", privateKey };
    const ext = path.extname(name).toLowerCase();
    if (ext === ".md" || ext === ".markdown" || ext === ".mdown") return { view: "markdown", mime: "text/markdown", privateKey };
    if (ext === ".csv") return { view: "csv", mime: "text/csv", privateKey };
    return { view: "text", mime: "text/plain", privateKey };
  }
  return { view: "binary", mime: "application/octet-stream", privateKey };
}

/** The extension a copy of the file gets: images and PDFs by their content, others keep their own. */
export function copyExtension(sniff: Pick<Sniff, "view" | "mime">): string | undefined {
  if (sniff.view !== "image" && sniff.view !== "pdf" && !(sniff.view === "binary" && sniff.mime.startsWith("image/"))) return undefined;
  return { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp", "image/svg+xml": "svg", "application/pdf": "pdf" }[sniff.mime];
}

/** A size for people: "812 B", "2.4 MB". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Whether `p` is `dir` or inside it (both as given: resolve symlinks first where it matters). */
export function inside(dir: string, p: string): boolean {
  const rel = path.relative(dir, p);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

const realpathOr = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch (err) {
    if (isMissing(err)) return path.resolve(p);
    throw err;
  }
};

/** A file someone asked to add, checked: where it really is and how big. Throws the reason it can't be added. */
export function checkAddable(file: string, guard: { never: string[]; secretFiles: string[] }): { real: string; size: number } {
  try {
    fs.lstatSync(file);
  } catch (err) {
    throw new Error(isMissing(err) ? "It isn't there any more" : `It can't be read: ${(err as Error).message}`);
  }
  const real = fs.realpathSync(file);
  const st = fs.statSync(real);
  if (st.isDirectory()) throw new Error("It's a folder: add the files in it");
  if (!st.isFile()) throw new Error("It isn't a regular file");
  if (st.size > MAX_ARTIFACT_FILE) throw new Error(`It's ${formatBytes(st.size)}; a room's files can be at most ${formatBytes(MAX_ARTIFACT_FILE)}`);
  for (const dir of guard.never) if (inside(realpathOr(dir), real)) throw new Error("It's in Mockingbird's team folder, which is never shared");
  for (const secret of guard.secretFiles) if (realpathOr(secret) === real) throw new Error("It's your Azure DevOps PAT file, which is never shared");
  return { real, size: st.size };
}

/** A file being added, hashed and sniffed in tmp/: kept as a blob, or dropped. */
export interface Ingested {
  sha256: string;
  size: number;
  sniff: Sniff;
  /** Into blobs/ (verified by construction: it's what was hashed). */
  keep(): void;
  drop(): void;
}

export class ArtifactStore {
  readonly dir: string;
  private sniffs: Record<string, Sniff> | null = null;
  private closed = false;

  constructor(roomDir: string) {
    this.dir = path.join(roomDir, "artifacts");
  }

  private sub(name: "blobs" | "partial" | "tmp" | "view"): string {
    return path.join(this.dir, name);
  }

  /** This install left the room: nothing writes here again (a download finishing late can't bring back a folder being deleted). */
  close(): void {
    this.closed = true;
  }

  private writable(): void {
    if (this.closed) throw new Error("this Mac isn't in the room any more");
  }

  /** The store's folders, owner-only. */
  ensure(): void {
    this.writable();
    for (const d of [this.dir, this.sub("blobs"), this.sub("partial"), this.sub("tmp"), this.sub("view")]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  }

  /** Adds cut short by quitting leave files in tmp/: gone. */
  clearTmp(): void {
    fs.rmSync(this.sub("tmp"), { recursive: true, force: true });
  }

  blobPath(sha: string): string {
    if (!SHA256_RE.test(sha)) throw new Error(`not a content hash: ${sha.slice(0, 80)}`);
    return path.join(this.sub("blobs"), sha);
  }

  partialPath(sha: string): string {
    if (!SHA256_RE.test(sha)) throw new Error(`not a content hash: ${sha.slice(0, 80)}`);
    return path.join(this.sub("partial"), sha);
  }

  /** A verified blob's size, or null when it isn't here. */
  blobSize(sha: string): number | null {
    try {
      return fs.statSync(this.blobPath(sha)).size;
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  }

  /** A download's length so far (0 when none). */
  partialSize(sha: string): number {
    try {
      return fs.statSync(this.partialPath(sha)).size;
    } catch (err) {
      if (isMissing(err)) return 0;
      throw err;
    }
  }

  /** Copy a file (or bytes) into tmp/, hashing and sniffing it as it goes. At most MAX_ARTIFACT_FILE bytes. */
  async ingest(source: { file: string } | { bytes: Uint8Array }, name: string): Promise<Ingested> {
    this.ensure();
    const tmp = path.join(this.sub("tmp"), crypto.randomBytes(12).toString("hex"));
    const scan = new ContentScan();
    try {
      if ("bytes" in source) {
        if (source.bytes.length > MAX_ARTIFACT_FILE) throw new Error(`It's ${formatBytes(source.bytes.length)}; a room's files can be at most ${formatBytes(MAX_ARTIFACT_FILE)}`);
        const buf = Buffer.from(source.bytes.buffer, source.bytes.byteOffset, source.bytes.byteLength);
        scan.push(buf);
        fs.writeFileSync(tmp, buf, { mode: 0o600 });
      } else {
        await new Promise<void>((resolve, reject) => {
          const out = fs.createWriteStream(tmp, { mode: 0o600 });
          const input = fs.createReadStream(source.file);
          input.on("data", (chunk) => {
            scan.push(chunk as Buffer);
            if (scan.size > MAX_ARTIFACT_FILE) input.destroy(new Error(`It grew past ${formatBytes(MAX_ARTIFACT_FILE)} while it was being read`));
          });
          input.on("error", (err) => {
            out.destroy();
            reject(err);
          });
          out.on("error", reject);
          out.on("finish", resolve);
          input.pipe(out);
        });
      }
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
    const done = scan.finish();
    const sniff = sniffContent(done, name);
    return {
      sha256: done.sha256,
      size: done.size,
      sniff,
      keep: () => {
        this.writable();
        const blob = this.blobPath(done.sha256);
        if (this.blobSize(done.sha256) === done.size) fs.rmSync(tmp, { force: true });
        else {
          fs.chmodSync(tmp, 0o400);
          fs.renameSync(tmp, blob);
        }
        this.rememberSniff(done.sha256, sniff);
      },
      drop: () => fs.rmSync(tmp, { force: true }),
    };
  }

  /** Bytes a teammate sent, appended to a download. */
  appendPartial(sha: string, data: Buffer): void {
    this.ensure();
    fs.appendFileSync(this.partialPath(sha), data, { mode: 0o600 });
  }

  dropPartial(sha: string): void {
    fs.rmSync(this.partialPath(sha), { force: true });
  }

  /** A finished download: hashed again; kept as the blob when it matches, else deleted. Resolves with whether it matched. */
  async completePartial(sha: string, name: string): Promise<boolean> {
    const file = this.partialPath(sha);
    const scan = new ContentScan();
    await new Promise<void>((resolve, reject) => {
      fs.createReadStream(file)
        .on("data", (c) => scan.push(c as Buffer))
        .on("error", reject)
        .on("end", resolve);
    });
    const done = scan.finish();
    if (done.sha256 !== sha) {
      this.dropPartial(sha);
      return false;
    }
    this.writable();
    fs.chmodSync(file, 0o400);
    fs.renameSync(file, this.blobPath(sha));
    this.rememberSniff(sha, sniffContent(done, name));
    return true;
  }

  /** What a blob's content is (sniffed once, then remembered); null when the blob isn't here. */
  async sniffOf(sha: string, name: string): Promise<Sniff | null> {
    if (this.blobSize(sha) === null) return null;
    const known = this.loadSniffs()[sha];
    if (known) return this.byName(known, name);
    const scan = new ContentScan();
    await new Promise<void>((resolve, reject) => {
      fs.createReadStream(this.blobPath(sha))
        .on("data", (c) => scan.push(c as Buffer))
        .on("error", reject)
        .on("end", resolve);
    });
    const sniff = sniffContent(scan.finish(), name);
    this.rememberSniff(sha, sniff);
    return sniff;
  }

  /** A remembered sniff, synchronously (the list's summary); null until sniffed. */
  knownSniff(sha: string, name: string): Sniff | null {
    const s = this.loadSniffs()[sha];
    return s ? this.byName(s, name) : null;
  }

  /** Text is markdown or CSV by the name it has now (renames change it). */
  private byName(s: Sniff, name: string): Sniff {
    if (s.view !== "text" && s.view !== "markdown" && s.view !== "csv") return s;
    const again = sniffContent({ head: Buffer.from(""), utf8: true, nul: false, privateKey: s.privateKey }, name);
    return { ...s, view: again.view, mime: again.mime };
  }

  private loadSniffs(): Record<string, Sniff> {
    if (!this.sniffs) {
      const v = readJsonOrSetAside(path.join(this.dir, "sniff.json"), {}, "the room artifacts' content types");
      this.sniffs = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, Sniff>) : {};
    }
    return this.sniffs;
  }

  private rememberSniff(sha: string, s: Sniff): void {
    const all = this.loadSniffs();
    all[sha] = s;
    if (this.closed) return;
    writeFileAtomic(path.join(this.dir, "sniff.json"), JSON.stringify(all));
  }

  /** Up to `length` bytes of a blob from `offset`. */
  readBlob(sha: string, offset: number, length: number): Buffer {
    const fd = fs.openSync(this.blobPath(sha), "r");
    try {
      const buf = Buffer.alloc(length);
      const n = fs.readSync(fd, buf, 0, length, offset);
      return buf.subarray(0, n);
    } finally {
      fs.closeSync(fd);
    }
  }

  /**
   * A read-only copy of an artifact's file for Quick Look, Reveal in Finder
   * and Save as (made once, an APFS clone where it can be): view/<id>/<name>,
   * quarantined. Returns its path, and a warning when quarantining failed.
   */
  async viewCopy(id: string, sha: string, name: string, sniff: Sniff): Promise<{ path: string; warning: string | null }> {
    this.writable();
    if (!ARTIFACT_ID_RE.test(id)) throw new Error("not an artifact id");
    const folder = path.join(this.sub("view"), id);
    const file = path.join(folder, safeArtifactFileName(name, copyExtension(sniff)));
    if (!inside(folder, file) || path.dirname(file) !== folder) throw new Error("the artifact's name can't be a file name");
    if (fs.existsSync(file)) return { path: file, warning: null };
    fs.rmSync(folder, { recursive: true, force: true }); // a copy under an older name
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    fs.copyFileSync(this.blobPath(sha), file, fs.constants.COPYFILE_FICLONE);
    // marked before it's made read-only: setting an attribute needs write permission
    fs.chmodSync(file, 0o644);
    const warning = await quarantine(file);
    fs.chmodSync(file, 0o444);
    return { path: file, warning };
  }

  /** The verified blobs here. */
  blobs(): string[] {
    try {
      return fs.readdirSync(this.sub("blobs")).filter((n) => SHA256_RE.test(n));
    } catch (err) {
      if (isMissing(err)) return [];
      throw err;
    }
  }

  /**
   * Delete blobs and downloads no live file artifact uses, and view copies of
   * artifacts that are gone. Returns what couldn't be deleted.
   */
  gc(liveShas: ReadonlySet<string>, liveIds: ReadonlySet<string>): string[] {
    const problems: string[] = [];
    const sweep = (dir: string, keep: (name: string) => boolean, isOurs: (name: string) => boolean) => {
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch (err) {
        if (isMissing(err)) return;
        problems.push(`${dir} couldn't be read: ${(err as Error).message}`);
        return;
      }
      for (const n of names) {
        if (!isOurs(n) || keep(n)) continue;
        try {
          fs.rmSync(path.join(dir, n), { recursive: true, force: true });
        } catch (err) {
          problems.push(`${path.join(dir, n)} couldn't be deleted: ${(err as Error).message}`);
        }
      }
    };
    sweep(this.sub("blobs"), (n) => liveShas.has(n), (n) => SHA256_RE.test(n));
    sweep(this.sub("partial"), (n) => liveShas.has(n), (n) => SHA256_RE.test(n));
    sweep(this.sub("view"), (n) => liveIds.has(n), (n) => ARTIFACT_ID_RE.test(n));
    if (this.sniffs || fs.existsSync(path.join(this.dir, "sniff.json"))) {
      const all = this.loadSniffs();
      const kept = Object.fromEntries(Object.entries(all).filter(([sha]) => liveShas.has(sha)));
      if (Object.keys(kept).length !== Object.keys(all).length) {
        this.sniffs = kept;
        try {
          writeFileAtomic(path.join(this.dir, "sniff.json"), JSON.stringify(kept));
        } catch (err) {
          problems.push(`the artifacts' content types couldn't be saved: ${(err as Error).message}`);
        }
      }
    }
    return problems;
  }
}

/**
 * Mark a file as downloaded from elsewhere (com.apple.quarantine), as a
 * browser would: Gatekeeper checks it before anything runs it. Resolves with
 * a warning when it couldn't be marked, else null.
 */
export function quarantine(file: string): Promise<string | null> {
  const value = `0081;${Math.floor(Date.now() / 1000).toString(16)};Mockingbird;`;
  return new Promise((resolve) => {
    execFile("xattr", ["-w", "com.apple.quarantine", value, file], { timeout: 10_000 }, (err, _out, stderr) =>
      resolve(err ? `${path.basename(file)} couldn't be marked as downloaded (quarantine): ${String(stderr).trim() || err.message}` : null)
    );
  });
}
