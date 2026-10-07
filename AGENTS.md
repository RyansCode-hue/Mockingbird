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

## Look at UI changes

```bash
npm run ui-preview    # the real interface on http://localhost:5190, over fixture data; rebuilds on change
npm run ui-preview -- --shot out/shot.png --query "section=about&theme=light"
```

`--shot` renders in headless Chrome and saves a PNG — open it with the Read tool
to see the screen without a browser. `--query` picks it: `tab=dashboard`,
`view=scm` (`explorer`, `search`, `run`), `section=<Settings section>`,
`theme=light`, `shown=s1,s5` (the panes on screen), `--size 1400x900`. With the
Claude in Chrome extension (`/chrome`), a session can also open the live preview
and click through it.

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
build only when the version goes up. Keep the README roadmap current.

Several sessions can work in this checkout at once: before committing, check
`git status` and `git log`, and commit only the files you changed.
