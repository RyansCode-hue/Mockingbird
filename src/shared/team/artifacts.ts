/**
 * Room artifacts: files and screenshots, notes, repo file references and
 * links kept in a team room (docs/team-rooms.md, "Artifacts"). Their records
 * — names, notes, links, repo references, a file's size and hash — are room
 * events every member keeps; a file's bytes never go in the log: they are
 * content-addressed blobs each member fetches from teammates by hash and
 * verifies before use. Members open them in the Team tab; room agents and
 * @assistant read them through Mockingbird's tools, never the store itself.
 */
import type { MemberId, RoomId } from "./types";

export type ArtifactKind = "file" | "note" | "repo" | "link";

/** A file's bytes at most. */
export const MAX_ARTIFACT_FILE = 25 * 1024 * 1024;
export const MAX_ARTIFACT_NAME = 200;
/** A note's text at most (its whole text is in the log, rewritten on each save). */
export const MAX_NOTE_TEXT = 60_000;
export const MAX_LINK_URL = 2000;
export const MAX_REPO_PATH = 1000;
/** Live artifacts in one room at most; adds beyond it are ignored the same way on every member. */
export const MAX_ARTIFACTS = 500;
/** Artifacts one chat message may refer to. */
export const MAX_ARTIFACT_REFS = 20;
/** Bytes per transfer request between members. */
export const ARTIFACT_CHUNK = 512 * 1024;
/** Files every member fetches without being asked, per room; beyond it they're fetched when opened. */
export const EAGER_ARTIFACT_BYTES = 1024 * 1024 * 1024;

/** An artifact's id: the id of its `artifact.add` event. */
export const ARTIFACT_ID_RE = /^[A-Za-z0-9_-]{22}$/;
export const SHA256_RE = /^[0-9a-f]{64}$/;
export const COMMIT_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Requests between members for a file's bytes. */
export const ARTIFACT_METHODS = { have: "artifact.have", chunk: "artifact.chunk" } as const;
/** Mockingbird's MCP tools that let a room agent list and read the room's artifacts. */
export const ARTIFACT_TOOL = { list: "list_room_artifacts", read: "read_room_artifact" } as const;
/** Where a room agent finds a copy of an artifact it read (inside its own folder, git-excluded). */
export const AGENT_ARTIFACTS_DIR = ".mockingbird/artifacts";

/**
 * What `artifact.add` records, by kind. A file's `mime` is the adder's sniff:
 * advisory only. `wasSecret` is set on a file added from one of the adder's
 * credential stores (~/.aws, ~/.netrc…) and on a copy of a note agents may
 * not read (Save as copy), so it stays unreadable to them whatever it's
 * called; the reducer keeps it, and it can only ever add that restriction.
 */
export type ArtifactAdd =
  | { kind: "file"; name: string; size: number; sha256: string; mime: string; wasSecret?: true }
  | { kind: "note"; name: string; text: string; wasSecret?: true }
  | { kind: "repo"; name: string; origin: string; path: string; commit: string; lines?: [number, number] }
  | { kind: "link"; name: string; url: string };

export interface ArtifactEventBodies {
  "artifact.add": ArtifactAdd;
  /**
   * A rename (any kind) and/or a note's new text. `base` is the revision the
   * text was edited from, required with `text`: an edit from a stale base
   * becomes a copy rather than overwriting someone else's edit.
   */
  "artifact.update": { id: string; name?: string; text?: string; base?: string };
  "artifact.remove": { id: string };
}

declare module "./types" {
  interface RoomEventBodies extends ArtifactEventBodies {}
  interface RoomExtensions {
    artifacts: ArtifactsState;
  }
}

/** An artifact as every member's room state holds it. */
export type ArtifactRecord = ArtifactAdd & {
  id: string;
  addedBy: MemberId;
  addedAt: number;
  lamport: number;
  updatedBy?: MemberId;
  updatedAt?: number;
  /** A note's current revision (the event that last set its text). */
  rev: string;
  /** A note made from an edit that crossed another: the note it was an edit of. */
  conflictOf?: string;
  /** Once named like a secret, it stays unreadable to agents whatever it's renamed to. */
  wasSecret?: true;
};

export interface ArtifactsState {
  items: ArtifactRecord[];
}

// ---- the window's view ----

/** How the viewer shows a file, from its content (never its declared type or extension alone). */
export type ArtifactView = "image" | "pdf" | "markdown" | "csv" | "text" | "binary";

/** A file artifact's bytes on this Mac. */
export type ArtifactLocal =
  | { state: "present"; view: ArtifactView; mime: string }
  | { state: "queued" | "on-demand" }
  | { state: "downloading"; received: number; from: string }
  | { state: "waiting" | "failed"; problem: string };

export interface ArtifactSummary {
  id: string;
  kind: ArtifactKind;
  name: string;
  addedBy: MemberId;
  addedByName: string;
  addedAt: number;
  updatedByName?: string;
  updatedAt?: number;
  /** Why agents can't read it (a secret's name, a private key inside), or null when they can. */
  agentsBlocked: string | null;
  conflictOf?: string;
  // file
  size?: number;
  local?: ArtifactLocal;
  // note
  rev?: string;
  chars?: number;
  // repo
  origin?: string;
  path?: string;
  commit?: string;
  lines?: [number, number];
  // link
  url?: string;
  host?: string;
  /** "ADO #5110", "PR #45": what a link points at, when recognisable. */
  label?: string;
}

/** Something about the room's artifacts worth telling this member once (an edit that crossed theirs). */
export interface ArtifactNotice {
  id: string;
  at: number;
  text: string;
  artifact?: string;
}

export interface RoomArtifactsView {
  roomId: RoomId;
  self: MemberId;
  items: ArtifactSummary[];
  notices: ArtifactNotice[];
  /** Problems worth showing (a store that can't be written, a cleanup that failed). */
  problems: string[];
  /** Why nothing here can be changed (an area's file a newer Mockingbird wrote); absent when it can. */
  readOnly?: string;
}

/** An artifact's content for the viewer. */
export type ArtifactContent =
  | { view: "image"; mime: string; bytes: Uint8Array }
  | { view: "markdown" | "text" | "csv"; text: string; truncated: boolean }
  | { view: "note"; text: string; rev: string }
  | { view: "pdf" | "binary"; mime: string; size: number }
  | { view: "link"; url: string }
  | { view: "missing"; local: ArtifactLocal };

/** Where a repo reference opens on this Mac. */
export interface RepoResolution {
  origin: string;
  path: string;
  commit: string;
  lines: [number, number] | null;
  /** This Mac's clone of `origin`, if any. */
  clone: string | null;
  /** A live session's folder in that clone to open the file in. */
  open: { sessionId: string; root: string; path: string; line: number | null } | null;
  commitPresent: boolean;
  /** Whether the file differs now from the referenced commit; null when it can't be told. */
  changedSince: boolean | null;
  /** The file as it was at the commit. */
  atCommit: { text: string; truncated: boolean } | null;
  problem: string | null;
}

export interface AddRepoRequest {
  sessionId: string;
  /** Relative to the session's folder. */
  path: string;
  lines?: [number, number] | null;
  name?: string;
}

export interface ArtifactAdded {
  id: string;
  name: string;
  warnings: string[];
}

export interface AddFilesResult {
  added: ArtifactAdded[];
  /** Files not added, and why. `needsConfirm: "secret"`: added only when asked again with confirmSecret. */
  refused: { name: string; reason: string; needsConfirm?: "secret" }[];
}

export type SaveNoteMode = "save" | "overwrite" | "copy";
/** A note not added or saved yet: its text holds a private key, so the person is asked, and it's sent again with confirmSecret. */
export interface SecretConfirm {
  needsConfirm: "secret";
  reason: string;
}
export type SaveNoteResult = { rev: string } | { copy: string } | { stale: { rev: string; byName: string; at: number } } | SecretConfirm;

// ---- references in chat ----

/** `#[name](artifact:<id>)`: an artifact named in a chat message. */
export const ARTIFACT_REF_RE = /#\[([^\]\n]{1,120})\]\(artifact:([A-Za-z0-9_-]{22})\)/g;

const withoutCode = (text: string) => text.replace(/```[\s\S]*?(```|$)/g, " ").replace(/`[^`\n]*`/g, " ");

/** The chat text naming artifact `id`, labelled with its name (shortened, without the characters the syntax uses). */
export function artifactRef(id: string, name: string): string {
  const label = name.replace(/[[\]()\n\r]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "artifact";
  return `#[${label}](artifact:${id})`;
}

/** The artifacts a message names, outside code, in order, each once, at most MAX_ARTIFACT_REFS. */
export function parseArtifactRefs(text: string): string[] {
  const ids: string[] = [];
  for (const m of withoutCode(text).matchAll(ARTIFACT_REF_RE)) {
    if (!ids.includes(m[2])) ids.push(m[2]);
    if (ids.length === MAX_ARTIFACT_REFS) break;
  }
  return ids;
}

/**
 * A draft's `#[name]` picks, made canonical before sending: each becomes
 * `#[name](artifact:<id>)`, for the artifact picked under that name in the
 * composer, else the one artifact whose name matches exactly (ignoring case).
 * A name that matches none, or several, stays as typed.
 */
export function encodeArtifactPicks(text: string, picks: ReadonlyMap<string, string>, items: readonly { id: string; name: string }[]): string {
  return text.replace(/#\[([^\]\n]{1,120})\](?!\(artifact:)/g, (whole, name: string) => {
    const picked = picks.get(name);
    const id = picked && items.some((i) => i.id === picked) ? picked : (() => {
      const same = items.filter((i) => i.name.toLowerCase() === name.toLowerCase());
      return same.length === 1 ? same[0].id : null;
    })();
    if (!id) return whole;
    const item = items.find((i) => i.id === id)!;
    return artifactRef(id, item.name);
  });
}

/**
 * A name safe to use as one file name: no path separators, colons or
 * control characters, at most 120 characters keeping the extension (or
 * `ext`), and never empty, "." or "..".
 */
export function safeArtifactFileName(name: string, ext?: string): string {
  let base = name.replace(/[\/\\:\u0000-\u001f\u007f]/g, "_").trim();
  if (!base || base === "." || base === "..") base = "artifact";
  const dot = base.lastIndexOf(".");
  let stem = dot > 0 ? base.slice(0, dot) : base;
  let extension = ext ? `.${ext.replace(/^\./, "")}` : dot > 0 ? base.slice(dot) : "";
  if (extension.length > 16) extension = "";
  stem = stem.slice(0, 120 - extension.length) || "artifact";
  return `${stem}${extension}`;
}

/** A link's host, and a label for what it points at when recognisable (an Azure DevOps work item, a pull request). */
export function linkLabel(url: string): { host: string; label: string | null } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const host = u.hostname;
  const path = u.pathname;
  const workItem = /\/_workitems\/edit\/(\d+)/.exec(path) ?? (/[?&]workitem=(\d+)/i.exec(u.search) as RegExpExecArray | null);
  if (workItem) return { host, label: `ADO #${workItem[1]}` };
  const adoPr = /\/_git\/[^/]+\/pullrequest\/(\d+)/.exec(path);
  if (adoPr) return { host, label: `PR #${adoPr[1]}` };
  const ghPr = host === "github.com" ? /^\/[^/]+\/[^/]+\/pull\/(\d+)/.exec(path) : null;
  if (ghPr) return { host, label: `PR #${ghPr[1]}` };
  const ghIssue = host === "github.com" ? /^\/[^/]+\/[^/]+\/issues\/(\d+)/.exec(path) : null;
  if (ghIssue) return { host, label: `Issue #${ghIssue[1]}` };
  return { host, label: null };
}
