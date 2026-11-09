# Working on Mockingbird

An Electron app that runs Claude Code and Codex sessions side by side.
`src/main` is the main process (sessions, git, language servers, debuggers,
ADO), `src/renderer` the React interface, `src/shared` types and helpers used
by both, `src/preview` the UI preview's stand-in, `src/peerhost` the hidden
window holding team rooms' WebRTC connections, `signaling` team rooms'
Cloudflare Worker, `test` the Vitest suite.

This is Ryan's personal app: the team's ticket workflow (ticket numbers,
ticket-doc folders, security-considerations docs, promotion gates) doesn't
apply here.

## Check your change

```bash
npm run typecheck
CI=true npm test      # gate commits on its exit code: piping into tail or chaining with ; hides a failure
npm run build
```

Add a test with each fix or feature. Tests run with a throwaway HOME, so they
never touch `~/.mockingbird`, `~/.claude` or `~/.codex`.

Tests leave nothing behind (`test/leaks.ts`): make temp folders inside the
file's HOME (`tempDir()`), or with `scratchDir()` when one must be outside it —
never elsewhere with a bare `mkdtemp`. When a file ends, whatever it started or still runs from its
folders is killed with its process group and fails the file by name; the run
ends by killing and removing whatever is still left in its own folders, and
fails listing it. `MB_E2E_APP=1` runs the two-app tests: a missing Electron
binary is installed first (from `~/Library/Caches/electron`; a worktree with no
node_modules uses the main checkout's), and the run fails, rather than skips,
when it can't be.

## Look at UI changes

```bash
npm run ui-preview    # the real interface on http://localhost:5190, over fixture data; rebuilds on change
npm run ui-preview -- --shot out/shot.png --query "section=about&theme=light"
```

`--shot` renders in headless Chrome and saves a PNG — open it with the Read tool
to see the screen without a browser. `--query` picks it: `tab=dashboard`,
`view=scm` (`explorer`, `search`, `run`: that tool's window; `room`: the Team
view), `section=<Settings section>`, `theme=light`, `lsCamera=x,y,zoom` (else it
fits everything: terminals draw from 0.35, and take the mouse at 1),
`lsSelect=ws:s5`, `lsFocus=s5`, `landscape=fresh` (no `landscape.json` yet: the
migration reads the grid's old prefs in, `shown=s1,s5` among them),
`--size 1400x900`. With the Claude in Chrome extension (`/chrome`), a session
can also open the live preview and click through it.

Screenshots and `?measure` run with motion off; `?motion=full` (or `reduce`)
turns it on. Check animations by their end states — `?motionAudit` and
`test/uiMotion.test.ts` finish every animation with `getAnimations()` and read
what's left — never by frames caught in flight.

Nothing real runs in the preview. When a change adds a main-process call
(`window.mb.*`), add it to `src/preview/stub.ts`; calls it doesn't simulate
answer `{ error }` and are logged in the console and `window.__mbCalls`.

## Leave alone

- Ryan's data: `~/.mockingbird` (use scratch copies for real-data checks), and
  secrets (`.env` files, the ADO PAT under WorkTracker) — never read or print them.
- Ryan's apps and shared databases: ask before running them.
- Real ADO tickets: no comments or edits without Ryan saying so.
- Tests that start Chrome pass `--use-mock-keychain --password-store=basic`
  (otherwise macOS asks about the keychain on Ryan's screen) and skip under CI.

## Ship

Work on a branch; once verified, fast-forward `main` (never force-push), push,
and delete the branch. Ryan installs through the app's own Update, so don't
package or install it. Bump the version only when Ryan asks — Update offers a
build only when the version goes up, so every release that should reach Ryan
or Nick gets a new number (never re-ship an installed version).

Versions follow these rules from 1.5.0 on (`test/changelog.test.ts` enforces
the first and the numbering):
- **Patch** (1.5.1 → 1.5.2): only fixes, polish, wording, performance — no
  "New" item in its changelog entry.
- **Minor** (1.5 → 1.6, patch back to 0): anything new a user can do or see —
  a feature, a new view or UI redesign, an integration.
- **Major** (1.x → 2.0): breaks compatibility — data an older version can't
  read, or a team-room change an older Mockingbird can't talk to. A release
  that needs both teammates to update says so in its notes and is at least a
  minor.
- One step at a time: +1 in exactly one part, lower parts reset to 0.
 Every version bump adds its entry to
`src/shared/changelog.ts` (What's new) in the same commit: what users notice
since the last bump — features, fixes, polish and UI, never docs, tests or
internal changes — one plain line each, most important first, at most about
eight. `test/changelog.test.ts` fails when package.json's version has no
entry. Keep the README roadmap current.

Several sessions can work in this checkout at once: before committing, check
`git status` and `git log`, and commit only the files you changed.
