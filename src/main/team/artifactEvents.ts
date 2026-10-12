import { defineEventType } from "./rooms";
import { originIdentity } from "./roomSessions";
import { hasCredentials } from "../git";
import { isSecretFileName } from "../secrets";
import {
  ARTIFACT_ID_RE,
  COMMIT_RE,
  MAX_ARTIFACT_FILE,
  MAX_ARTIFACT_NAME,
  MAX_ARTIFACTS,
  MAX_LINK_URL,
  MAX_NOTE_TEXT,
  MAX_REPO_PATH,
  SHA256_RE,
  type ArtifactAdd,
  type ArtifactRecord,
  type ArtifactsState,
} from "../../shared/team/artifacts";
import type { RoomEvent, RoomState } from "../../shared/team/types";

/**
 * Room artifacts in the room log (docs/team-rooms.md, "Artifacts"): three
 * events, each checked strictly before it's stored (a malformed or oversized
 * one from a teammate is refused, never kept), and reduced the same way on
 * every member.
 *
 *   artifact.add      a file's record (name, size, hash, the adder's sniffed
 *                     type), a note's text, a repo reference or a link; its
 *                     event id is the artifact's id
 *   artifact.update   a rename, and/or a note's new text edited from `base`
 *   artifact.remove   gone for everyone; anything after it about the id is ignored
 *
 * A note edited from a revision that's no longer current (two members editing
 * at once, or across a partition) doesn't overwrite the other edit: it becomes
 * a new note, "<name> (<author>'s edit)", next to it. Artifacts a member added
 * stay when they leave: they're the room's.
 */

const CONTROL = /[\u0000-\u001f\u007f]/;
const NOTE_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;
const MIME_RE = /^[\w.+-]+\/[\w.+-]+$/;
const MAX_LINE = 10_000_000;

/** Throws unless `v` is an artifact's name: 1–200 characters, trimmed, no control characters. */
export function checkArtifactName(v: unknown): string {
  if (typeof v !== "string" || !v.length || v.length > MAX_ARTIFACT_NAME || v.trim() !== v) throw new Error(`name must be text of 1–${MAX_ARTIFACT_NAME} characters, trimmed`);
  if (CONTROL.test(v)) throw new Error("name has control characters");
  return v;
}

/** Throws unless `v` is a note's text (newlines and tabs, no other control characters). */
export function checkNoteText(v: unknown): string {
  if (typeof v !== "string" || v.length > MAX_NOTE_TEXT) throw new Error(`text must be text of up to ${MAX_NOTE_TEXT} characters`);
  if (NOTE_CONTROL.test(v)) throw new Error("text has control characters");
  return v;
}

/** Throws unless `v` is a path inside a repository: relative, POSIX, no `..`. */
export function checkRepoPath(v: unknown): string {
  if (typeof v !== "string" || !v.length || v.length > MAX_REPO_PATH) throw new Error(`path must be text of 1–${MAX_REPO_PATH} characters`);
  if (v.startsWith("/") || v.includes("\\") || CONTROL.test(v)) throw new Error("path must be relative, with / between folders");
  if (v.split("/").some((seg) => seg === ".." || seg === "")) throw new Error("path must stay inside the repository");
  return v;
}

/** Throws unless `v` is a link a teammate may open: https, no user name or password. */
export function checkLinkUrl(v: unknown): string {
  if (typeof v !== "string" || !v.length || v.length > MAX_LINK_URL) throw new Error(`url must be text of 1–${MAX_LINK_URL} characters`);
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new Error("url isn't a URL");
  }
  if (u.protocol !== "https:") throw new Error("url must be https");
  if (u.username || u.password) throw new Error("url must not carry a user name or password");
  if (CONTROL.test(v)) throw new Error("url has control characters");
  return v;
}

/** Throws unless `v` is a repository's origin as the room log keeps it: its credential-free identity. */
export function checkOrigin(v: unknown): string {
  if (typeof v !== "string" || !v.length || v.length > 500) throw new Error("origin must be text of 1–500 characters");
  if (hasCredentials(v) || originIdentity(v) !== v) throw new Error("origin must be a repository URL without credentials");
  return v;
}

function checkLines(v: unknown): [number, number] {
  if (!Array.isArray(v) || v.length !== 2 || !v.every((n) => Number.isSafeInteger(n))) throw new Error("lines must be [start, end]");
  const [start, end] = v as [number, number];
  if (start < 1 || end < start || end > MAX_LINE) throw new Error(`lines must run from 1 to ${MAX_LINE}, start before end`);
  return [start, end];
}

/** The record an artifact.add makes: only the fields its kind has (anything else in the body is ignored). */
export function checkAdd(b: unknown): ArtifactAdd {
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new Error("no body");
  const x = b as Record<string, unknown>;
  const name = checkArtifactName(x.name);
  if (x.wasSecret !== undefined && (x.wasSecret !== true || (x.kind !== "file" && x.kind !== "note"))) throw new Error("wasSecret, when given, is true, on a file or a note");
  const secret = x.wasSecret === true ? { wasSecret: true as const } : {};
  switch (x.kind) {
    case "file": {
      if (!Number.isSafeInteger(x.size) || (x.size as number) < 0 || (x.size as number) > MAX_ARTIFACT_FILE) throw new Error(`size must be a whole number of bytes up to ${MAX_ARTIFACT_FILE}`);
      if (typeof x.sha256 !== "string" || !SHA256_RE.test(x.sha256)) throw new Error("sha256 must be 64 hex characters");
      if (typeof x.mime !== "string" || x.mime.length > 100 || !MIME_RE.test(x.mime)) throw new Error("mime must be a type/subtype");
      return { kind: "file", name, size: x.size as number, sha256: x.sha256, mime: x.mime, ...secret };
    }
    case "note":
      return { kind: "note", name, text: checkNoteText(x.text), ...secret };
    case "repo": {
      if (typeof x.commit !== "string" || !COMMIT_RE.test(x.commit)) throw new Error("commit must be a full commit id");
      const rec: ArtifactAdd = { kind: "repo", name, origin: checkOrigin(x.origin), path: checkRepoPath(x.path), commit: x.commit };
      if (x.lines !== undefined) rec.lines = checkLines(x.lines);
      return rec;
    }
    case "link":
      return { kind: "link", name, url: checkLinkUrl(x.url) };
    default:
      throw new Error("kind must be file, note, repo or link");
  }
}

export function artifactsOf(state: RoomState): ArtifactsState {
  return (state.ext.artifacts ??= { items: [] });
}

const memberNameIn = (state: RoomState, id: string) => (state.members.find((m) => m.id === id) ?? state.former?.find((m) => m.id === id))?.name ?? id.slice(0, 8);

/** "Spec (Nick's edit)", within the name limit. */
export function conflictName(name: string, author: string): string {
  const tail = ` (${author}'s edit)`.slice(0, 80);
  return `${name.slice(0, MAX_ARTIFACT_NAME - tail.length).trim()}${tail}`;
}

defineEventType("artifact.add", {
  validate: (b) => void checkAdd(b),
  reduce(state, e) {
    const a = artifactsOf(state);
    if (a.items.length >= MAX_ARTIFACTS) return;
    const rec = checkAdd(e.body);
    a.items.push({ ...rec, id: e.id, addedBy: e.author, addedAt: e.at, lamport: e.lamport, rev: e.id, ...(isSecretFileName(rec.name) ? { wasSecret: true as const } : {}) });
  },
});

defineEventType("artifact.update", {
  validate(b: any) {
    if (!b || typeof b !== "object" || Array.isArray(b)) throw new Error("no body");
    if (typeof b.id !== "string" || !ARTIFACT_ID_RE.test(b.id)) throw new Error("bad artifact id");
    if (b.name === undefined && b.text === undefined) throw new Error("an update changes the name or the text");
    if (b.name !== undefined) checkArtifactName(b.name);
    if (b.text !== undefined) {
      checkNoteText(b.text);
      if (typeof b.base !== "string" || !ARTIFACT_ID_RE.test(b.base)) throw new Error("a new text needs the revision it was edited from");
    } else if (b.base !== undefined) throw new Error("base goes with text");
  },
  reduce(state, e) {
    const a = artifactsOf(state);
    const item = a.items.find((x) => x.id === e.body.id);
    if (!item) return;
    let changed = false;
    if (e.body.name !== undefined && e.body.name !== item.name) {
      item.name = e.body.name;
      if (isSecretFileName(item.name)) item.wasSecret = true;
      changed = true;
    }
    if (e.body.text !== undefined && item.kind === "note") {
      if (e.body.base === item.rev) {
        item.text = e.body.text;
        item.rev = e.id;
        changed = true;
      } else if (a.items.length < MAX_ARTIFACTS) {
        // edited from a revision someone else's edit replaced: kept beside it, not over it
        const copy: ArtifactRecord = { kind: "note", name: conflictName(item.name, memberNameIn(state, e.author)), text: e.body.text, id: e.id, addedBy: e.author, addedAt: e.at, lamport: e.lamport, rev: e.id, conflictOf: item.id };
        if (item.wasSecret || isSecretFileName(copy.name)) copy.wasSecret = true;
        a.items.push(copy);
      }
    }
    if (changed) {
      item.updatedBy = e.author;
      item.updatedAt = e.at;
    }
  },
});

defineEventType("artifact.remove", {
  validate(b: any) {
    if (!b || typeof b !== "object" || typeof b.id !== "string" || !ARTIFACT_ID_RE.test(b.id)) throw new Error("bad artifact id");
  },
  reduce(state, e) {
    const a = artifactsOf(state);
    const i = a.items.findIndex((x) => x.id === e.body.id);
    if (i >= 0) a.items.splice(i, 1);
  },
});

/** The room's live artifacts. */
export const artifactItems = (state: RoomState | undefined | null): ArtifactRecord[] => state?.ext.artifacts?.items ?? [];

export type ArtifactEvent = RoomEvent<"artifact.add" | "artifact.update" | "artifact.remove">;
