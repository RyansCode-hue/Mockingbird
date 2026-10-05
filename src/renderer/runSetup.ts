import type { RunProfile } from "../shared/types";

/** The profile without its repo path, which is implied by where it's saved. */
export function stripRepo(p: RunProfile) {
  const { repo: _repo, ...rest } = p;
  return rest;
}

type DraftReply = { profile: RunProfile; raw: string } | { error: string; raw?: string };

/**
 * What the run-setup editor opens with after a draft: the checked profile, or,
 * when the draft didn't validate, the reply itself to fix by hand along with
 * the reason. A draft that failed outright (no `raw`) stays an { error }.
 */
export function draftForEditing(r: DraftReply): { text: string; note: string } | { error: string } {
  if ("profile" in r) return { text: JSON.stringify(stripRepo(r.profile), null, 2), note: "Here's the draft — check the commands and ports, then save." };
  if (typeof r.raw === "string") return { text: pretty(r.raw), note: `The draft needs fixing before it can be saved: ${r.error}` };
  return { error: r.error };
}

/** JSON laid out for editing; anything else as it came. */
function pretty(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
