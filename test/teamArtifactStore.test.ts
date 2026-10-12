import { execFileSync } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";
import { ArtifactStore, checkAddable, ContentScan, copyExtension, imageSize, inside, MAX_INLINE_PIXELS, sniffContent } from "../src/main/team/artifactStore";
import { TEAM_DIR } from "../src/main/team/identity";
import { MAX_ARTIFACT_FILE, safeArtifactFileName } from "../src/shared/team/artifacts";

const scanOf = (bytes: Buffer | string) => {
  const s = new ContentScan();
  s.push(Buffer.from(bytes));
  return s.finish();
};
const sniff = (bytes: Buffer | string, name: string) => sniffContent(scanOf(bytes), name);

const png = (w: number, h: number) => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};
const jpeg = (w: number, h: number) =>
  Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
    Buffer.alloc(14),
    Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x03]),
    Buffer.alloc(16),
  ]);
const sha = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");

describe("what a file is, from its content", () => {
  it("recognises the allowed image types, PDFs and text — never by name alone", () => {
    expect(sniff(png(10, 20), "x.bin")).toMatchObject({ view: "image", mime: "image/png", width: 10, height: 20 });
    expect(sniff(jpeg(640, 480), "x")).toMatchObject({ view: "image", mime: "image/jpeg", width: 640, height: 480 });
    expect(sniff(Buffer.concat([Buffer.from("GIF89a"), Buffer.from([3, 0, 4, 0]), Buffer.alloc(10)]), "a.gif")).toMatchObject({ view: "image", mime: "image/gif", width: 3, height: 4 });
    expect(sniff("%PDF-1.7\n...", "report")).toMatchObject({ view: "pdf", mime: "application/pdf" });
    expect(sniff(`<?xml version="1.0"?>\n<!-- logo -->\n<svg xmlns="http://www.w3.org/2000/svg"></svg>`, "logo.txt")).toMatchObject({ view: "image", mime: "image/svg+xml" });
    expect(sniff("# Title\n\ntext", "README.md")).toMatchObject({ view: "markdown" });
    expect(sniff("a,b\n1,2\n", "data.csv")).toMatchObject({ view: "csv" });
    expect(sniff("plain words", "notes")).toMatchObject({ view: "text", mime: "text/plain" });
    // HTML is text whatever it's called; a PNG name doesn't make it an image
    expect(sniff("<html><script>alert(1)</script></html>", "cat.png")).toMatchObject({ view: "text", mime: "text/plain" });
    expect(sniff("<html><body><svg></svg></body></html>", "page.svg")).toMatchObject({ view: "text" });
    expect(sniff(Buffer.from([0x00, 0x01, 0x02, 0xff]), "x.txt")).toMatchObject({ view: "binary", mime: "application/octet-stream" });
    expect(sniff(Buffer.from([0xc3, 0x28]), "bad-utf8.txt")).toMatchObject({ view: "binary" });
    expect(sniff("", "empty.txt")).toMatchObject({ view: "text" });
  });

  it("sends an image over the pixel limit to Quick Look", () => {
    expect(sniff(png(10_000, 6_000), "big.png")).toMatchObject({ view: "binary", mime: "image/png" });
    expect(10_000 * 6_000).toBeGreaterThan(MAX_INLINE_PIXELS);
    expect(copyExtension({ view: "binary", mime: "image/png" })).toBe("png");
    expect(copyExtension({ view: "text", mime: "text/plain" })).toBeUndefined();
    expect(imageSize(Buffer.from("not an image"))).toBeNull();
  });

  it("finds a private key anywhere in the file, even across chunks", () => {
    expect(sniff("hello", "a.txt").privateKey).toBe(false);
    expect(sniff("x\n-----BEGIN OPENSSH PRIVATE KEY-----\nabc", "id").privateKey).toBe(true);
    expect(sniff("-----BEGIN RSA PRIVATE KEY-----", "k").privateKey).toBe(true);
    const s = new ContentScan();
    s.push(Buffer.from(`${"x".repeat(5000)}-----BEGIN PRIV`));
    s.push(Buffer.from("ATE KEY-----\n"));
    expect(s.finish().privateKey).toBe(true);
    expect(sniff("-----BEGIN PUBLIC KEY-----", "pub").privateKey).toBe(false);
  });
});

describe("adding a file", () => {
  const guard = { never: [TEAM_DIR], secretFiles: [] as string[] };

  it("refuses folders, symlinks to folders, oversized files, the team folder and the PAT file", () => {
    const dir = tempDir("adds");
    fs.mkdirSync(path.join(dir, "folder"));
    fs.symlinkSync(path.join(dir, "folder"), path.join(dir, "link"));
    const big = path.join(dir, "big.bin");
    fs.writeFileSync(big, "");
    fs.truncateSync(big, MAX_ARTIFACT_FILE + 1);
    fs.mkdirSync(path.join(TEAM_DIR, "rooms"), { recursive: true });
    const teamFile = path.join(TEAM_DIR, "identity.json");
    fs.writeFileSync(teamFile, "{}");
    fs.symlinkSync(teamFile, path.join(dir, "sneaky"));
    const pat = path.join(dir, "ado.pat");
    fs.writeFileSync(pat, "secret");
    expect(() => checkAddable(path.join(dir, "folder"), guard)).toThrow(/folder/);
    expect(() => checkAddable(path.join(dir, "link"), guard)).toThrow(/folder/);
    expect(() => checkAddable(big, guard)).toThrow(/at most 25.0 MB/);
    expect(() => checkAddable(teamFile, guard)).toThrow(/team folder/);
    expect(() => checkAddable(path.join(dir, "sneaky"), guard)).toThrow(/team folder/);
    expect(() => checkAddable(pat, { ...guard, secretFiles: [pat] })).toThrow(/PAT/);
    expect(() => checkAddable(path.join(dir, "missing"), guard)).toThrow(/isn't there/);
    fs.writeFileSync(path.join(dir, "ok.txt"), "fine");
    expect(checkAddable(path.join(dir, "ok.txt"), guard)).toEqual({ real: fs.realpathSync(path.join(dir, "ok.txt")), size: 4 });
  });

  it("hashes into tmp/ and keeps it as a read-only blob, or drops it", async () => {
    const store = new ArtifactStore(tempDir("room"));
    const src = path.join(tempDir("src"), "a.txt");
    fs.writeFileSync(src, "hello world");
    const kept = await store.ingest({ file: src }, "a.txt");
    expect(kept).toMatchObject({ sha256: sha("hello world"), size: 11, sniff: { view: "text" } });
    kept.keep();
    expect(fs.readFileSync(store.blobPath(kept.sha256), "utf8")).toBe("hello world");
    expect(fs.statSync(store.blobPath(kept.sha256)).mode & 0o777).toBe(0o400);
    expect(store.blobs()).toEqual([kept.sha256]);
    const dropped = await store.ingest({ bytes: new Uint8Array(Buffer.from("other")) }, "b.txt");
    dropped.drop();
    expect(store.blobs()).toEqual([kept.sha256]);
    expect(fs.readdirSync(path.join(store.dir, "tmp"))).toEqual([]);
    expect(() => store.blobPath("../../etc/passwd")).toThrow(/content hash/);
    expect(store.knownSniff(kept.sha256, "renamed.md")).toMatchObject({ view: "markdown" });
  });

  it("keeps a finished download only when its hash matches", async () => {
    const store = new ArtifactStore(tempDir("room"));
    const good = Buffer.from("the real bytes");
    store.appendPartial(sha(good), good.subarray(0, 4));
    store.appendPartial(sha(good), good.subarray(4));
    expect(store.partialSize(sha(good))).toBe(good.length);
    expect(await store.completePartial(sha(good), "f.txt")).toBe(true);
    expect(store.blobSize(sha(good))).toBe(good.length);
    const claimed = sha("what it should be");
    store.appendPartial(claimed, Buffer.from("something else"));
    expect(await store.completePartial(claimed, "f.txt")).toBe(false);
    expect(store.blobSize(claimed)).toBeNull();
    expect(store.partialSize(claimed)).toBe(0);
  });

  it("collects what no live artifact uses, and makes quarantined read-only view copies", async () => {
    const store = new ArtifactStore(tempDir("room"));
    const a = await store.ingest({ bytes: new Uint8Array(png(2, 2)) }, "shot");
    a.keep();
    const b = await store.ingest({ bytes: new Uint8Array(Buffer.from("bye")) }, "b.txt");
    b.keep();
    store.appendPartial(sha("partial"), Buffer.from("par"));
    const id = "A".repeat(22);
    const copy = await store.viewCopy(id, a.sha256, "../../evil/shot", a.sniff);
    expect(path.dirname(copy.path)).toBe(path.join(store.dir, "view", id));
    expect(path.basename(copy.path)).toBe(safeArtifactFileName("../../evil/shot", "png"));
    expect(fs.statSync(copy.path).mode & 0o777).toBe(0o444);
    if (process.platform === "darwin") {
      expect(copy.warning).toBeNull();
      expect(execFileSync("xattr", ["-p", "com.apple.quarantine", copy.path], { encoding: "utf8" })).toMatch(/^0081;[0-9a-f]+;Mockingbird;/);
    }
    expect(store.gc(new Set([a.sha256]), new Set())).toEqual([]);
    expect(store.blobs()).toEqual([a.sha256]);
    expect(store.partialSize(sha("partial"))).toBe(0);
    expect(fs.existsSync(path.join(store.dir, "view", id))).toBe(false);
  });

  it("tells inside from outside", () => {
    expect(inside("/a/b", "/a/b/c")).toBe(true);
    expect(inside("/a/b", "/a/b")).toBe(true);
    expect(inside("/a/b", "/a/bc")).toBe(false);
    expect(inside("/a/b", "/a/b/../c")).toBe(false);
    expect(inside("/a/b", "/a/b/..x")).toBe(true);
    expect(inside("/a/b", "/a")).toBe(false);
  });
});
