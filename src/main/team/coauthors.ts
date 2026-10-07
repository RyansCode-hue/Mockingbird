import * as fs from "fs";
import * as path from "path";
import { isMissing, writeFileAtomic, writeGenerated } from "../fileOps";
import { TEAM_DIR } from "./identity";
import type { SessionStatus } from "../../shared/types";
import type { MemberId } from "../../shared/team/types";

/**
 * Co-authored-by for room sessions (docs/team-rooms.md, "Commits"): a commit
 * made in a room session during a turn a teammate typed into is authored by
 * the owner, with a `Co-authored-by: <teammate>` trailer.
 *
 * How: a room session starts with GIT_CONFIG_PARAMETERS naming a hooks folder
 * of Mockingbird's (core.hooksPath), inherited by the agent, its tools and
 * any shell in the pane — so it reaches every git the session runs, and no
 * repository's config is touched. Every hook there defers to the
 * repository's own (wherever its core.hooksPath or .git/hooks puts it).
 * prepare-commit-msg (for -m/-F/amend/merge messages) and commit-msg (for
 * editor-written ones) then add one trailer per line of the session's
 * co-author file, which holds the teammates driving the current turn.
 *
 * GIT_CONFIG_PARAMETERS rather than GIT_CONFIG_COUNT/KEY/VALUE: Codex drops
 * variables whose names contain KEY from its tools' environment, and git
 * fails every command that sees a COUNT without its KEY.
 */

export const HOOKS_DIR = path.join(TEAM_DIR, "githooks");
export const COAUTHORS_DIR = path.join(TEAM_DIR, "coauthors");

/** Every hook git runs from a hooks folder (githooks(5)), so a repository's own keep running. */
const HOOK_NAMES = [
  "applypatch-msg", "pre-applypatch", "post-applypatch", "pre-commit", "pre-merge-commit", "prepare-commit-msg", "commit-msg",
  "post-commit", "pre-rebase", "post-checkout", "post-merge", "pre-push", "pre-receive", "update", "proc-receive", "post-receive",
  "post-update", "reference-transaction", "push-to-checkout", "pre-auto-gc", "post-rewrite", "sendemail-validate", "post-index-change",
  "p4-changelist", "p4-prepare-changelist", "p4-post-changelist", "p4-pre-submit",
];

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The hook every name in HOOKS_DIR runs. */
export function hookScript(hooksDir: string, coauthorsDir: string): string {
  return `#!/bin/sh
# Mockingbird team rooms: a room session's git runs its hooks from here.
# Each one runs the repository's own hook of the same name. prepare-commit-msg
# and commit-msg then add a Co-authored-by trailer for each teammate who typed
# into the session's current turn.
name=\${0##*/}
here=${sq(hooksDir)}
own=
hooks=$(env -u GIT_CONFIG_PARAMETERS git rev-parse --git-path hooks 2>/dev/null)
if [ -n "$hooks" ] && [ -f "$hooks/$name" ] && [ -x "$hooks/$name" ] && [ "$(cd "$hooks" 2>/dev/null && pwd -P)" != "$(cd "$here" && pwd -P)" ]; then
  own="$hooks/$name"
fi
case "$name" in
  prepare-commit-msg)
    if [ -n "$own" ]; then "$own" "$@" || exit $?; fi
    # an editor-written message gets its trailers in commit-msg, once it's written
    case "$2" in message|commit|merge|squash) ;; *) exit 0 ;; esac ;;
  commit-msg)
    if [ -n "$own" ]; then "$own" "$@" || exit $?; fi ;;
  *)
    if [ -n "$own" ]; then exec "$own" "$@"; fi
    exit 0 ;;
esac
list=${sq(coauthorsDir)}/"\${MOCKINGBIRD_SESSION:-}"
if [ -z "\${MOCKINGBIRD_SESSION:-}" ] || [ ! -s "$list" ]; then exit 0; fi
# commit-msg runs before git's empty-message check: a trailer must not turn an abandoned message into a commit
if [ -z "$(git stripspace --strip-comments < "$1")" ]; then exit 0; fi
while IFS= read -r who; do
  if [ -n "$who" ]; then
    git interpret-trailers --in-place --if-exists addIfDifferent --trailer "Co-authored-by: $who" "$1" || echo "mockingbird: couldn't add Co-authored-by: $who" >&2
  fi
done < "$list"
exit 0
`;
}

/** Write the hooks folder (when it's missing or from another build). Throws when it can't be written. */
export function ensureHooks(hooksDir = HOOKS_DIR, coauthorsDir = COAUTHORS_DIR): void {
  const script = hookScript(hooksDir, coauthorsDir);
  fs.mkdirSync(coauthorsDir, { recursive: true, mode: 0o700 });
  for (const name of HOOK_NAMES) writeGenerated(path.join(hooksDir, name), script, 0o755);
}

/** The environment that points a session's git at the hooks folder, keeping any GIT_CONFIG_PARAMETERS already set. */
export function hooksEnv(hooksDir = HOOKS_DIR, existing = process.env.GIT_CONFIG_PARAMETERS): Record<string, string> {
  const ours = sq(`core.hooksPath=${hooksDir}`);
  return { GIT_CONFIG_PARAMETERS: existing?.trim() ? `${existing.trim()} ${ours}` : ours };
}

/** A teammate as a trailer names them. */
export interface Coauthor {
  id: MemberId;
  name: string;
  /** Their git email, when their Mockingbird knows it. */
  email: string | null;
}

const EMAIL_RE = /^[^\s<>@]+@[^\s<>@]+$/;

/** "Nick Smith <nick@example.com>", or a handle when the email isn't known. */
export function coauthorLine(c: Coauthor): string {
  const name = c.name.replace(/[\r\n<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100) || "teammate";
  const email = c.email && EMAIL_RE.test(c.email) && c.email.length <= 200 ? c.email : `mockingbird:${c.id.slice(0, 12)}`;
  return `${name} <${email}>`;
}

const inTurn = (s: SessionStatus) => s === "working" || s === "waiting";

/** How long a teammate's typing in a terminal (which has no turns) counts for its commits. */
export const TERMINAL_WINDOW_MS = 10 * 60_000;

/**
 * Who drives each room session's turns, kept in the co-author files the
 * hooks read. Typing before a turn starts counts for that turn (it's the
 * prompt); typing during one (answering a permission prompt) counts for it
 * too. A terminal has no turns: typing there counts for TERMINAL_WINDOW_MS.
 */
export class CoauthorTurns {
  private pending = new Map<string, Map<MemberId, Coauthor>>();
  private turn = new Map<string, Map<MemberId, Coauthor>>();
  private terminal = new Map<string, Map<MemberId, { who: Coauthor; until: number }>>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private dir = COAUTHORS_DIR,
    private o: { now?: () => number; log?: (msg: string, err?: unknown) => void } = {}
  ) {}

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  /** A teammate typed into a session that's `status` now (a terminal: `agent` false). */
  typed(sessionId: string, who: Coauthor, status: SessionStatus, agent: boolean): void {
    if (!agent) {
      const m = this.terminal.get(sessionId) ?? new Map();
      m.set(who.id, { who, until: this.now() + TERMINAL_WINDOW_MS });
      this.terminal.set(sessionId, m);
      this.write(sessionId);
      const t = this.timers.get(sessionId);
      if (t) clearTimeout(t);
      const timer = setTimeout(() => this.write(sessionId), TERMINAL_WINDOW_MS + 1000);
      timer.unref?.();
      this.timers.set(sessionId, timer);
      return;
    }
    const into = inTurn(status) ? this.turn : this.pending;
    const m = into.get(sessionId) ?? new Map();
    const added = !m.has(who.id);
    m.set(who.id, who);
    into.set(sessionId, m);
    if (into === this.turn && added) this.write(sessionId);
  }

  /** A session's status changed. Returns the turn's drivers when this ended a turn. */
  statusChanged(sessionId: string, before: SessionStatus, after: SessionStatus): Coauthor[] | null {
    if (!inTurn(before) && inTurn(after)) {
      this.turn.set(sessionId, this.pending.get(sessionId) ?? new Map());
      this.pending.delete(sessionId);
      this.write(sessionId);
      return null;
    }
    if (inTurn(before) && !inTurn(after)) {
      const drivers = [...(this.turn.get(sessionId)?.values() ?? [])];
      this.turn.delete(sessionId);
      this.write(sessionId);
      return drivers;
    }
    return null;
  }

  /** Who a commit in the session made now would credit. */
  drivers(sessionId: string): Coauthor[] {
    const now = this.now();
    const out = new Map<MemberId, Coauthor>();
    for (const c of this.turn.get(sessionId)?.values() ?? []) out.set(c.id, c);
    for (const [id, t] of this.terminal.get(sessionId) ?? []) if (t.until > now) out.set(id, t.who);
    return [...out.values()];
  }

  /** The session left the room or closed: nothing more is credited. */
  forget(sessionId: string): void {
    this.pending.delete(sessionId);
    this.turn.delete(sessionId);
    this.terminal.delete(sessionId);
    const t = this.timers.get(sessionId);
    if (t) clearTimeout(t);
    this.timers.delete(sessionId);
    this.write(sessionId);
  }

  fileOf(sessionId: string): string {
    return path.join(this.dir, sessionId.replace(/[^\w-]/g, "_"));
  }

  private write(sessionId: string): void {
    const lines = this.drivers(sessionId).map(coauthorLine);
    const file = this.fileOf(sessionId);
    try {
      if (lines.length) writeFileAtomic(file, `${lines.join("\n")}\n`, 0o600);
      else fs.rmSync(file, { force: true });
    } catch (err) {
      if (isMissing(err)) return;
      // a commit would then miss (or keep) a trailer: say so where it's looked for
      (this.o.log ?? ((m, e) => console.error(`[team] ${m}`, e)))(`couldn't update the co-author list for session ${sessionId}`, err);
    }
  }
}
