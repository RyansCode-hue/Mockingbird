# Setting up Mockingbird

Everything you need to go from `git clone` to a working app with your own
Azure DevOps board. Nothing in this repo is account-specific — identity comes
from *your* PAT, so the app becomes yours the moment you point it at your own
config.

## 1. Prerequisites

- **macOS on Apple Silicon** (builds target `arm64`)
- **Node 20+** and npm (`node -v`)
- **Claude Code CLI**, installed and signed in — `claude` must work in your
  terminal. That's the whole integration: Mockingbird launches and manages
  `claude` processes; it never needs an API key of its own.
- Optional: **Azure CLI** (`brew install azure-cli`) — only used by the debrief
  assistant for `az boards` queries.

## 2. Build and run

```bash
git clone https://github.com/RyansCode-hue/Mockingbird.git
cd Mockingbird
npm install
npm start          # dev run
```

To install it as a real app:

```bash
npm run package
cp -R release/mac-arm64/Mockingbird.app /Applications/
```

Launch from /Applications. The build is unsigned — if macOS complains on first
launch, right-click the app → **Open** once. Don't launch the copy inside
`release/` directly: the next `npm run package` wipes that folder.

> `npm install` uses node-pty's prebuilt binaries, so a broken C++ toolchain
> doesn't block you. If node-pty misbehaves after switching Node versions:
> `rm -rf node_modules package-lock.json && npm install`.

## 3. First run

The first launch opens a **setup wizard** (reopen it anytime: ⌘K → *Setup*, or
Settings → *Run setup*). Each step checks this Mac's real state, so it's safe to
re-run and it resumes where you left off:

1. **Agents** — finds `claude` (required) and `codex` (optional) on your PATH and
   whether each is signed in; shows the exact command if not.
2. **Status hooks** — one button adds Mockingbird's hooks for both agents,
   next to any hooks you already have. Codex also asks you to trust them once:
   type `/hooks` in a Codex pane.
3. **Repos** — the folders New Session scans (defaults `~/Code` and
   `~/Personal Projects`, relative to *your* home — add or remove any).
4. **Azure DevOps** (optional) — WorkTracker folder, org URL, project and PAT
   file (see section 4); *Connect* only shows green after a live sign-in check.
5. **Done** — the few shortcuts worth knowing, then straight into New Session.

Nothing in the app is tied to the machine it was built on: every default path is
`~`-relative, and all Azure DevOps details come from your own config.

## 4. Azure DevOps (Dashboard, ticket picker, debrief snapshots)

The app reads ADO config from a folder of your choosing ("WorkTracker folder"
in Settings — any folder works, it just holds config and debrief output):

1. Create a PAT in Azure DevOps: User settings → Personal access tokens →
   New. Scopes: **Work Items (Read & Write)**. Copy the token.
2. Save it to a file **outside any git repo**, e.g.:

   ```bash
   mkdir -p ~/Code/WorkTracker/secrets
   pbpaste > ~/Code/WorkTracker/secrets/ado_pat.txt
   ```

3. In Mockingbird: Settings → **Connectors** → fill in
   - org URL — `https://dev.azure.com/YourOrg`
   - project name
   - PAT file — the path from step 2
   and Save. The card should show *connected as \<you\>*.

The board's "Assigned to" filter, the ticket picker's default, and debrief
snapshots all key off the PAT's owner — no per-user config beyond this. The
PAT never leaves the Electron main process and its path is gitignored-shaped
(`secrets/`, `*_pat.txt`) so it can't be committed by accident.

## 5. Debriefs (optional)

The morning brief / 4pm wrap-up launch an assistant session in your
WorkTracker folder following `instructions/morning.md` / `wrap-up.md` there —
write those however you like. Without them (or without the Azure CLI), the
assistant does what it can and says what it couldn't reach.

## 6. Good to know

- **One instance at a time.** State lives in `~/.mockingbird/state.json`;
  running the dev build and the packaged app together makes them fight over it.
- **After a Claude CLI self-update** ("Update installed · Restart to update"):
  Settings → Updates → **Restart all Claude sessions** relaunches every pane
  in place with `--continue` — conversations, groups, and grid slots survive.
- **Diagnostics**: `~/.mockingbird/pty-audit.log` records any input the app
  refused to forward to a session (this is the tripwire for the class of bug
  where stray bytes type commands into a pane).
- Dev loop: renderer changes are `npm run build` + ⌘R; main-process changes
  need an app restart.
