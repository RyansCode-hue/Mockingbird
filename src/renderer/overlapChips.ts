import type { FileOverlap } from "../shared/types";

/**
 * A pane's overlap chips: one for the worktrees of this Mac (a click jumps to
 * that session), and one per teammate's pushed branch ("Nick's branch also
 * changes x.ts"; a click opens the room's House board, which shows who has
 * which ticket on which branch).
 */
export interface TeammateOverlapChip {
  key: string;
  roomId: string;
  label: string;
  title: string;
}

/** Files a chip's tooltip names per other branch; the rest are counted. */
export const TITLE_FILES = 12;

const base = (f: string) => f.split("/").pop() || f;

/** Indented file lines for a tooltip, at most TITLE_FILES, then how many more. */
function fileLines(files: string[]): string {
  const shown = files.slice(0, TITLE_FILES).map((f) => `  ${f}`);
  if (files.length > TITLE_FILES) shown.push(`  … and ${files.length - TITLE_FILES} more`);
  return shown.join("\n");
}

/** The tooltip of the chip for this Mac's worktrees. */
export function localOverlapTitle(local: FileOverlap[]): string {
  return [
    "Changed here and in another worktree of this repository — a merge conflict waiting to happen:",
    ...local.map((o) => `\n${o.otherTitle}${o.otherBranch ? ` (${o.otherBranch})` : ""}:\n${fileLines(o.files)}`),
    `\nClick to go to ${local.length > 1 ? "the first of those sessions" : "that session"}.`,
  ].join("\n");
}

export function overlapChips(list: FileOverlap[] | undefined): { local: FileOverlap[]; teammates: TeammateOverlapChip[] } {
  const local: FileOverlap[] = [];
  const byMember = new Map<string, { name: string; roomId: string; branches: Map<string, string[]>; uncommitted: Set<string> }>();
  for (const o of list ?? []) {
    if (!o.teammate) {
      local.push(o);
      continue;
    }
    const k = `${o.teammate.roomId}\n${o.teammate.id}`;
    const m = byMember.get(k) ?? { name: o.teammate.name, roomId: o.teammate.roomId, branches: new Map(), uncommitted: new Set<string>() };
    m.branches.set(o.otherBranch ?? o.other, [...new Set([...(m.branches.get(o.otherBranch ?? o.other) ?? []), ...o.files])]);
    for (const f of o.teammate.uncommitted ?? []) m.uncommitted.add(f);
    byMember.set(k, m);
  }
  const teammates = [...byMember].map(([key, m]): TeammateOverlapChip => {
    const files = [...new Set([...m.branches.values()].flat())];
    const more = files.length > 1 ? ` +${files.length - 1}` : "";
    // uncommitted work reached this Mac in the teammate's snapshot: not on their branch yet
    const marked = (fs: string[]) => fs.map((f) => (m.uncommitted.has(f) ? `${f} (uncommitted)` : f));
    const branches = [...m.branches].map(([b, fs]) => `${b}:\n${fileLines(marked(fs))}`);
    const head = m.uncommitted.size
      ? `${m.name}'s work — on ${m.branches.size === 1 ? "their branch" : "their branches"}, or not committed yet — changes files this worktree changes too; talk before one of you merges:`
      : `${m.name}'s pushed ${m.branches.size === 1 ? "branch changes" : "branches change"} files this worktree changes too — talk before one of you merges:`;
    return {
      key,
      roomId: m.roomId,
      label: `${m.name}'s ${m.uncommitted.size ? "work" : "branch"} also changes ${base(files[0] ?? "")}${more}`,
      title: [head, ...branches.map((b) => `\n${b}`), "\nClick to open the room's House board."].join("\n"),
    };
  });
  return { local, teammates };
}
