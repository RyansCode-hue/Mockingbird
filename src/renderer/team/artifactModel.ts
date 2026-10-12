import { ago, fileSize } from "../../shared/format";
import { baseName } from "../../shared/paths";
import { splitGroupKey, type SessionInfo } from "../../shared/types";
import { artifactRef, type ArtifactSummary } from "../../shared/team/artifacts";

/**
 * The Team tab's room artifacts as text: each row's meta line, a file's
 * transfer, the `#` completions, CSV parsed for the viewer's table, and the
 * repo-reference form's line range. Pure, so it's tested without a window.
 */

/** The sessions a repo file can be picked from: the focused one when it's in a repo, else the room group's that are. */
export function repoSessionsFor<S extends Pick<SessionInfo, "id" | "repoPath" | "kind" | "taskGroup">>(sessions: S[], focusedSessionId: string | null, groupKey: string | null | undefined): S[] {
  const inRepo = (s: S) => !!s.repoPath && s.kind !== "assistant";
  const focused = sessions.find((s) => s.id === focusedSessionId);
  if (focused && inRepo(focused)) return [focused];
  return sessions.filter((s) => inRepo(s) && !!groupKey && !!s.taskGroup && splitGroupKey(s.taskGroup).top === groupKey);
}

/** "12–40", or "12" for one line. */
export const lineRange = (lines: readonly [number, number]) => (lines[0] === lines[1] ? `${lines[0]}` : `${lines[0]}–${lines[1]}`);

const shortCommit = (commit: string) => commit.slice(0, 7);

/** What a repo reference points at: "src/x.ts:12–40 @ abc1234". */
export const repoTarget = (a: { path?: string; lines?: [number, number]; commit?: string }) =>
  `${a.path ?? ""}${a.lines ? `:${lineRange(a.lines)}` : ""}${a.commit ? ` @ ${shortCommit(a.commit)}` : ""}`;

/**
 * A row's second line: "2.4 MB · Nick · 2h ago" for a file, "Note · edited by
 * Sam · 5m ago", "src/x.ts:12–40 @ abc1234" for a repo file, "dev.azure.com ·
 * ADO #5110" for a link. Your own additions read "you".
 */
export function artifactMeta(a: ArtifactSummary, self: string, now = Date.now()): string {
  const who = (id: string, name: string) => (id === self ? "you" : name);
  const added = `${who(a.addedBy, a.addedByName)} · ${ago(a.addedAt, now)}`;
  switch (a.kind) {
    case "file":
      return `${a.size === undefined ? "File" : fileSize(a.size)} · ${added}`;
    case "note":
      return a.updatedAt && a.updatedByName ? `Note · edited by ${a.updatedByName} · ${ago(a.updatedAt, now)}` : `Note · ${added}`;
    case "repo":
      return repoTarget(a);
    case "link":
      return [a.host ?? a.url ?? "", a.label].filter(Boolean).join(" · ");
  }
}

/** Who added it and when, for a tooltip or the viewer's header. */
export function addedLine(a: ArtifactSummary, self: string, now = Date.now()): string {
  const by = a.addedBy === self ? "you" : a.addedByName;
  const edited = a.updatedAt && a.updatedByName ? `; edited by ${a.updatedByName} ${ago(a.updatedAt, now)}` : "";
  return `Added by ${by} ${ago(a.addedAt, now)}${edited}`;
}

/** A file that isn't on this Mac yet: what's happening to it, and what a click can do about it. */
export function transferLine(a: Pick<ArtifactSummary, "local" | "size">): { text: string; tip?: string; pct?: number; action?: "Download" | "Retry" } | null {
  const l = a.local;
  if (!l || l.state === "present") return null;
  switch (l.state) {
    case "queued":
      return { text: "queued to download" };
    case "on-demand":
      return { text: "not downloaded — fetched when opened", action: "Download" };
    case "downloading": {
      const pct = a.size ? Math.min(100, Math.floor((l.received / a.size) * 100)) : 0;
      return { text: `downloading ${pct}% from ${l.from}`, pct };
    }
    case "waiting":
      return { text: l.problem, tip: l.problem };
    case "failed":
      return { text: l.problem, tip: l.problem, action: "Retry" };
  }
}

/**
 * The label a `#` pick inserts into a draft — the artifact's name as a chat
 * reference shows it (artifactRef's label: no brackets, parentheses or line
 * breaks, at most 80 characters).
 */
export function mentionLabel(name: string): string {
  const ref = artifactRef("", name);
  return ref.slice(2, ref.indexOf("](artifact:"));
}

/** What `#` completes in the composer: a draft's last word after `#`, before the caret. */
export const ARTIFACT_TRIGGER = /(^|\s)#([^\s#[\]]*)$/;

/**
 * The artifacts a `#partial` could mean, best first: names starting with it,
 * then a word in the name starting with it, then names holding it; newest
 * first within each. Nothing when nothing matches, so a ticket number
 * (#5110) doesn't take Enter away from sending.
 */
export function artifactCompletions<T extends Pick<ArtifactSummary, "id" | "name" | "addedAt">>(partial: string, items: readonly T[], limit = 8): T[] {
  const q = partial.toLowerCase();
  const rank = (name: string) => {
    const n = name.toLowerCase();
    if (n.startsWith(q)) return 0;
    if (n.split(/[\s._\-/:]+/).some((w) => w.startsWith(q))) return 1;
    return n.includes(q) ? 2 : -1;
  };
  return items
    .map((item) => ({ item, r: rank(item.name) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || b.item.addedAt - a.item.addedAt)
    .slice(0, limit)
    .map((x) => x.item);
}

/** "12" → one line, "12-40" (or 12–40, 12:40) → a range, "" → none. */
export function parseLines(input: string): { lines: [number, number] | null } | { error: string } {
  const s = input.trim();
  if (!s) return { lines: null };
  const m = /^(\d{1,7})(?:\s*[-–:]\s*(\d{1,7}))?$/.exec(s);
  if (!m) return { error: "Lines are a number or a range, like 12 or 12–40" };
  const a = Number(m[1]);
  const b = m[2] === undefined ? a : Number(m[2]);
  if (a < 1 || b < a) return { error: "A range starts at line 1 or later and ends at or after its start" };
  return { lines: [a, b] };
}

/** A repo reference's default name: the file's name, and the lines when given ("Dropdown.tsx:12–40"). */
export const repoDefaultName = (path: string, lines: [number, number] | null) => `${baseName(path)}${lines ? `:${lineRange(lines)}` : ""}`;

/** The images the viewer shows inline: what main's content sniff names, nothing else. */
export const INLINE_IMAGE_MIME = /^image\/(png|jpeg|gif|webp|bmp|svg\+xml)$/;

/**
 * What removing an artifact does and doesn't do, said before it's removed:
 * the room log is append-only and every member keeps all of it, so a note's
 * text (each saved revision) and every name stay there and reach later
 * joiners; only files' bytes are deleted, on the members who had them.
 */
export const REMOVE_ARTIFACT_NOTE =
  "It's removed for everyone in the room: each member's copy of a file is deleted, agents' copies too, and messages that named it say “(removed)”. " +
  "It isn't taken back: every member's room log keeps its name and, for a note, every saved text, and passes them on to anyone who joins later; " +
  "a copy someone saved with Save as… stays theirs. Any member can remove, rename or edit any artifact.";

export interface CsvTable {
  rows: string[][];
  /** Rows or columns past the limits, not shown. */
  moreRows: boolean;
  moreCols: boolean;
}

/**
 * CSV as rows of cells (RFC 4180: quoted cells hold commas, line breaks and
 * doubled quotes), up to `maxRows` × `maxCols`. A file whose first line has
 * tabs and no commas is read as tab-separated.
 */
export function parseCsv(text: string, maxRows = 1000, maxCols = 50): CsvTable {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.slice(0, src.search(/\r?\n|$/));
  const sep = firstLine.includes("\t") && !firstLine.includes(",") ? "\t" : ",";
  const rows: string[][] = [];
  let moreRows = false;
  let moreCols = false;
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let i = 0;
  const endCell = () => {
    if (row.length < maxCols) row.push(cell);
    else moreCols = true;
    cell = "";
  };
  const endRow = () => {
    endCell();
    rows.push(row);
    row = [];
  };
  while (i < src.length) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"';
        i += 2;
        continue;
      }
      if (c === '"') quoted = false;
      else cell += c;
      i++;
      continue;
    }
    if (c === '"' && cell === "") {
      quoted = true;
      i++;
    } else if (c === sep) {
      endCell();
      i++;
    } else if (c === "\n" || c === "\r") {
      i += c === "\r" && src[i + 1] === "\n" ? 2 : 1;
      if (!row.length && cell === "") continue; // a blank line
      if (rows.length === maxRows) {
        moreRows = true;
        return { rows, moreRows, moreCols };
      }
      endRow();
    } else {
      cell += c;
      i++;
    }
  }
  if (cell !== "" || row.length) {
    if (rows.length === maxRows) moreRows = true;
    else endRow();
  }
  return { rows, moreRows, moreCols };
}
