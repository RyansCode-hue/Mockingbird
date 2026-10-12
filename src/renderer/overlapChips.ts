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

const base = (f: string) => f.split("/").pop() || f;

export function overlapChips(list: FileOverlap[] | undefined): { local: FileOverlap[]; teammates: TeammateOverlapChip[] } {
  const local: FileOverlap[] = [];
  const byMember = new Map<string, { name: string; roomId: string; branches: Map<string, string[]> }>();
  for (const o of list ?? []) {
    if (!o.teammate) {
      local.push(o);
      continue;
    }
    const k = `${o.teammate.roomId}\n${o.teammate.id}`;
    const m = byMember.get(k) ?? { name: o.teammate.name, roomId: o.teammate.roomId, branches: new Map() };
    m.branches.set(o.otherBranch ?? o.other, [...new Set([...(m.branches.get(o.otherBranch ?? o.other) ?? []), ...o.files])]);
    byMember.set(k, m);
  }
  const teammates = [...byMember].map(([key, m]): TeammateOverlapChip => {
    const files = [...new Set([...m.branches.values()].flat())];
    const more = files.length > 1 ? ` +${files.length - 1}` : "";
    const branches = [...m.branches].map(([b, fs]) => `${b}:\n${fs.map((f) => `  ${f}`).join("\n")}`);
    return {
      key,
      roomId: m.roomId,
      label: `${m.name}'s branch also changes ${base(files[0] ?? "")}${more}`,
      title: [`${m.name}'s pushed ${m.branches.size === 1 ? "branch changes" : "branches change"} files this worktree changes too — talk before one of you merges:`, ...branches.map((b) => `\n${b}`), "\nClick to open the room's House board."].join("\n"),
    };
  });
  return { local, teammates };
}
