/**
 * Fuzzy matching for ⌘P's files and the command palette: the query's
 * characters, in order, anywhere in the path or label. A match in the file's
 * name beats one spread over its folders; letters that follow each other, and
 * letters that start a word (after / . _ - or at a camelCase hump), score
 * higher; shorter paths break ties.
 */
export interface FuzzyMatch {
  score: number;
  /** Indexes of the matched characters in the path, for highlighting. */
  positions: number[];
}

const isWordStart = (s: string, i: number) =>
  i === 0 || "/._- ".includes(s[i - 1]) || (s[i] >= "A" && s[i] <= "Z" && s[i - 1] >= "a" && s[i - 1] <= "z");

function matchFrom(q: string, path: string, lower: string, start: number, jump: boolean): FuzzyMatch | null {
  const positions: number[] = [];
  let score = 0;
  let from = start;
  for (const ch of q) {
    let i = lower.indexOf(ch, from);
    if (i < 0) return null;
    // a later occurrence that starts a word beats the first, unless the first continues a run
    if (jump && (positions.length === 0 || i !== positions[positions.length - 1] + 1)) {
      for (let j = i; j >= 0 && j < lower.length; j = lower.indexOf(ch, j + 1)) {
        if (isWordStart(path, j)) {
          i = j;
          break;
        }
      }
    }
    const prev = positions[positions.length - 1];
    if (prev !== undefined && i === prev + 1) score += 6;
    else score -= Math.min(i - from, 12) * 0.4;
    if (isWordStart(path, i)) score += 8;
    positions.push(i);
    from = i + 1;
  }
  return { score, positions };
}

export function fuzzyMatch(query: string, path: string): FuzzyMatch | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return { score: 0, positions: [] };
  const lower = path.toLowerCase();
  const base = path.lastIndexOf("/") + 1;
  const name = lower.slice(base);
  // jumping ahead to word starts can strand later letters; plain left-to-right always finds a match if one exists
  const at = (start: number) => matchFrom(q, path, lower, start, true) ?? matchFrom(q, path, lower, start, false);
  const inName = at(base);
  const m = inName ?? at(0);
  if (!m) return null;
  let score = m.score - path.length * 0.05;
  if (inName) score += 40;
  if (name.startsWith(q)) score += 40;
  else if (name.includes(q)) score += 20;
  return { score, positions: m.positions };
}

/** The best `limit` matches, best first. */
export function fuzzyFilter(query: string, paths: string[], limit = 60): { path: string; positions: number[] }[] {
  const out: { path: string; positions: number[]; score: number }[] = [];
  for (const path of paths) {
    const m = fuzzyMatch(query, path);
    if (m) out.push({ path, positions: m.positions, score: m.score });
  }
  out.sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path));
  return out.slice(0, limit).map(({ path, positions }) => ({ path, positions }));
}

/**
 * The items any of whose texts match `query`, best match first (ties keep
 * their order) — the command palette's actions and sessions. An empty query
 * keeps every item, in order.
 */
export function rankMatches<T>(query: string, items: T[], texts: (item: T) => (string | null | undefined)[]): T[] {
  if (!query.trim()) return items;
  const scored: { item: T; score: number; at: number }[] = [];
  items.forEach((item, at) => {
    let best: number | null = null;
    for (const text of texts(item)) {
      const m = text ? fuzzyMatch(query, text) : null;
      if (m && (best === null || m.score > best)) best = m.score;
    }
    if (best !== null) scored.push({ item, score: best, at });
  });
  return scored.sort((a, b) => b.score - a.score || a.at - b.at).map((s) => s.item);
}
